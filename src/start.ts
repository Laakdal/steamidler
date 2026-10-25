import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { SteamClient } from './steam/client.js';
import {
  loginWithQR,
  loginWithCredentials,
  loginWithStoredCredentials,
  hasStoredLogin,
} from './steam/auth.js';
import { promptAuthMethod } from './ui/prompts.js';
import { selectGames } from './ui/gameSelector.js';
import { showWelcome, showLoginSuccess, showLoginError, showError } from './ui/display.js';
import { loadSelection } from './storage/selection.js';
import type { DiscordNotifier } from './discord/notifier.js';
import { runDiscordSetup } from './discord/setup.js';
import { CONFIG_PATH as DISCORD_CONFIG_PATH, saveDiscordDisabled } from './discord/config.js';
import { startBot } from './discord/bot.js';
import { StatusPanel } from './discord/statusPanel.js';
import { statusSnapshot } from './discord/controlPanel.js';
import type { ControlPanel } from './discord/commands.js';
import type { DailyReport } from './notifications/dailyReport.js';
import { createSpinner } from './ui/spinner.js';
import type { StatusView } from './ui/statusView.js';
import { setupKeyboardInput } from './ui/keyboard.js';
import type { Runtime } from './runtime.js';
import { type createShutdown, SHUTDOWN_FLUSH_GRACE_MS } from './shutdown.js';
import type { Flush } from './steam/flush.js';
import {
  type Resume,
  formatDuration,
  backoffMs,
  TERMINAL_ERESULTS,
  RATE_LIMIT_ERESULTS,
  RATE_LIMIT_RETRY_LIMIT,
  RATE_LIMIT_BACKOFF_CAP_MS,
  RATE_LIMIT_MIN_WAIT_MS,
} from './steam/resume.js';
import type { GameSelection, LoginResult } from './types/index.js';

// Every module the start paths drive, built once by the wiring in index.ts.
// The concrete client and notifier are here as well as in rt because login
// and the bot need the full types.
export interface App {
  rt: Runtime;
  client: SteamClient;
  discord: DiscordNotifier;
  view: StatusView;
  report: DailyReport;
  flush: Flush;
  resume: Resume;
  shutdown: ReturnType<typeof createShutdown>;
  editMode: () => Promise<void>;
  // What the Discord bot may see and do; startIdling hands it to the bot client
  controlPanel: ControlPanel;
  // Registers the signal and process handlers; main calls it only once a
  // CLI-only flag (help, version, logout, setup-discord) is ruled out
  installHandlers: () => void;
}

const TAKEOVER_ERESULTS = new Set<number>([6, 34]); // LoggedInElsewhere, LogonSessionReplaced

// Recognises both shapes steam-user may surface a session-takeover as: a numeric
// eresult attached to the error, or the message string itself.
function isTakeoverError(err: Error & { eresult?: number }): boolean {
  if (err.eresult !== undefined && TAKEOVER_ERESULTS.has(err.eresult)) return true;
  return /loggedinelsewhere|logonsessionreplaced/i.test(err.message ?? '');
}

// Tells the user once per run when Discord is webhook-only, so a missing bot is never a surprise
function announceWebhookOnly(rt: Runtime): void {
  if (rt.discord.isConfigured() && !rt.discord.botConfig()) {
    console.log(
      'Discord: notifications only (webhook). Run --setup-discord to add the bot for /add, /remove and /status.'
    );
  }
}

// Reads the package version at runtime (dist/start.js → ../package.json)
export function packageVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('../package.json') as { version: string }).version;
}

// Exit codes for headless start failures. 1 = transient (systemd may restart),
// 2 = configuration problem that a restart cannot fix (README suggests
// RestartPreventExitStatus=2).
const HEADLESS_EXIT_TRANSIENT = 1;
const HEADLESS_EXIT_CONFIG = 2;

// Aborts a headless start: logs off if a session exists, tells Discord why
// (otherwise a systemd unit dies silently), then exits after the flush grace.
async function failHeadless(rt: Runtime, message: string, exitCode: number): Promise<never> {
  showError(message);
  const sent = rt.discord.send(`🛑 Headless start failed — ${message}`);
  try {
    if (rt.client.isConnected) rt.client.logout();
  } catch {
    // best effort
  }
  const grace = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_GRACE_MS));
  await Promise.all([grace, sent]);
  rt.exit(exitCode);
  // rt.exit does not return (a test's stub throws); this only ends the flow if it did
  throw new Error(`exit ${exitCode} returned`);
}

// The saved selection, or the favorites it migrates from, with library names
// for the games found: a migration has only placeholders, and the library name
// is the current one. Missing games keep their saved name for the log line.
// null when there is none; an empty list counts as none.
function loadStartSelection(rt: Runtime): { games: GameSelection[]; migrated: boolean } | null {
  const loaded = loadSelection(rt.accountName);
  if (!loaded || loaded.games.length === 0) return null;
  const games = loaded.games.map((g) => {
    const steamGame = rt.library.byId.get(g.appid);
    return steamGame ? { appid: g.appid, name: steamGame.name } : g;
  });
  return { games, migrated: loaded.source === 'favorites' };
}

// Names the saved games not in the library at start: they stay in the
// selection (family sharing late or withdrawn), so the owner should know why
// they are not idling.
function announceMissing(rt: Runtime, games: GameSelection[]): void {
  const missing = games.filter((g) => !rt.library.byId.has(g.appid));
  if (missing.length === 0) return;
  console.log(
    chalk.yellow(
      `Saved but not in your library right now: ${missing.map((g) => g.name).join(', ')}; kept, retried at the next start.`
    )
  );
}

// Headless mode: auto-login and start idling the saved selection
export async function runHeadless(app: App): Promise<void> {
  const { rt, client } = app;
  if (!hasStoredLogin()) {
    await failHeadless(rt, 'No stored login found. Run interactively first to log in.', HEADLESS_EXIT_CONFIG);
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
      rt,
      loginResult.error || 'Unknown error',
      terminal ? HEADLESS_EXIT_CONFIG : HEADLESS_EXIT_TRANSIENT
    );
  }
  rt.accountName = loginResult.accountName!;
  announceWebhookOnly(rt);

  const gamesSpinner = createSpinner('Fetching your game library...').start();
  try {
    rt.library.games = await rt.client.getOwnedGames();
    rt.library.byId = new Map(rt.library.games.map((g) => [g.appid, g]));
    gamesSpinner.succeed(`Found ${rt.library.games.length} games`);
  } catch (err) {
    gamesSpinner.fail('Failed to fetch games');
    await failHeadless(rt, (err as Error).message, HEADLESS_EXIT_TRANSIENT);
  }

  const saved = loadStartSelection(rt);
  if (!saved) {
    return failHeadless(rt, 'No games selected. Run steamidler interactively once to pick games.', HEADLESS_EXIT_CONFIG);
  }

  const inLibrary = saved.games.filter((g) => rt.library.byId.has(g.appid));
  if (inLibrary.length === 0) {
    // Family-shared games are only visible once license data arrived; a slow
    // PICS at boot must not look like a permanent config error. Either way the
    // selection file is left as it is.
    if (!rt.client.ownershipCacheComplete) {
      return failHeadless(
        rt,
        'No matching games found — library incomplete (license data timed out). Retrying.',
        HEADLESS_EXIT_TRANSIENT
      );
    }
    return failHeadless(rt, `None of your ${saved.games.length} saved games are in your library.`, HEADLESS_EXIT_CONFIG);
  }
  announceMissing(rt, saved.games);

  console.log(`Starting ${inLibrary.length} saved game(s)...`);
  startIdling(app, saved.games);
  // A migration writes the selection file at once, so the next start reads it
  // instead of the favorites. A start from the saved file has nothing new to write.
  if (saved.migrated) rt.actions.saveSelection();
}

// Interactive mode: full UI with prompts and game selector
export async function runInteractive(app: App): Promise<void> {
  const { rt, client } = app;
  showWelcome(packageVersion());

  // A failed or timed-out login returns to the method picker instead of killing
  // the process; Ctrl+C at the prompt is the way out.
  let loginResult = await handleLogin(client);
  while (!loginResult.success) {
    showLoginError(loginResult.error || 'Unknown error');
    loginResult = await handleLogin(client);
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
  announceWebhookOnly(rt);

  await pickAndStart(app);
}

// Fetches the library, opens the picker on the saved selection and starts
// idling what it returns. Split from runInteractive so it runs offline without
// a login.
export async function pickAndStart(app: App): Promise<void> {
  const { rt } = app;
  const spinner = createSpinner('Fetching your game library...').start();
  try {
    rt.library.games = await rt.client.getOwnedGames();
    rt.library.byId = new Map(rt.library.games.map((g) => [g.appid, g]));
    spinner.succeed(`Found ${rt.library.games.length} games in your library`);
  } catch (err) {
    spinner.fail('Failed to fetch games');
    showError((err as Error).message);
    rt.exit(1);
  }

  if (rt.library.games.length === 0) {
    showError('No games found in your library');
    rt.exit(1);
  }

  // No saved selection (or an empty one) opens the picker with nothing ticked
  const saved = loadStartSelection(rt);
  // The picker clears the screen and marks them, but the line stays in scrollback and piped logs
  if (saved) announceMissing(rt, saved.games);
  const { selectedGames, aborted } = await selectGames(rt.library.games, saved?.games ?? [], false);

  if (aborted) {
    app.shutdown.handleShutdown(0);
    return;
  }

  if (selectedGames.length === 0) {
    showError('No games selected');
    app.shutdown.handleShutdown(1);
    return;
  }

  startIdling(app, selectedGames);
  // Enter is a change of selection like any other: save it. This also
  // completes a favorites migration, so the next start reads the selection file.
  rt.actions.saveSelection();
}

// Handles authentication method selection and login
async function handleLogin(client: SteamClient): Promise<LoginResult> {
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

// Handles state changes when another session plays a game on this account.
// Steam blocks this whole session while that happens, so every idling game
// freezes, and the played game (if idled) is shown as paused. Only reacts to
// transitions: Steam also echoes playingState(false, appid) after our own
// gamesPlayed calls, and re-sending on every echo would loop forever.
function handlePlayingState(app: App, blocked: boolean, playingApp: number): void {
  const { rt, flush, view } = app;
  // While waiting the clocks are already frozen: no banking, no restart.
  const changed = rt.session.setBlocked(blocked, playingApp, {
    bank: !rt.isWaitingForResume,
    restartClocks: !rt.isWaitingForResume,
  });
  if (!changed) return;

  if (blocked) {
    // Server playtime is flat for the whole block; a baseline from before it
    // would read as a zombie strike on the first probe afterwards.
    flush.resetBaseline();
  }

  // In edit mode the selector owns the screen and enterEditMode re-sends the
  // final list itself; the array changes above still apply.
  if (rt.isInEditMode || rt.isWaitingForResume) return;
  // Steam ignores gamesPlayed while blocked and does not restore the list on
  // its own afterwards: re-send on unblock, or idling silently stays dead until
  // the next change (up to the 4h flush).
  if (!blocked) rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));
  view.render();
}

// Initializes the idling session and starts the display loop
export function startIdling(app: App, games: GameSelection[]): void {
  const { rt, view, resume, flush, report } = app;
  rt.isIdling = true;
  rt.idlingStartedAt = new Date();

  // Steam reports a block right after logon, before this handler existed.
  rt.session.start(games, rt.library.byId, rt.client.isPlayingBlocked);

  // Only library games: saved games missing from the library are never sent to Steam
  rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));

  setupKeyboardInput(rt, app.editMode);

  view.render();
  view.start();

  rt.client.onPlayingState((blocked, playingApp) => handlePlayingState(app, blocked, playingApp));

  rt.client.onDisconnected((eresult, msg) => {
    if (rt.isShuttingDown) return;
    const isTakeover = TAKEOVER_ERESULTS.has(eresult);
    // A kick that lands while our flush relog is in flight is still a takeover:
    // the flush is over either way and the pause must be announced.
    if (isTakeover) rt.selfInitiatedRelog = false;
    if (isTakeover) flush.noteTakeover();
    const reason = rt.selfInitiatedRelog
      ? 'flushing playtime (scheduled relog)'
      : isTakeover
      ? 'player active on this account elsewhere'
      : `disconnected (${msg}, eresult ${eresult})`;
    if (!rt.isInEditMode && !rt.selfInitiatedRelog) {
      console.log(`\nDisconnected from Steam: ${msg} (${eresult})`);
    }
    resume.enterWaiting(reason, isTakeover);
  });

  rt.client.onError((err) => {
    if (rt.isShuttingDown) return;
    const isTakeover = isTakeoverError(err);
    if (isTakeover) rt.selfInitiatedRelog = false;
    if (isTakeover) flush.noteTakeover();
    const reason = isTakeover
      ? 'player active on this account elsewhere'
      : `Steam error: ${err.message}`;
    if (!rt.isInEditMode) console.log(`\nSteam error: ${err.message}`);
    resume.enterWaiting(reason, isTakeover);
  });

  // Catches steam-user's silent auto-relogins so we restore idling promptly
  // instead of waiting for the 60s attemptResume tick (which would then race
  // with the now-connected client and crash).
  rt.client.onLoggedOn(() => resume.onLoggedOn());

  report.start();
  flush.start();

  rt.discord.send(`▶️ Idling started — ${rt.session.idling.length} games`);

  // The bot connects only once idling has started, so a --setup-discord run or
  // a session still at the selector never answers commands for this account.
  const botConfig = rt.discord.botConfig();
  if (botConfig) rt.botHandle = startBot(botConfig, app.controlPanel, app.discord);
  // The status box goes live with idling too; it talks REST, so it keeps
  // updating while the Gateway reconnects
  const statusChannelId = botConfig?.statusChannelId;
  if (botConfig && statusChannelId && !rt.statusPanel) {
    rt.statusPanel = new StatusPanel({ ...botConfig, statusChannelId }, () => statusSnapshot(rt), { version: packageVersion() });
    rt.statusPanel.start();
  }

  // A kick or drop between login and here (e.g. while the selector was open)
  // had no handler yet; without this the screen would say "Idling" forever
  // while nothing is played and no resume is ever attempted.
  if (!rt.client.isConnected) {
    resume.enterWaiting('disconnected before idling started');
  }
}
