import SteamUser from 'steam-user';
import type { Runtime } from '../runtime.js';
import type { Flush } from './flush.js';
import { loadCredentials, clearCredentials } from '../storage/credentials.js';
import { showError } from '../ui/display.js';

const RESUME_RETRY_MS = 60_000;
// A reconnect must hold for this long before we announce "▶️ resumed". While the
// player is active on the account, every reconnect is kicked again within
// seconds, so debouncing the notification collapses that flap into a single
// paused/resumed pair instead of one per 60s retry.
const RESUME_NOTIFY_GRACE_MS = 90_000;
// Symmetric grace for the "⏸️ paused" side: a blip that reconnects within this
// window (steam-user's own auto-relogin takes seconds) produces no messages.
const PAUSE_NOTIFY_GRACE_MS = 30_000;
// After a takeover the player is typically active for hours; a logon attempt
// every 60s only gets kicked again and risks a logon rate limit.
const TAKEOVER_RETRY_MS = 5 * 60_000;
const GENERAL_FAILURE_RETRY_LIMIT = 30;
export const RATE_LIMIT_RETRY_LIMIT = 10;
// EResults that auto-resume can never fix — credential-bad, account-level, or
// protocol mismatch. Stop fast and require manual action instead of retrying.
export const TERMINAL_ERESULTS = new Set<number>([
  5, 15, 26, 27, 126, // InvalidPassword, AccessDenied, Revoked, Expired, CachedCredentialInvalid
  17, 43, 51, 69, 73, 95, 114, // Banned, AccountDisabled, Suspended, ParentalControlRestricted, AccountLockedDown, AccountLimitExceeded, AccountDeleted
  7, 119, 120, // InvalidProtocolVer, LauncherMigrated, SteamRealmMismatch
]);
// EResults from logging in too often — back off hard, never hammer (a fast retry
// escalates the Steam lockout from 30min to hours to 24h).
export const RATE_LIMIT_ERESULTS = new Set<number>([84, 87]); // RateLimitExceeded, AccountLoginDeniedThrottle
// Subset of TERMINAL_ERESULTS where the stored refresh token itself is dead;
// delete it so the next interactive start goes straight to a fresh login.
const INVALID_TOKEN_ERESULTS = new Set<number>([5, 15, 26, 27, 126]);
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 15 * 60 * 1000;
export const RATE_LIMIT_BACKOFF_CAP_MS = 30 * 60 * 1000;
// Steam's logon throttle lasts ~30 min and every early retry extends it, so a
// rate-limited wait never starts below this.
export const RATE_LIMIT_MIN_WAIT_MS = 10 * 60 * 1000;
// Delay between tearing down a stuck steam-user connect attempt and our own logOn
const ABORT_SETTLE_MS = 5000;

// "3m" / "2h 05m" for Discord copy
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

// Exponential backoff with full jitter; attempt is 1-based.
export function backoffMs(attempt: number, capMs: number): number {
  const exp = Math.min(capMs, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

// The idle display's 60 s tick, which waiting stops and a resume restarts
export interface DisplayLoop {
  start(): void;
  stop(): void;
}

// Waiting after a disconnect or kick, getting back with the saved token, and
// the debounced paused/resumed notices. Constructed inert: index.ts registers
// the Steam handlers that call in.
export class Resume {
  // True from the moment a pause was announced until the matching resume goes out.
  private pauseNotified = false;
  private pauseEpisodeStart = 0;
  private transientFailureCount = 0;
  private rateLimitCount = 0;

  // Takes the shared runtime, the flush (for takeover drift) and the display loop
  constructor(
    private readonly rt: Runtime,
    private readonly flush: Flush,
    private readonly loop: DisplayLoop
  ) {}

  // Announces a pause once per outage episode: delayed so a blip that reconnects
  // within the grace window stays silent, and never repeated while an announced
  // episode is still flapping (kicked again inside the resume grace).
  private schedulePauseNotification(reason: string): void {
    if (this.pauseNotified || this.rt.timers.has('pauseNotify')) return;
    this.pauseEpisodeStart = Date.now();
    this.rt.timers.timeout('pauseNotify', () => {
      this.pauseNotified = true;
      this.rt.discord.send(`⏸️ Idling paused — ${reason}. Auto-retrying.`);
    }, PAUSE_NOTIFY_GRACE_MS);
  }

  // Closes an announced episode once the reconnect has held for the grace window
  private scheduleResumeNotification(): void {
    if (!this.pauseNotified) return;
    this.rt.timers.timeout('resumeNotify', () => {
      this.pauseNotified = false;
      const downtime = formatDuration(Date.now() - this.pauseEpisodeStart);
      this.rt.discord.send(`▶️ Idling resumed after ${downtime} — ${this.rt.session.idling.length} games`);
    }, RESUME_NOTIFY_GRACE_MS);
  }

  // Freezes elapsed time and arms the resume poller after any disconnect or Steam error
  enterWaiting(reason: string, isTakeover = false): void {
    const rt = this.rt;
    // Our own logOff during shutdown/crash emits 'disconnected' asynchronously;
    // that must not re-arm resume or announce a pause after "stopped".
    if (rt.isWaitingForResume || rt.isShuttingDown) return;
    rt.isWaitingForResume = true;
    rt.waitingReason = reason;
    // If a resume notification is still inside its grace window, the session is
    // flapping: we reconnected and Steam kicked us again because the player is
    // still active. This pause episode was already announced, so cancel the
    // pending resume and stay silent instead of emitting another paused/resumed
    // pair on every retry.
    rt.timers.clear('resumeNotify');
    // While blocked the clocks are already frozen (startTime stale by design);
    // banking again would credit the blocked interval.
    if (!rt.session.blocked) rt.session.bank();
    this.loop.stop();
    // In edit mode the selector owns the screen; enterEditMode re-renders the
    // waiting state once the user leaves the selector.
    if (!rt.isInEditMode) rt.actions.render();
    // A self-initiated relog (flush/zombie recovery) suppresses the pause message;
    // restoreIdling emits a single quiet "🔄 flush" line instead.
    if (!rt.selfInitiatedRelog) this.schedulePauseNotification(reason);
    rt.timers.timeout('resume', () => void this.attemptResume(), isTakeover ? TAKEOVER_RETRY_MS : RESUME_RETRY_MS);
  }

  // Tries to log back in with the saved refresh token; bounded retries for both auth and generic errors
  async attemptResume(): Promise<void> {
    const rt = this.rt;
    if (rt.isShuttingDown) return;

    // steam-user has autoRelogin: true and may have silently reconnected on its
    // own between the disconnect event and this timer firing. Calling logOn
    // again in that state throws "Already logged on" from inside a nextTick
    // async function — an unhandled rejection that crashes the process. Detect
    // it here and just restore.
    if (rt.client.isConnected) {
      this.transientFailureCount = 0;
      this.rateLimitCount = 0;
      this.restoreIdling();
      return;
    }

    // Same trap mid-flight: after a non-fatal disconnect steam-user keeps
    // reconnecting on its own (1s..60s backoff, each attempt several seconds), and
    // logOn while it is connecting throws "Already attempting to log on" the same
    // uncatchable way. Usually its loop ends in loggedOn (→ restoreIdling) or
    // error (→ our next tick logs on), so keep polling for a bounded time.
    if (rt.client.isReconnecting) {
      rt.timers.timeout('resume', () => void this.attemptResume(), RESUME_RETRY_MS);
      return;
    }
    // Past that bound and still mid-connect: steam-user's loop is stuck (CM
    // connect timeouts hold _connecting without ever emitting). Reclaim the
    // connection, then log on next tick: an in-flight CM-list fetch of the
    // aborted attempt only notices the teardown once it resumes, and a logOn in
    // the same tick would let it open a second connection.
    if (rt.client.isConnecting) {
      rt.client.abortPendingConnect();
      rt.timers.timeout('resume', () => void this.attemptResume(), ABORT_SETTLE_MS);
      return;
    }

    const credentials = loadCredentials();
    if (!credentials) {
      showError('No stored credentials — cannot auto-resume');
      rt.discord.send('🛑 Idling stopped — no stored credentials, cannot auto-resume.');
      rt.stopNotified = true;
      rt.actions.shutdown(0);
      return;
    }
    try {
      // Prefer the token the session last ran on: a renewal that failed to
      // persist leaves a dead token on disk.
      const refreshToken = rt.client.currentRefreshToken ?? credentials.refreshToken;
      await rt.client.loginWithRefreshToken(refreshToken, credentials.accountName);
      this.transientFailureCount = 0;
      this.rateLimitCount = 0;
      this.restoreIdling();
    } catch (err) {
      const e = err as Error & { eresult?: number };
      const code = e.eresult;
      const label =
        code !== undefined ? SteamUser.EResult[code] ?? `eresult ${code}` : e.message || 'unknown';

      // A flush relog that does not come back is a real outage, not a quiet
      // flush any more: stop suppressing and announce it like any other pause.
      if (rt.selfInitiatedRelog) {
        rt.selfInitiatedRelog = false;
        this.schedulePauseNotification(`flush relog failed to reconnect (${label})`);
      }

      // Terminal: auto-resume can never fix it (bad credentials, account-level
      // block, or protocol mismatch). Stop cleanly and require manual action.
      // Exit 0 so a systemd unit does not restart-loop a permanent failure.
      if (code !== undefined && TERMINAL_ERESULTS.has(code)) {
        showError(`Resume aborted — ${label} is not auto-recoverable. Manual re-login required.`);
        rt.discord.send(`🛑 Idling stopped — ${label}. Manual re-login required.`);
        rt.stopNotified = true;
        if (INVALID_TOKEN_ERESULTS.has(code)) clearCredentials();
        rt.actions.shutdown(0);
        return;
      }

      // Rate limited: back off hard. A fixed fast retry escalates the Steam
      // lockout (30min → hours → 24h), so this is capped much higher than usual.
      if (code !== undefined && RATE_LIMIT_ERESULTS.has(code)) {
        this.rateLimitCount += 1;
        if (this.rateLimitCount >= RATE_LIMIT_RETRY_LIMIT) {
          showError(`Resume failed after ${RATE_LIMIT_RETRY_LIMIT} rate-limited attempts: ${label}`);
          rt.discord.send(`🛑 Idling stopped — rate-limited ${RATE_LIMIT_RETRY_LIMIT}× (${label}).`);
          rt.stopNotified = true;
          rt.actions.shutdown(1);
          return;
        }
        // A quit while the login was in flight already cleared every timer
        if (rt.isShuttingDown) return;
        rt.timers.timeout(
          'resume',
          () => void this.attemptResume(),
          Math.max(RATE_LIMIT_MIN_WAIT_MS, backoffMs(this.rateLimitCount, RATE_LIMIT_BACKOFF_CAP_MS))
        );
        return;
      }

      // Transient/network: bounded retries with exponential backoff.
      this.transientFailureCount += 1;
      if (this.transientFailureCount >= GENERAL_FAILURE_RETRY_LIMIT) {
        showError(`Resume failed after ${GENERAL_FAILURE_RETRY_LIMIT} attempts: ${label}`);
        rt.discord.send(
          `🛑 Idling stopped — failed to reconnect after ${GENERAL_FAILURE_RETRY_LIMIT}× (last error: ${label}).`
        );
        rt.stopNotified = true;
        rt.actions.shutdown(1);
        return;
      }
      // Likewise: no retry into a shutdown
      if (rt.isShuttingDown) return;
      rt.timers.timeout('resume', () => void this.attemptResume(), backoffMs(this.transientFailureCount, BACKOFF_CAP_MS));
    }
  }

  // Re-establishes the gamesPlayed list and resumes the normal display loop.
  // Idempotent: attemptResume's await and the onLoggedOn auto-relogin callback
  // can race to call this; the guard prevents a duplicate resume (which would
  // orphan the previous interval and send a second "resumed" notification).
  restoreIdling(): void {
    const rt = this.rt;
    if (!rt.isWaitingForResume) return;
    // steam-user's auto-reconnect can land after we already said goodbye (e.g. a
    // flush relog was in flight when the user quit). Leave the session off.
    if (rt.isShuttingDown) {
      rt.client.logout();
      return;
    }
    rt.isWaitingForResume = false;
    rt.waitingReason = '';
    this.transientFailureCount = 0;
    this.rateLimitCount = 0;
    // A fresh session starts unblocked; Steam re-reports a block via playingState
    // right after logon, which handlePlayingState turns into a transition. Games
    // paused by a block before the disconnect must rejoin now: Steam sends no
    // "unblocked" event on logon, and its echo after gamesPlayed is not one either.
    // release() also restarts every idling clock.
    rt.session.release();
    rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));
    if (!rt.isInEditMode) {
      rt.actions.render();
      this.loop.start();
    }

    // A blip that reconnected inside the pause grace was never announced, so
    // there is nothing to resume from either.
    rt.timers.clear('pauseNotify');
    if (rt.selfInitiatedRelog) {
      rt.selfInitiatedRelog = false;
      rt.discord.send('🔄 flush — playtime committed, session refreshed');
    }
    // Debounce: only announce a resume that actually holds. If the player is
    // still active, this reconnect is kicked again within seconds and
    // enterWaiting cancels this timer (see RESUME_NOTIFY_GRACE_MS), so a
    // long play session collapses to a single paused/resumed pair. Also re-arms
    // after a flush relog that landed inside an announced episode.
    this.scheduleResumeNotification();

    this.flush.afterResume();
  }

  // Catches steam-user's silent auto-relogins so we restore idling promptly
  // instead of waiting for the 60s attemptResume tick (which would then race
  // with the now-connected client and crash).
  onLoggedOn(): void {
    if (this.rt.isWaitingForResume) {
      this.rt.timers.clear('resume');
      this.transientFailureCount = 0;
      this.rateLimitCount = 0;
      this.restoreIdling();
    }
  }
}
