import type { Runtime } from '../runtime.js';
import type { Flush } from './flush.js';
import { DEAD_TOKEN_ERESULTS, TERMINAL_ERESULTS, RATE_LIMIT_ERESULTS, eresultLabel } from './eresults.js';
import { loadCredentials, clearCredentials } from '../storage/credentials.js';
import { showError } from '../ui/display.js';

const MINUTE_MS = 60_000;
// First logon attempt after an ordinary drop
const RETRY_AFTER_DROP_MS = MINUTE_MS;
// First attempt after another device took the session. Its player usually goes
// on for hours, and a logon every minute is only kicked again and invites a rate limit.
const RETRY_AFTER_TAKEOVER_MS = 5 * MINUTE_MS;
// "⏸️ paused" goes out only if the session is still down after this, so a
// short drop that steam-user repairs by itself stays silent
const PAUSE_NOTICE_DELAY_MS = 30_000;
// "▶️ resumed" goes out only once the session has held this long. While
// someone plays on the account each reconnect is kicked within seconds; the
// delay turns that whole stretch into one paused/resumed pair.
const RESUME_NOTICE_DELAY_MS = 90_000;
// Ordinary failures: retries, and the backoff range between them
const MAX_FAILURES = 30;
const BACKOFF_FIRST_MS = MINUTE_MS;
const BACKOFF_MAX_MS = 15 * MINUTE_MS;
// Rate limits: fewer retries, longer waits, and never under the floor, since
// Steam's lockout runs about 30 minutes and each early try extends it
export const RATE_LIMIT_RETRY_LIMIT = 10;
export const RATE_LIMIT_BACKOFF_CAP_MS = 30 * MINUTE_MS;
export const RATE_LIMIT_MIN_WAIT_MS = 10 * MINUTE_MS;
// Pause between cancelling a stuck steam-user logon and starting ours
const AFTER_ABORT_MS = 5000;

// A duration as Discord shows it: "3m", or "2h 05m" from an hour up
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// The wait before retry number `attempt` (from 1): doubling from one minute up
// to `capMs`, then a random point in the upper half of that, so restarts on
// several machines do not hit Steam in step
export function backoffMs(attempt: number, capMs: number): number {
  const ceiling = Math.min(capMs, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

// The idling screen's refresh loop, stopped while waiting and restarted on resume
export interface DisplayLoop {
  start(): void;
  stop(): void;
}

// Gets idling back after the session drops or is taken over: freezes the
// clocks, logs on again with the saved token on a backoff, and sends the
// paused/resumed notices, each delayed so that brief or repeated drops do not
// flood Discord. Built inert; the Steam event handlers in start.ts call in.
export class Resume {
  // A "paused" notice went out and no "resumed" has closed it yet
  private pauseAnnounced = false;
  // When the current outage began, for the downtime in the resumed notice
  private outageStartedAt = 0;
  private failures = 0;
  private rateLimits = 0;

  // Takes the shared runtime, the flush (for the takeover report) and the screen's refresh loop
  constructor(
    private readonly rt: Runtime,
    private readonly flush: Flush,
    private readonly loop: DisplayLoop
  ) {}

  // Arms the next logon attempt
  private retryIn(ms: number): void {
    this.rt.timers.timeout('resume', () => void this.attemptResume(), ms);
  }

  // A logon got through: the next failure counts from one again
  private resetFailures(): void {
    this.failures = 0;
    this.rateLimits = 0;
  }

  // Ends the run with a console line, a Discord notice and an exit code
  private giveUp(consoleText: string, discordText: string, exitCode: number): void {
    showError(consoleText);
    this.rt.discord.send(discordText);
    this.rt.stopNotified = true;
    this.rt.actions.shutdown(exitCode);
  }

  // Queues the "paused" notice for this outage. Not when one is queued or
  // already out (a flapping session is one outage), and not after shutdown has
  // cleared the timers (a failed relog can land that late).
  private queuePauseNotice(reason: string): void {
    const rt = this.rt;
    if (rt.isShuttingDown || this.pauseAnnounced || rt.timers.has('pauseNotify')) return;
    this.outageStartedAt = Date.now();
    rt.timers.timeout(
      'pauseNotify',
      () => {
        this.pauseAnnounced = true;
        rt.discord.send(`⏸️ Idling paused — ${reason}. Auto-retrying.`);
      },
      PAUSE_NOTICE_DELAY_MS
    );
  }

  // Queues the "resumed" notice that closes an announced outage
  private queueResumeNotice(): void {
    if (!this.pauseAnnounced) return;
    this.rt.timers.timeout(
      'resumeNotify',
      () => {
        this.pauseAnnounced = false;
        const down = formatDuration(Date.now() - this.outageStartedAt);
        this.rt.discord.send(`▶️ Idling resumed after ${down} — ${this.rt.session.idling.length} games`);
      },
      RESUME_NOTICE_DELAY_MS
    );
  }

  // The session dropped (disconnect, Steam error, takeover): freeze the clocks
  // and start trying to get back
  enterWaiting(reason: string, isTakeover = false): void {
    const rt = this.rt;
    // Our own logOff during a shutdown also arrives as a disconnect, a moment
    // later; it must neither restart the retries nor announce a pause
    if (rt.isWaitingForResume || rt.isShuttingDown) return;
    rt.isWaitingForResume = true;
    rt.waitingReason = reason;
    // A resumed notice still waiting means the session came back and was
    // kicked again: the same outage, already announced, so stay quiet
    rt.timers.clear('resumeNotify');
    // A block has frozen the clocks already; banking now would credit the block
    if (!rt.session.blocked) rt.session.bank();
    this.loop.stop();
    // The picker owns the screen in edit mode and redraws when it closes
    if (!rt.isInEditMode) rt.actions.render();
    // A relog of our own (flush, zombie recovery) is announced by restoreIdling instead
    if (!rt.selfInitiatedRelog) this.queuePauseNotice(reason);
    this.retryIn(isTakeover ? RETRY_AFTER_TAKEOVER_MS : RETRY_AFTER_DROP_MS);
  }

  // One logon attempt with the saved token, and what to do when it fails
  async attemptResume(): Promise<void> {
    const rt = this.rt;
    if (rt.isShuttingDown) return;

    // steam-user may have reconnected by itself since the drop. A logOn now
    // would throw "Already logged on" from a nextTick, crashing the process.
    if (rt.client.isConnected) {
      this.resetFailures();
      this.restoreIdling();
      return;
    }
    // It may also still be reconnecting (its backoff runs 1 to 60 s per try),
    // where logOn throws the same way. That usually ends in a logon or an
    // error, so look again later, for a bounded time.
    if (rt.client.isReconnecting) {
      this.retryIn(RETRY_AFTER_DROP_MS);
      return;
    }
    // Past that bound and still connecting: steam-user is stuck. Cancel its
    // attempt and log on a few seconds later; a CM-list fetch from the cancelled
    // attempt only sees the cancel when it resumes, and an immediate logOn would
    // let it open a second connection.
    if (rt.client.isConnecting) {
      rt.client.abortPendingConnect();
      this.retryIn(AFTER_ABORT_MS);
      return;
    }

    const saved = loadCredentials();
    if (!saved) {
      this.giveUp(
        'No stored credentials — cannot auto-resume',
        '🛑 Idling stopped — no stored credentials, cannot auto-resume.',
        0
      );
      return;
    }
    try {
      // The token the session last ran on wins over the disk copy, which is
      // stale if saving a renewed token failed
      await rt.client.loginWithRefreshToken(rt.client.currentRefreshToken ?? saved.refreshToken, saved.accountName);
      this.resetFailures();
      this.restoreIdling();
    } catch (err) {
      this.handleFailure(err as Error & { eresult?: number });
    }
  }

  // Sorts a failed logon: stop for good, wait out a rate limit, or retry with backoff
  private handleFailure(err: Error & { eresult?: number }): void {
    const rt = this.rt;
    const code = err.eresult;
    const label = eresultLabel(err);

    // A flush relog that cannot get back is a real outage now: announce it
    if (rt.selfInitiatedRelog) {
      rt.selfInitiatedRelog = false;
      this.queuePauseNotice(`flush relog failed to reconnect (${label})`);
    }

    if (code !== undefined && TERMINAL_ERESULTS.has(code)) {
      if (DEAD_TOKEN_ERESULTS.has(code)) clearCredentials();
      // Exit 0: systemd must not restart into the same permanent failure
      this.giveUp(
        `Resume aborted — ${label} is not auto-recoverable. Manual re-login required.`,
        `🛑 Idling stopped — ${label}. Manual re-login required.`,
        0
      );
      return;
    }

    if (code !== undefined && RATE_LIMIT_ERESULTS.has(code)) {
      this.rateLimits += 1;
      if (this.rateLimits >= RATE_LIMIT_RETRY_LIMIT) {
        this.giveUp(
          `Resume failed after ${RATE_LIMIT_RETRY_LIMIT} rate-limited attempts: ${label}`,
          `🛑 Idling stopped — rate-limited ${RATE_LIMIT_RETRY_LIMIT}× (${label}).`,
          1
        );
        return;
      }
      // A quit during the logon has cleared the timers: arm nothing
      if (rt.isShuttingDown) return;
      this.retryIn(Math.max(RATE_LIMIT_MIN_WAIT_MS, backoffMs(this.rateLimits, RATE_LIMIT_BACKOFF_CAP_MS)));
      return;
    }

    this.failures += 1;
    if (this.failures >= MAX_FAILURES) {
      this.giveUp(
        `Resume failed after ${MAX_FAILURES} attempts: ${label}`,
        `🛑 Idling stopped — failed to reconnect after ${MAX_FAILURES}× (last error: ${label}).`,
        1
      );
      return;
    }
    if (rt.isShuttingDown) return;
    this.retryIn(backoffMs(this.failures, BACKOFF_MAX_MS));
  }

  // The session is back: send the games again and restart the clocks and the
  // screen. attemptResume and a steam-user logon can both get here for the
  // same reconnect, so only the first call acts.
  restoreIdling(): void {
    const rt = this.rt;
    if (!rt.isWaitingForResume) return;
    // A reconnect of steam-user's that lands after the goodbye: log it off again
    if (rt.isShuttingDown) {
      rt.client.logout();
      return;
    }
    rt.isWaitingForResume = false;
    rt.waitingReason = '';
    this.resetFailures();
    // A new session starts unblocked, and Steam sends no "unblocked" for it, so
    // games paused by a block before the drop rejoin here (their clocks restart
    // with the rest). A block that still holds is reported again right after logon.
    rt.session.release();
    rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));
    if (!rt.isInEditMode) {
      rt.actions.render();
      this.loop.start();
    }

    // Back inside the pause delay: the outage was never announced
    rt.timers.clear('pauseNotify');
    if (rt.selfInitiatedRelog) {
      rt.selfInitiatedRelog = false;
      rt.discord.send('🔄 flush — playtime committed, session refreshed');
    }
    // Also covers a flush relog that landed inside an announced outage
    this.queueResumeNotice();
    this.flush.afterResume();
  }

  // steam-user logged on by itself while we waited: restore now, instead of
  // letting the pending attempt run into a connected client
  onLoggedOn(): void {
    if (!this.rt.isWaitingForResume) return;
    this.rt.timers.clear('resume');
    this.resetFailures();
    this.restoreIdling();
  }
}
