#!/usr/bin/env node

import * as readline from 'node:readline';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import SteamUser from 'steam-user';
import { SteamClient } from './steam/client.js';
import {
  loginWithQR,
  loginWithCredentials,
  loginWithStoredCredentials,
  hasStoredLogin,
  clearCredentials,
} from './steam/auth.js';
import { promptAuthMethod } from './ui/prompts.js';
import { selectGames } from './ui/gameSelector.js';
import {
  showWelcome,
  showIdlingStatus,
  showLoginSuccess,
  showLoginError,
  showGoodbye,
  showError,
} from './ui/display.js';
import { loadFavorites } from './storage/favorites.js';
import { loadCredentials, saveCredentials } from './storage/credentials.js';
import { DiscordNotifier } from './discord/notifier.js';
import { runDiscordSetup } from './discord/setup.js';
import { CONFIG_PATH as DISCORD_CONFIG_PATH, saveDiscordDisabled } from './discord/config.js';
import { isDiscordLibraryError, startBot } from './discord/bot.js';
import { redactSecrets } from './discord/format.js';
import { StatusPanel } from './discord/statusPanel.js';
import type { PanelGame, StatusSnapshot } from './discord/statusEmbed.js';
import { formatDailyReport } from './notifications/dailyReport.js';
import { MAX_IDLE_GAMES, IS_HEADLESS } from './constants.js';
import { createSpinner } from './ui/spinner.js';
import { installSelection } from './selection.js';
import { createRuntime, isFrozen } from './runtime.js';
import type { ControlPanel, SelectedGameView } from './discord/commands.js';
import type { GameSelection, IdlingGame, LoginResult } from './types/index.js';

const KNOWN_FLAGS = ['--headless', '--setup-discord', '--logout', '--help', '-h', '--version', '-v'];
const args = process.argv.slice(2);
const isSetupDiscord = args.includes('--setup-discord');
const isLogout = args.includes('--logout');
const isHelp = args.includes('--help') || args.includes('-h');
const isVersion = args.includes('--version') || args.includes('-v');
const unknownFlags = args.filter((a) => !KNOWN_FLAGS.includes(a));

const HOURS_MS = 60 * 60 * 1000;
const TAKEOVER_ERESULTS = new Set<number>([6, 34]); // LoggedInElsewhere, LogonSessionReplaced
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
const RATE_LIMIT_RETRY_LIMIT = 10;
// EResults that auto-resume can never fix — credential-bad, account-level, or
// protocol mismatch. Stop fast and require manual action instead of retrying.
const TERMINAL_ERESULTS = new Set<number>([
  5, 15, 26, 27, 126, // InvalidPassword, AccessDenied, Revoked, Expired, CachedCredentialInvalid
  17, 43, 51, 69, 73, 95, 114, // Banned, AccountDisabled, Suspended, ParentalControlRestricted, AccountLockedDown, AccountLimitExceeded, AccountDeleted
  7, 119, 120, // InvalidProtocolVer, LauncherMigrated, SteamRealmMismatch
]);
// EResults from logging in too often — back off hard, never hammer (a fast retry
// escalates the Steam lockout from 30min to hours to 24h).
const RATE_LIMIT_ERESULTS = new Set<number>([84, 87]); // RateLimitExceeded, AccountLoginDeniedThrottle
// Subset of TERMINAL_ERESULTS where the stored refresh token itself is dead;
// delete it so the next interactive start goes straight to a fresh login.
const INVALID_TOKEN_ERESULTS = new Set<number>([5, 15, 26, 27, 126]);
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 15 * 60 * 1000;
const RATE_LIMIT_BACKOFF_CAP_MS = 30 * 60 * 1000;
// Steam's logon throttle lasts ~30 min and every early retry extends it, so a
// rate-limited wait never starts below this.
const RATE_LIMIT_MIN_WAIT_MS = 10 * 60 * 1000;
// Periodic relog to force a playtime commit (clean logOff). Caps worst-case loss
// at this interval instead of the whole session.
const FLUSH_INTERVAL_MS = 4 * HOURS_MS;
// Watchdog that checks server playtime is actually climbing. Must exceed the
// ~30min commit lore to avoid false positives.
const ZOMBIE_CHECK_INTERVAL_MS = 90 * 60 * 1000;
// Grace before exit so a clean logOff socket write (and Discord post) can land.
const CRASH_FLUSH_GRACE_MS = 2000;
// Delay between tearing down a stuck steam-user connect attempt and our own logOn
const ABORT_SETTLE_MS = 5000;
const SHUTDOWN_FLUSH_GRACE_MS = 1500;
const TAKEOVER_DRIFT_DELAY_MS = 120_000;
// Cap on closing the Discord Gateway at exit, so a hung socket never delays it
const BOT_DESTROY_TIMEOUT_MS = 1000;

// The concrete client and notifier stay at hand for login and the bot, which
// need the full types; everything else goes through rt.
const client = new SteamClient();
const discord = new DiscordNotifier();
// Shared context: game state (rt.session), guard flags and timers (rt.timers)
const rt = createRuntime({ client, discord, isHeadless: IS_HEADLESS });
// Lets code outside this file repaint or shut down without importing it
rt.actions = { render: renderStatus, shutdown: handleShutdown };
// True from the moment a pause was announced until the matching resume goes out.
let pauseNotified = false;
let pauseEpisodeStart = 0;
let dayStartAccumulatedMs = new Map<number, number>();
let transientFailureCount = 0;
let rateLimitCount = 0;
// Last successful single-app playtime probe (zombie watchdog). Doubles as the
// "last known good" baseline for post-takeover drift reporting.
let zombieBaseline: { appid: number; playtime: number; at: number } | null = null;
let lastGoodPlaytime: { appid: number; playtime: number } | null = null;
let takeoverDriftPending = false;
// Consecutive zombie checks with flat server playtime (two-strike: the first
// flat reading triggers a flush relog, only a second confirms a real zombie).
let zombieStrike = 0;
// Apps the owned-apps probe returns nothing for (family-shared / unvetted);
// skipped as probe candidates so the watchdog is not silently disabled.
const unprobeableAppIds = new Set<number>();

// "3m" / "2h 05m" for Discord copy
function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

// Announces a pause once per outage episode: delayed so a blip that reconnects
// within the grace window stays silent, and never repeated while an announced
// episode is still flapping (kicked again inside the resume grace).
function schedulePauseNotification(reason: string): void {
  if (pauseNotified || rt.timers.has('pauseNotify')) return;
  pauseEpisodeStart = Date.now();
  rt.timers.timeout('pauseNotify', () => {
    pauseNotified = true;
    rt.discord.send(`⏸️ Idling paused — ${reason}. Auto-retrying.`);
  }, PAUSE_NOTIFY_GRACE_MS);
}

// Closes an announced episode once the reconnect has held for the grace window
function scheduleResumeNotification(): void {
  if (!pauseNotified) return;
  rt.timers.timeout('resumeNotify', () => {
    pauseNotified = false;
    const downtime = formatDuration(Date.now() - pauseEpisodeStart);
    rt.discord.send(`▶️ Idling resumed after ${downtime} — ${rt.session.idling.length} games`);
  }, RESUME_NOTIFY_GRACE_MS);
}

// Renders the status table from current state. Every state change repaints
// through here, so it also asks the Discord status box for a prompt update.
function renderStatus(): void {
  showIdlingStatus(rt.session.idling, rt.session.paused, {
    waitingReason: rt.isWaitingForResume ? rt.waitingReason : null,
    playingBlocked: rt.session.blocked,
    showKeyHints: !rt.isHeadless,
  });
  rt.statusPanel?.nudge();
}

// What the Discord status box shows, computed like the terminal table: no
// live delta while frozen or for games that are not idling. Waiting wins over
// blocked, since a disconnected session cannot be blocked meaningfully.
function statusSnapshot(): StatusSnapshot {
  const now = Date.now();
  const frozen = isFrozen(rt);
  const view = (g: IdlingGame, state: PanelGame['state']): PanelGame => {
    const gainedMs = g.accumulatedMs + (state === 'idling' && !frozen ? now - g.startTime.getTime() : 0);
    return {
      name: g.name,
      state,
      totalMinutes: g.initialPlaytime + Math.floor(gainedMs / 60000),
      gainedMs,
    };
  };
  return {
    state: rt.isShuttingDown ? 'stopped' : rt.isWaitingForResume ? 'waiting' : rt.session.blocked ? 'blocked' : 'idling',
    waitingReason: rt.isWaitingForResume ? rt.waitingReason : null,
    games: [
      ...rt.session.idling.map((g) => view(g, 'idling')),
      ...rt.session.paused.map((g) => view(g, 'paused')),
    ],
  };
}

// (Re)starts the 60s tick that refreshes the table. On a non-TTY
// (systemd/journald) nothing is printed, instead of ~35 lines every minute.
function startDisplayLoop(): void {
  rt.timers.interval('display', () => {
    if (!rt.idlingStartedAt || rt.isInEditMode) return;
    if (process.stdout.isTTY) renderStatus();
  }, 60000);
}

// Stops the 60s tick
function stopDisplayLoop(): void {
  rt.timers.clear('display');
}

// Exponential backoff with full jitter; attempt is 1-based.
function backoffMs(attempt: number, capMs: number): number {
  const exp = Math.min(capMs, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

// Recognises both shapes steam-user may surface a session-takeover as: a numeric
// eresult attached to the error, or the message string itself.
function isTakeoverError(err: Error & { eresult?: number }): boolean {
  if (err.eresult !== undefined && TAKEOVER_ERESULTS.has(err.eresult)) return true;
  return /loggedinelsewhere|logonsessionreplaced/i.test(err.message ?? '');
}

// Freezes elapsed time and arms the resume poller after any disconnect or Steam error
function enterWaitingState(reason: string, isTakeover = false): void {
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
  stopDisplayLoop();
  // In edit mode the selector owns the screen; enterEditMode re-renders the
  // waiting state once the user leaves the selector.
  if (!rt.isInEditMode) renderStatus();
  // A self-initiated relog (flush/zombie recovery) suppresses the pause message;
  // restoreIdling emits a single quiet "🔄 flush" line instead.
  if (!rt.selfInitiatedRelog) schedulePauseNotification(reason);
  rt.timers.timeout('resume', attemptResume, isTakeover ? TAKEOVER_RETRY_MS : RESUME_RETRY_MS);
}

// Tries to log back in with the saved refresh token; bounded retries for both auth and generic errors
async function attemptResume(): Promise<void> {
  if (rt.isShuttingDown) return;

  // steam-user has autoRelogin: true and may have silently reconnected on its
  // own between the disconnect event and this timer firing. Calling logOn
  // again in that state throws "Already logged on" from inside a nextTick
  // async function — an unhandled rejection that crashes the process. Detect
  // it here and just restore.
  if (rt.client.isConnected) {
    transientFailureCount = 0;
    rateLimitCount = 0;
    restoreIdling();
    return;
  }

  // Same trap mid-flight: after a non-fatal disconnect steam-user keeps
  // reconnecting on its own (1s..60s backoff, each attempt several seconds), and
  // logOn while it is connecting throws "Already attempting to log on" the same
  // uncatchable way. Usually its loop ends in loggedOn (→ restoreIdling) or
  // error (→ our next tick logs on), so keep polling for a bounded time.
  if (rt.client.isReconnecting) {
    rt.timers.timeout('resume', attemptResume, RESUME_RETRY_MS);
    return;
  }
  // Past that bound and still mid-connect: steam-user's loop is stuck (CM
  // connect timeouts hold _connecting without ever emitting). Reclaim the
  // connection, then log on next tick: an in-flight CM-list fetch of the
  // aborted attempt only notices the teardown once it resumes, and a logOn in
  // the same tick would let it open a second connection.
  if (rt.client.isConnecting) {
    rt.client.abortPendingConnect();
    rt.timers.timeout('resume', attemptResume, ABORT_SETTLE_MS);
    return;
  }

  const credentials = loadCredentials();
  if (!credentials) {
    showError('No stored credentials — cannot auto-resume');
    rt.discord.send('🛑 Idling stopped — no stored credentials, cannot auto-resume.');
    rt.stopNotified = true;
    handleShutdown(0);
    return;
  }
  try {
    // Prefer the token the session last ran on: a renewal that failed to
    // persist leaves a dead token on disk.
    const refreshToken = rt.client.currentRefreshToken ?? credentials.refreshToken;
    await rt.client.loginWithRefreshToken(refreshToken, credentials.accountName);
    transientFailureCount = 0;
    rateLimitCount = 0;
    restoreIdling();
  } catch (err) {
    const e = err as Error & { eresult?: number };
    const code = e.eresult;
    const label =
      code !== undefined ? SteamUser.EResult[code] ?? `eresult ${code}` : e.message || 'unknown';

    // A flush relog that does not come back is a real outage, not a quiet
    // flush any more: stop suppressing and announce it like any other pause.
    if (rt.selfInitiatedRelog) {
      rt.selfInitiatedRelog = false;
      schedulePauseNotification(`flush relog failed to reconnect (${label})`);
    }

    // Terminal: auto-resume can never fix it (bad credentials, account-level
    // block, or protocol mismatch). Stop cleanly and require manual action.
    // Exit 0 so a systemd unit does not restart-loop a permanent failure.
    if (code !== undefined && TERMINAL_ERESULTS.has(code)) {
      showError(`Resume aborted — ${label} is not auto-recoverable. Manual re-login required.`);
      rt.discord.send(`🛑 Idling stopped — ${label}. Manual re-login required.`);
      rt.stopNotified = true;
      if (INVALID_TOKEN_ERESULTS.has(code)) clearCredentials();
      handleShutdown(0);
      return;
    }

    // Rate limited: back off hard. A fixed fast retry escalates the Steam
    // lockout (30min → hours → 24h), so this is capped much higher than usual.
    if (code !== undefined && RATE_LIMIT_ERESULTS.has(code)) {
      rateLimitCount += 1;
      if (rateLimitCount >= RATE_LIMIT_RETRY_LIMIT) {
        showError(`Resume failed after ${RATE_LIMIT_RETRY_LIMIT} rate-limited attempts: ${label}`);
        rt.discord.send(`🛑 Idling stopped — rate-limited ${RATE_LIMIT_RETRY_LIMIT}× (${label}).`);
        rt.stopNotified = true;
        handleShutdown(1);
        return;
      }
      rt.timers.timeout(
        'resume',
        attemptResume,
        Math.max(RATE_LIMIT_MIN_WAIT_MS, backoffMs(rateLimitCount, RATE_LIMIT_BACKOFF_CAP_MS))
      );
      return;
    }

    // Transient/network: bounded retries with exponential backoff.
    transientFailureCount += 1;
    if (transientFailureCount >= GENERAL_FAILURE_RETRY_LIMIT) {
      showError(`Resume failed after ${GENERAL_FAILURE_RETRY_LIMIT} attempts: ${label}`);
      rt.discord.send(
        `🛑 Idling stopped — failed to reconnect after ${GENERAL_FAILURE_RETRY_LIMIT}× (last error: ${label}).`
      );
      rt.stopNotified = true;
      handleShutdown(1);
      return;
    }
    rt.timers.timeout('resume', attemptResume, backoffMs(transientFailureCount, BACKOFF_CAP_MS));
  }
}

// Re-establishes the gamesPlayed list and resumes the normal display loop.
// Idempotent: attemptResume's await and the onLoggedOn auto-relogin callback
// can race to call this; the guard prevents a duplicate resume (which would
// orphan the previous interval and send a second "resumed" notification).
function restoreIdling(): void {
  if (!rt.isWaitingForResume) return;
  // steam-user's auto-reconnect can land after we already said goodbye (e.g. a
  // flush relog was in flight when the user quit). Leave the session off.
  if (rt.isShuttingDown) {
    rt.client.logout();
    return;
  }
  rt.isWaitingForResume = false;
  rt.waitingReason = '';
  transientFailureCount = 0;
  rateLimitCount = 0;
  // A fresh session starts unblocked; Steam re-reports a block via playingState
  // right after logon, which handlePlayingState turns into a transition. Games
  // paused by a block before the disconnect must rejoin now: Steam sends no
  // "unblocked" event on logon, and its echo after gamesPlayed is not one either.
  // release() also restarts every idling clock.
  rt.session.release();
  rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));
  if (!rt.isInEditMode) {
    renderStatus();
    startDisplayLoop();
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
  // enterWaitingState cancels this timer (see RESUME_NOTIFY_GRACE_MS), so a
  // long play session collapses to a single paused/resumed pair. Also re-arms
  // after a flush relog that landed inside an announced episode.
  scheduleResumeNotification();

  if (takeoverDriftPending) {
    if (lastGoodPlaytime) reportTakeoverDrift(lastGoodPlaytime);
    takeoverDriftPending = false;
  }
}

// One-shot, delayed comparison of the server's committed playtime against the
// last known-good value, to quantify how much of the pre-takeover tail survived.
// Observability only; reuses the zombie watchdog's baseline.
function reportTakeoverDrift(lastGood: { appid: number; playtime: number }): void {
  rt.timers.timeout('takeoverDrift', async () => {
    try {
      const now = await rt.client.getPlaytimeForever(lastGood.appid);
      if (now === null) return;
      const delta = now - lastGood.playtime;
      const name = rt.library.byId.get(lastGood.appid)?.name ?? `App ${lastGood.appid}`;
      const sign = delta >= 0 ? '+' : '';
      rt.discord.send(
        `📊 Post-takeover commit check (${name}): last-known ${lastGood.playtime}m → now ${now}m (Δ${sign}${delta}m).`
      );
    } catch {
      // Best-effort observability — a failed probe is not worth surfacing.
    }
  }, TAKEOVER_DRIFT_DELAY_MS);
}

function msUntilNextMidnight(): number {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime() - Date.now();
}

function scheduleDailyReport(): void {
  rt.timers.timeout('midnight', () => {
    // Fires just after midnight but reports on the day that ended
    const endedDay = new Date();
    endedDay.setDate(endedDay.getDate() - 1);
    const report = formatDailyReport(
      rt.session.idling,
      rt.session.paused,
      dayStartAccumulatedMs,
      endedDay,
      isFrozen(rt)
    );
    rt.discord.send(report);
    snapshotDayStart();
    scheduleDailyReport();
  }, msUntilNextMidnight());
}

// Captures each game's current accumulated playtime for tomorrow's "today gain"
// calculation. Only idling games have a live delta; user-paused
// games are frozen at accumulatedMs (their startTime is stale by design).
function snapshotDayStart(): void {
  dayStartAccumulatedMs.clear();
  const now = Date.now();
  const frozen = isFrozen(rt);
  for (const game of rt.session.idling) {
    const live = frozen
      ? game.accumulatedMs
      : game.accumulatedMs + (now - game.startTime.getTime());
    dayStartAccumulatedMs.set(game.appid, live);
  }
  for (const game of rt.session.paused) {
    dayStartAccumulatedMs.set(game.appid, game.accumulatedMs);
  }
}

// Shared self-initiated relog used by the periodic flush and zombie recovery. A
// clean logOff commits the in-flight idle session; the disconnect→loggedOn
// handlers restore idling and clear the suppression flag. Re-entrant calls
// (flush timer and zombie check firing close together) are ignored: steamID
// stays set until Steam acknowledges the logOff, so isConnected alone is not
// enough to detect a relog already in flight.
function forceFlushRelog(): void {
  if (!rt.client.isConnected || rt.selfInitiatedRelog) return;
  rt.selfInitiatedRelog = true;
  try {
    rt.client.relog();
  } catch {
    rt.selfInitiatedRelog = false;
  }
}

// Mitigation A: periodically force a clean logOff+reconnect so the server folds
// the in-flight idle session into playtime_forever. Caps worst-case loss at
// FLUSH_INTERVAL_MS. Self-reschedules.
function scheduleFlush(): void {
  rt.timers.timeout('flush', () => {
    const idle = !rt.isWaitingForResume && !rt.isInEditMode && !rt.isShuttingDown && !rt.session.blocked;
    if (idle && rt.session.idling.length > 0) {
      forceFlushRelog();
    }
    scheduleFlush();
  }, FLUSH_INTERVAL_MS);
}

// Picks the app to probe: stick with the current baseline app while it is still
// continuously idling, otherwise fall back to the first probeable idling game
// (which forces a re-baseline rather than a false zombie verdict).
function pickProbeApp(): IdlingGame | null {
  if (zombieBaseline) {
    const still = rt.session.idling.find((g) => g.appid === zombieBaseline!.appid);
    if (still) return still;
  }
  return rt.session.idling.find((g) => !unprobeableAppIds.has(g.appid)) ?? null;
}

// Mitigation B: confirm the server's playtime is actually climbing for a
// continuously-idled app. If a full window passes with no increase, commits are
// silently dying (zombie session) → alert + force a relog. Self-reschedules.
async function runZombieCheck(): Promise<void> {
  if (isFrozen(rt) || rt.isInEditMode || rt.isShuttingDown || rt.selfInitiatedRelog || !rt.client.isConnected) {
    return;
  }
  if (rt.session.idling.length === 0) {
    zombieBaseline = null;
    return;
  }

  const probe = pickProbeApp();
  if (!probe) {
    zombieBaseline = null;
    return;
  }

  let playtime: number | null;
  try {
    playtime = await rt.client.getPlaytimeForever(probe.appid);
  } catch {
    return; // transient fetch error — keep the baseline, try again next tick
  }
  // State may have moved while the probe was in flight (disconnect, edit mode,
  // shutdown); a relog must not fire into any of those.
  if (isFrozen(rt) || rt.isInEditMode || rt.isShuttingDown || rt.selfInitiatedRelog || !rt.client.isConnected) {
    return;
  }
  if (playtime === null) {
    // Inconclusive (app absent from the owned-apps response, e.g. family-shared).
    // Remember it so the next tick probes a different game instead of this one
    // forever.
    unprobeableAppIds.add(probe.appid);
    zombieBaseline = null;
    return;
  }

  const now = Date.now();

  if (!zombieBaseline || zombieBaseline.appid !== probe.appid) {
    zombieBaseline = { appid: probe.appid, playtime, at: now };
    lastGoodPlaytime = { appid: probe.appid, playtime };
    zombieStrike = 0;
    return;
  }

  if (playtime > zombieBaseline.playtime) {
    zombieBaseline = { appid: probe.appid, playtime, at: now };
    lastGoodPlaytime = { appid: probe.appid, playtime };
    zombieStrike = 0;
    return;
  }

  // Same app, continuously idling, a full window with no server-side increase.
  if (zombieStrike === 0) {
    // First strike: a healthy session may just be slow to commit. Force a flush
    // relog (which commits) and re-check next window before alarming. Keep the
    // baseline so the next probe compares against the same value.
    zombieStrike = 1;
    forceFlushRelog();
    return;
  }

  // Second strike: a forced relog already failed to produce a commit → real
  // zombie. Alert and force another reconnect, then reset.
  rt.discord.send('⚠️ Zombie session — playtime not committing after a relog. Forcing reconnect.');
  zombieStrike = 0;
  zombieBaseline = null;
  forceFlushRelog();
}

function scheduleZombieCheck(): void {
  rt.timers.timeout('zombie', async () => {
    await runZombieCheck();
    scheduleZombieCheck();
  }, ZOMBIE_CHECK_INTERVAL_MS);
}

// Tells the user once per run when Discord is webhook-only, so a missing bot is never a surprise
function announceWebhookOnly(): void {
  if (rt.discord.isConfigured() && !rt.discord.botConfig()) {
    console.log(
      'Discord: notifications only (webhook). Run --setup-discord to add the bot for /add, /remove and /status.'
    );
  }
}

// Prints CLI usage
function showHelp(): void {
  console.log(`steamidler — Steam game idler CLI and daemon

Usage:
  steamidler                   Interactive mode (login, pick games, idle)
  steamidler --headless        Headless mode: auto-login and idle your favorites
  steamidler --setup-discord   (Re)configure the Discord bot and backup webhook
  steamidler --logout          Forget the saved Steam login
  steamidler --version, -v     Print version
  steamidler --help, -h        Show this help

Config lives in ~/.steam-idler/ (credentials, favorites, discord).`);
}

// Reads the package version at runtime (dist/index.js → ../package.json)
function packageVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('../package.json') as { version: string }).version;
}

// Main entry point that orchestrates the application flow
async function main(): Promise<void> {
  if (isHelp) {
    showHelp();
    process.exit(0);
  }
  if (isVersion) {
    console.log(packageVersion());
    process.exit(0);
  }
  if (unknownFlags.length > 0) {
    showError(`Unknown option: ${unknownFlags.join(' ')}`);
    showHelp();
    process.exit(2);
  }

  if (isLogout) {
    const had = hasStoredLogin();
    clearCredentials();
    console.log(had ? 'Saved Steam login removed.' : 'No saved Steam login to remove.');
    process.exit(0);
  }

  if (isSetupDiscord) {
    try {
      await runDiscordSetup(packageVersion());
      process.exit(0);
    } catch (err) {
      showError((err as Error).message);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => handleShutdown(0));
  process.on('SIGTERM', () => handleShutdown(0));
  // Terminal closed / SSH dropped: still stop playing and log off cleanly
  process.on('SIGHUP', () => handleShutdown(0));
  process.on('uncaughtException', handleCrash);
  process.on('unhandledRejection', handleRejection);

  // Steam renews a refresh token that is close to expiry at logon; the old one
  // is invalid from then on, so persist the new one or the next start fails.
  // The live session keeps running on the in-memory token either way.
  rt.client.onRefreshToken((refreshToken) => {
    const stored = loadCredentials();
    const name = stored?.accountName ?? rt.accountName;
    if (!name) return;
    if (!saveCredentials({ ...stored, accountName: name, refreshToken })) {
      rt.discord.send(
        '⚠️ Steam renewed the login token but it could not be saved — the next restart will need an interactive login.'
      );
    }
  });

  if (rt.isHeadless) {
    await runHeadless();
  } else {
    await runInteractive();
  }

  await new Promise<void>(() => {});
}

// Exit codes for headless start failures. 1 = transient (systemd may restart),
// 2 = configuration problem that a restart cannot fix (README suggests
// RestartPreventExitStatus=2).
const HEADLESS_EXIT_TRANSIENT = 1;
const HEADLESS_EXIT_CONFIG = 2;

// Aborts a headless start: logs off if a session exists, tells Discord why
// (otherwise a systemd unit dies silently), then exits after the flush grace.
async function failHeadless(message: string, exitCode: number): Promise<never> {
  showError(message);
  const sent = rt.discord.send(`🛑 Headless start failed — ${message}`);
  try {
    if (rt.client.isConnected) rt.client.logout();
  } catch {
    // best effort
  }
  const grace = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_GRACE_MS));
  await Promise.all([grace, sent]);
  process.exit(exitCode);
}

// Headless mode: auto-login and start idling favorites
async function runHeadless(): Promise<void> {
  if (!hasStoredLogin()) {
    await failHeadless('No stored login found. Run interactively first to log in.', HEADLESS_EXIT_CONFIG);
  }

  // A rate-limited logon must not exit: systemd would restart in 10s and try
  // again, and every attempt extends Steam's lockout. Wait it out in-process.
  let loginResult = await loginWithStoredCredentials(client);
  let rateLimitedAttempts = 0;
  while (!loginResult.success && loginResult.eresult !== undefined && RATE_LIMIT_ERESULTS.has(loginResult.eresult)) {
    rateLimitedAttempts += 1;
    if (rateLimitedAttempts >= RATE_LIMIT_RETRY_LIMIT) break;
    const waitMs = Math.max(RATE_LIMIT_MIN_WAIT_MS, backoffMs(rateLimitedAttempts, RATE_LIMIT_BACKOFF_CAP_MS));
    console.log(chalk.yellow(`Rate limited by Steam — retrying login in ${formatDuration(waitMs)}.`));
    if (rateLimitedAttempts === 1) rt.discord.send('⏸️ Headless start rate-limited by Steam — waiting before retrying.');
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    loginResult = await loginWithStoredCredentials(client);
  }
  if (!loginResult.success) {
    // A dead token, banned account or protocol mismatch will not change on the
    // next restart; exit 2 so systemd stops instead of logging on every 10s.
    const terminal = loginResult.eresult !== undefined && TERMINAL_ERESULTS.has(loginResult.eresult);
    await failHeadless(
      loginResult.error || 'Unknown error',
      terminal ? HEADLESS_EXIT_CONFIG : HEADLESS_EXIT_TRANSIENT
    );
  }
  rt.accountName = loginResult.accountName!;
  announceWebhookOnly();

  const gamesSpinner = createSpinner('Fetching your game library...').start();
  try {
    rt.library.games = await rt.client.getOwnedGames();
    rt.library.byId = new Map(rt.library.games.map((g) => [g.appid, g]));
    gamesSpinner.succeed(`Found ${rt.library.games.length} games`);
  } catch (err) {
    gamesSpinner.fail('Failed to fetch games');
    await failHeadless((err as Error).message, HEADLESS_EXIT_TRANSIENT);
  }

  const favoriteIds = loadFavorites(rt.accountName);
  if (favoriteIds.length === 0) {
    await failHeadless(
      'No favorites configured. Run interactively first to set favorites.',
      HEADLESS_EXIT_CONFIG
    );
  }

  const matchingGames: GameSelection[] = rt.library.games
    .filter((g) => favoriteIds.includes(g.appid))
    .map((g) => ({ appid: g.appid, name: g.name }));

  if (matchingGames.length === 0) {
    // Family-shared favorites are only visible once license data arrived; a
    // slow PICS at boot must not look like a permanent config error.
    if (!rt.client.ownershipCacheComplete) {
      await failHeadless(
        'No matching games found — library incomplete (license data timed out). Retrying.',
        HEADLESS_EXIT_TRANSIENT
      );
    }
    await failHeadless('No matching games found for your favorites.', HEADLESS_EXIT_CONFIG);
  }

  // A hand-edited or legacy favorites file may hold more than Steam allows;
  // idle the first 32 instead of dying on the gamesPlayed cap.
  const selectedGames = matchingGames.slice(0, MAX_IDLE_GAMES);
  if (matchingGames.length > MAX_IDLE_GAMES) {
    console.log(
      chalk.yellow(
        `${matchingGames.length} favorites exceed the ${MAX_IDLE_GAMES}-game limit — idling the first ${MAX_IDLE_GAMES}.`
      )
    );
  }

  console.log(`Starting ${selectedGames.length} favorite game(s)...`);
  startIdling(selectedGames);
}

// Interactive mode: full UI with prompts and game selector
async function runInteractive(): Promise<void> {
  showWelcome(packageVersion());

  // A failed or timed-out login returns to the method picker instead of killing
  // the process; Ctrl+C at the prompt is the way out.
  let loginResult = await handleLogin();
  while (!loginResult.success) {
    showLoginError(loginResult.error || 'Unknown error');
    loginResult = await handleLogin();
  }

  rt.accountName = loginResult.accountName!;
  showLoginSuccess(rt.accountName);

  if (!rt.discord.hasFile()) {
    const wantsDiscord = await confirm({
      message: 'Configure Discord notifications now? You can do this later with --setup-discord.',
      default: true,
    });
    if (wantsDiscord) {
      try {
        await runDiscordSetup(packageVersion());
      } catch (err) {
        console.log(chalk.yellow(`Discord setup failed: ${(err as Error).message}`));
        console.log(chalk.gray('Continuing without notifications. Run --setup-discord to retry.'));
      }
    } else if (!existsSync(DISCORD_CONFIG_PATH)) {
      // An existing but invalid file is left alone: overwriting it would throw
      // away a token or webhook the user may only need to fix by hand.
      saveDiscordDisabled();
    }
    rt.discord.reload();
  }
  announceWebhookOnly();

  const spinner = createSpinner('Fetching your game library...').start();
  try {
    rt.library.games = await rt.client.getOwnedGames();
    rt.library.byId = new Map(rt.library.games.map((g) => [g.appid, g]));
    spinner.succeed(`Found ${rt.library.games.length} games in your library`);
  } catch (err) {
    spinner.fail('Failed to fetch games');
    showError((err as Error).message);
    process.exit(1);
  }

  if (rt.library.games.length === 0) {
    showError('No games found in your library');
    process.exit(1);
  }

  const { selectedGames, aborted } = await selectGames(
    rt.library.games,
    rt.accountName
  );

  if (aborted) {
    handleShutdown(0);
    return;
  }

  if (selectedGames.length === 0) {
    showError('No games selected');
    handleShutdown(1);
    return;
  }

  startIdling(selectedGames);
}

// Handles authentication method selection and login
async function handleLogin(): Promise<LoginResult> {
  const hasStored = hasStoredLogin();
  const method = await promptAuthMethod(hasStored);

  switch (method) {
    case 'stored':
      return loginWithStoredCredentials(client);
    case 'qr':
      return loginWithQR(client);
    case 'credentials':
      return loginWithCredentials(client);
    default:
      return { success: false, error: 'Invalid login method' };
  }
}

// Sets up raw mode keyboard input handling for edit and quit commands. Headless
// never touches stdin: `steamidler --headless &` from a shell would otherwise
// be stopped by SIGTTOU when setRawMode runs in the background.
function setupKeyboardInput(): void {
  if (rt.isHeadless) return;
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdin.on('keypress', async (str, key) => {
      // Raw mode stays on during the exit grace; nothing may repaint over the goodbye
      if (rt.isShuttingDown) return;
      if (key && key.ctrl && key.name === 'c') {
        handleShutdown();
        return;
      }

      if (rt.isInEditMode) {
        return;
      }

      if (str === 'e' || str === 'E') {
        await enterEditMode();
        return;
      }

      if (str === 'q' || str === 'Q') {
        handleShutdown();
        return;
      }
    });
  }
}

// Handles edit mode for changing game selection while idling
async function enterEditMode(): Promise<void> {
  if (rt.isWaitingForResume) {
    showError('Edit disabled while waiting for resume');
    return;
  }
  rt.isInEditMode = true;

  stopDisplayLoop();
  // Steam keeps crediting while the selector is open (gamesPlayed stays set), so
  // the clock keeps running from here; only a block has it frozen already.
  if (!rt.session.blocked) rt.session.bank();

  console.clear();

  const currentSelection = rt.session.selection();
  const { selectedGames: newSelection, aborted } = await selectGames(rt.library.games, rt.accountName, currentSelection);

  // Ctrl+C inside the selector: the idling-screen key handler already started
  // the graceful shutdown; do not repaint over the goodbye message.
  if (aborted || rt.isShuttingDown) {
    rt.isInEditMode = false;
    handleShutdown(0);
    return;
  }

  if (newSelection.length === 0) {
    showError('No games selected - keeping current selection');
  } else {
    installSelection(rt, forgetDayStart, newSelection);
  }

  // Always re-send on the way out, selection changed or not: an unblock that
  // arrived while the selector was open deferred its re-send to here, and Steam
  // does not restore a blocked session's list on its own.
  if (!rt.isWaitingForResume) {
    rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));
  }

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  rt.isInEditMode = false;

  if (!rt.idlingStartedAt) return;
  renderStatus();
  // A disconnect that landed while the selector was open leaves us waiting:
  // keep the clocks frozen and let restoreIdling restart the loop.
  if (!rt.isWaitingForResume) startDisplayLoop();
}

// Drops the day-start snapshot of games installSelection created
function forgetDayStart(appids: number[]): void {
  for (const appid of appids) dayStartAccumulatedMs.delete(appid);
}

// Applies a changed selection from the Discord commands exactly as edit mode does.
function applyRemoteSelection(newSelection: GameSelection[]): void {
  if (!rt.session.blocked) rt.session.bank();
  installSelection(rt, forgetDayStart, newSelection);
  if (!rt.isWaitingForResume) rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));
  if (!rt.isInEditMode) renderStatus();
}

// What the Discord bot may see and do; startIdling hands it to the bot client.
const controlPanel: ControlPanel = {
  // Reports why a remote change is unsafe right now, or null when it is fine.
  busyReason(): string | null {
    if (rt.isShuttingDown) return 'steamidler is shutting down.';
    if (!rt.idlingStartedAt) return "Idling hasn't started yet.";
    if (rt.isInEditMode) return 'The game selector is open on the PC — try again after closing it.';
    if (rt.isWaitingForResume) {
      return `Disconnected from Steam (${rt.waitingReason}) — try again after it reconnects.`;
    }
    return null;
  },
  // Exposes the disconnect reason, or null while connected.
  waitingReason(): string | null {
    return rt.isWaitingForResume ? rt.waitingReason : null;
  },
  // Lists the owned games the commands may offer.
  library(): { appid: number; name: string }[] {
    return rt.library.games.map((g) => ({ appid: g.appid, name: g.name }));
  },
  // Maps the two internal arrays to the read-only view the bot renders.
  selection(): SelectedGameView[] {
    const view = (g: IdlingGame, state: SelectedGameView['state']): SelectedGameView => ({
      appid: g.appid,
      name: g.name,
      state,
    });
    return [
      ...rt.session.idling.map((g) => view(g, 'idling')),
      ...rt.session.paused.map((g) => view(g, 'paused')),
    ];
  },
  // Adds a library game to the live selection; unknown or already-selected ids,
  // and anything past Steam's 32-game limit, are ignored.
  add(appid: number): void {
    const game = rt.library.byId.get(appid);
    const current = rt.session.selection();
    if (!game || current.some((g) => g.appid === appid) || current.length >= MAX_IDLE_GAMES) return;
    applyRemoteSelection([...current, { appid, name: game.name }]);
  },
  // Drops a game from the live selection; unselected ids are ignored.
  remove(appid: number): void {
    const current = rt.session.selection();
    if (!current.some((g) => g.appid === appid)) return;
    applyRemoteSelection(current.filter((g) => g.appid !== appid));
  },
};

// Handles state changes when another session plays a game on this account.
// Steam blocks this whole session while that happens, so every idling game
// freezes, and the played game (if idled) is shown as paused. Only reacts to
// transitions: Steam also echoes playingState(false, appid) after our own
// gamesPlayed calls, and re-sending on every echo would loop forever.
function handlePlayingState(blocked: boolean, playingApp: number): void {
  // While waiting the clocks are already frozen: no banking, no restart.
  const changed = rt.session.setBlocked(blocked, playingApp, {
    bank: !rt.isWaitingForResume,
    restartClocks: !rt.isWaitingForResume,
  });
  if (!changed) return;

  if (blocked) {
    // Server playtime is flat for the whole block; a baseline from before it
    // would read as a zombie strike on the first probe afterwards.
    zombieBaseline = null;
    zombieStrike = 0;
  }

  // In edit mode the selector owns the screen and enterEditMode re-sends the
  // final list itself; the array changes above still apply.
  if (rt.isInEditMode || rt.isWaitingForResume) return;
  // Steam ignores gamesPlayed while blocked and does not restore the list on
  // its own afterwards: re-send on unblock, or idling silently stays dead until
  // the next change (up to the 4h flush).
  if (!blocked) rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));
  renderStatus();
}

// Initializes the idling session and starts the display loop
function startIdling(games: GameSelection[]): void {
  rt.isIdling = true;
  rt.idlingStartedAt = new Date();

  // Steam reports a block right after logon, before this handler existed.
  rt.session.start(games, rt.library.byId, rt.client.isPlayingBlocked);

  const appIds = games.map((g) => g.appid);
  rt.client.setGamesPlaying(appIds);

  setupKeyboardInput();

  renderStatus();
  startDisplayLoop();

  rt.client.onPlayingState(handlePlayingState);

  rt.client.onDisconnected((eresult, msg) => {
    if (rt.isShuttingDown) return;
    const isTakeover = TAKEOVER_ERESULTS.has(eresult);
    // A kick that lands while our flush relog is in flight is still a takeover:
    // the flush is over either way and the pause must be announced.
    if (isTakeover) rt.selfInitiatedRelog = false;
    if (isTakeover && lastGoodPlaytime) takeoverDriftPending = true;
    const reason = rt.selfInitiatedRelog
      ? 'flushing playtime (scheduled relog)'
      : isTakeover
      ? 'player active on this account elsewhere'
      : `disconnected (${msg}, eresult ${eresult})`;
    if (!rt.isInEditMode && !rt.selfInitiatedRelog) {
      console.log(`\nDisconnected from Steam: ${msg} (${eresult})`);
    }
    enterWaitingState(reason, isTakeover);
  });

  rt.client.onError((err) => {
    if (rt.isShuttingDown) return;
    const isTakeover = isTakeoverError(err);
    if (isTakeover) rt.selfInitiatedRelog = false;
    if (isTakeover && lastGoodPlaytime) takeoverDriftPending = true;
    const reason = isTakeover
      ? 'player active on this account elsewhere'
      : `Steam error: ${err.message}`;
    if (!rt.isInEditMode) console.log(`\nSteam error: ${err.message}`);
    enterWaitingState(reason, isTakeover);
  });

  // Catches steam-user's silent auto-relogins so we restore idling promptly
  // instead of waiting for the 60s attemptResume tick (which would then race
  // with the now-connected client and crash).
  rt.client.onLoggedOn(() => {
    if (rt.isWaitingForResume) {
      rt.timers.clear('resume');
      transientFailureCount = 0;
      rateLimitCount = 0;
      restoreIdling();
    }
  });

  snapshotDayStart();
  scheduleDailyReport();
  scheduleFlush();
  scheduleZombieCheck();

  rt.discord.send(`▶️ Idling started — ${rt.session.idling.length} games`);

  // The bot connects only once idling has started, so a --setup-discord run or
  // a session still at the selector never answers commands for this account.
  const botConfig = rt.discord.botConfig();
  if (botConfig) rt.botHandle = startBot(botConfig, controlPanel, discord);
  // The status box goes live with idling too; it talks REST, so it keeps
  // updating while the Gateway reconnects
  const statusChannelId = botConfig?.statusChannelId;
  if (botConfig && statusChannelId && !rt.statusPanel) {
    rt.statusPanel = new StatusPanel({ ...botConfig, statusChannelId }, statusSnapshot, { version: packageVersion() });
    rt.statusPanel.start();
  }

  // A kick or drop between login and here (e.g. while the selector was open)
  // had no handler yet; without this the screen would say "Idling" forever
  // while nothing is played and no resume is ever attempted.
  if (!rt.client.isConnected) {
    enterWaitingState('disconnected before idling started');
  }
}

// Graceful shutdown handler that saves state and logs out. exitCode lets the
// auto-resume give-up paths signal a restartable failure (1) vs a clean stop (0).
function handleShutdown(exitCode = 0): void {
  if (rt.isShuttingDown) return;
  rt.isShuttingDown = true;
  console.log('\n');

  rt.timers.clearAll();

  // Best effort: a throw here must not skip the exit timer below.
  try {
    if (rt.isIdling) {
      rt.client.stopPlaying();
      rt.isIdling = false;
    }
    if (rt.client.isLoggedIn || rt.client.isConnected) {
      rt.client.logout();
    }
  } catch (err) {
    console.error('Logout failed:', (err as Error).message);
  }

  // Fallback "quit by user" only fires when idling had started and no give-up
  // path already sent a stop message
  const finalMessage =
    !rt.stopNotified && rt.idlingStartedAt ? rt.discord.send('🛑 Idling stopped — quit by user') : Promise.resolve();

  // The status box turns red; stop() never rejects and is capped at 4s
  const panelStopped = rt.statusPanel ? rt.statusPanel.stop() : Promise.resolve();

  showGoodbye();
  // Grace so the clean logOff socket write (the playtime-commit trigger) can
  // land, and the final Discord post (own 5s timeout) gets to finish.
  const grace = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_GRACE_MS));
  void Promise.all([grace, finalMessage, panelStopped])
    .then(() => stopBot())
    .then(() => process.exit(exitCode));
}

// Closes the Gateway after the final notification went out. Never rejects and
// is time-capped, so both exit paths always reach process.exit.
function stopBot(): Promise<void> {
  if (!rt.botHandle) return Promise.resolve();
  const cap = new Promise<void>((resolve) => setTimeout(resolve, BOT_DESTROY_TIMEOUT_MS));
  return Promise.race([rt.botHandle.destroy().catch(() => {}), cap]);
}

// Secrets that error text must never carry to the console or Discord
function discordSecrets(): string[] {
  const token = rt.discord.botConfig()?.token;
  return token ? [token] : [];
}

// Discord stays optional: a rejection from inside the Discord libraries is
// logged and idling carries on; any other rejection is a real crash.
function handleRejection(reason: unknown): void {
  if (isDiscordLibraryError(reason)) {
    const error = reason as Error;
    console.error(`[discord] ignored a library error: ${redactSecrets(error.stack ?? error.message, discordSecrets())}`);
    return;
  }
  handleCrash(reason);
}

// Mitigation C: last-resort flush on a fatal error. Best-effort stop+logout to
// salvage the in-flight session's playtime tail before exiting.
function handleCrash(err: unknown): void {
  if (rt.isShuttingDown) return;
  rt.isShuttingDown = true;
  // Stack text only: logging the whole object would print library-attached
  // fields such as a Discord request URL, which can embed an interaction token.
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error('\nFatal error:', redactSecrets(detail, discordSecrets()));

  rt.timers.clearAll();

  try {
    if (rt.isIdling) rt.client.stopPlaying();
  } catch {
    // ignore — best effort
  }
  try {
    if (rt.client.isLoggedIn || rt.client.isConnected) rt.client.logout();
  } catch {
    // ignore — best effort
  }

  // Redacted like the console copy: this text goes to Discord
  const message = redactSecrets(err instanceof Error ? err.message : String(err), discordSecrets());
  const finalMessage = rt.stopNotified
    ? Promise.resolve()
    : rt.discord.send(
        rt.idlingStartedAt
          ? `🛑 Idling stopped — crashed (${message}).`
          : `🛑 steamidler crashed before idling started (${message}).`
      );

  const panelStopped = rt.statusPanel ? rt.statusPanel.stop() : Promise.resolve();
  const grace = new Promise((resolve) => setTimeout(resolve, CRASH_FLUSH_GRACE_MS));
  void Promise.all([grace, finalMessage, panelStopped])
    .then(() => stopBot())
    .then(() => process.exit(1));
}

main().catch((err: Error) => {
  // Ctrl+C inside an inquirer prompt (raw mode, so no SIGINT) rejects with
  // ExitPromptError — a normal exit, not an error to print.
  if (err.name === 'ExitPromptError') {
    showGoodbye();
    process.exit(0);
  }
  showError(redactSecrets(err.message, discordSecrets()));
  process.exit(1);
});
