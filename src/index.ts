#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
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
import { startBot } from './discord/bot.js';
import { redactSecrets } from './discord/format.js';
import { StatusPanel } from './discord/statusPanel.js';
import { createControlPanel, statusSnapshot } from './discord/controlPanel.js';
import { DailyReport } from './notifications/dailyReport.js';
import { MAX_IDLE_GAMES, IS_HEADLESS } from './constants.js';
import { createSpinner } from './ui/spinner.js';
import { StatusView } from './ui/statusView.js';
import { createEditMode, setupKeyboardInput } from './ui/keyboard.js';
import { createRuntime } from './runtime.js';
import { createShutdown, discordSecrets, SHUTDOWN_FLUSH_GRACE_MS } from './shutdown.js';
import { Flush } from './steam/flush.js';
import {
  Resume,
  formatDuration,
  backoffMs,
  TERMINAL_ERESULTS,
  RATE_LIMIT_ERESULTS,
  RATE_LIMIT_RETRY_LIMIT,
  RATE_LIMIT_BACKOFF_CAP_MS,
  RATE_LIMIT_MIN_WAIT_MS,
} from './steam/resume.js';
import type { GameSelection, LoginResult } from './types/index.js';

const KNOWN_FLAGS = ['--headless', '--setup-discord', '--logout', '--help', '-h', '--version', '-v'];
const args = process.argv.slice(2);
const isSetupDiscord = args.includes('--setup-discord');
const isLogout = args.includes('--logout');
const isHelp = args.includes('--help') || args.includes('-h');
const isVersion = args.includes('--version') || args.includes('-v');
const unknownFlags = args.filter((a) => !KNOWN_FLAGS.includes(a));

const TAKEOVER_ERESULTS = new Set<number>([6, 34]); // LoggedInElsewhere, LogonSessionReplaced

// The concrete client and notifier stay at hand for login and the bot, which
// need the full types; everything else goes through rt.
const client = new SteamClient();
const discord = new DiscordNotifier();
// Shared context: game state (rt.session), guard flags and timers (rt.timers)
const rt = createRuntime({ client, discord, isHeadless: IS_HEADLESS });
// The status table and its 60 s tick
const view = new StatusView(rt);
// The midnight report and its day-start snapshot
const report = new DailyReport(rt);
// Shutdown, crash and unhandled-rejection paths
const { handleShutdown, handleCrash, handleRejection } = createShutdown(rt);
// Lets code outside this file repaint or shut down without importing it
rt.actions = { render: () => view.render(), shutdown: handleShutdown };
// The 4-hour flush relog and the zombie watchdog
const flush = new Flush(rt);
// Waiting, getting back and the paused/resumed notices; startIdling registers its handlers
const resume = new Resume(rt, flush, view);
// The E key's selector while idling
const editMode = createEditMode(rt, view, report);
// What the Discord bot may see and do; startIdling hands it to the bot client.
const controlPanel = createControlPanel(rt, report);

// Recognises both shapes steam-user may surface a session-takeover as: a numeric
// eresult attached to the error, or the message string itself.
function isTakeoverError(err: Error & { eresult?: number }): boolean {
  if (err.eresult !== undefined && TAKEOVER_ERESULTS.has(err.eresult)) return true;
  return /loggedinelsewhere|logonsessionreplaced/i.test(err.message ?? '');
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
function startIdling(games: GameSelection[]): void {
  rt.isIdling = true;
  rt.idlingStartedAt = new Date();

  // Steam reports a block right after logon, before this handler existed.
  rt.session.start(games, rt.library.byId, rt.client.isPlayingBlocked);

  const appIds = games.map((g) => g.appid);
  rt.client.setGamesPlaying(appIds);

  setupKeyboardInput(rt, editMode);

  view.render();
  view.start();

  rt.client.onPlayingState(handlePlayingState);

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
  if (botConfig) rt.botHandle = startBot(botConfig, controlPanel, discord);
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

main().catch((err: Error) => {
  // Ctrl+C inside an inquirer prompt (raw mode, so no SIGINT) rejects with
  // ExitPromptError — a normal exit, not an error to print.
  if (err.name === 'ExitPromptError') {
    showGoodbye();
    process.exit(0);
  }
  showError(redactSecrets(err.message, discordSecrets(rt)));
  process.exit(1);
});
