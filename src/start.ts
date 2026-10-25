import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { SteamClient } from './steam/client.js';
import { loginWithQR, loginWithCredentials, loginWithStoredCredentials, hasStoredLogin } from './steam/auth.js';
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
  RATE_LIMIT_RETRY_LIMIT,
  RATE_LIMIT_BACKOFF_CAP_MS,
  RATE_LIMIT_MIN_WAIT_MS,
} from './steam/resume.js';
import { TERMINAL_ERESULTS, RATE_LIMIT_ERESULTS, TAKEOVER_ERESULTS, isTakeoverError } from './steam/eresults.js';
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

// Headless exit codes (AGENTS.md §4): 1 is passing, so systemd restarts; 2 is
// a setup problem a restart cannot fix (RestartPreventExitStatus=2)
const EXIT_RETRY = 1;
const EXIT_SETUP = 2;

// The reason shown and sent while another device holds the session
const TAKEOVER_REASON = 'player active on this account elsewhere';

// The version in package.json (dist/start.js sits one level below it)
export function packageVersion(): string {
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
}

// Says once per run that Discord is set up with the webhook only, so the
// missing bot commands are no surprise
function announceWebhookOnly(rt: Runtime): void {
  if (!rt.discord.isConfigured() || rt.discord.botConfig()) return;
  console.log('Discord: notifications only (webhook). Run --setup-discord to add the bot for /add, /remove and /status.');
}

// Ends a headless start that cannot go on. The reason goes to Discord too,
// or a systemd service would die without a word; the exit waits for that send
// and the flush grace.
async function failHeadless(rt: Runtime, message: string, exitCode: number): Promise<never> {
  showError(message);
  const sent = rt.discord.send(`🛑 Headless start failed — ${message}`);
  try {
    if (rt.client.isConnected) rt.client.logout();
  } catch {
    // Logging off is a courtesy here; the exit follows regardless
  }
  await Promise.all([new Promise((r) => setTimeout(r, SHUTDOWN_FLUSH_GRACE_MS)), sent]);
  rt.exit(exitCode);
  // Only reached when rt.exit returns (a test's stub throws instead)
  throw new Error(`exit ${exitCode} returned`);
}

// Fetches the library into rt.library; the spinner's success line differs per mode
async function loadLibrary(rt: Runtime, foundText: (count: number) => string): Promise<void> {
  const spinner = createSpinner('Fetching your game library...').start();
  try {
    const games = await rt.client.getOwnedGames();
    rt.library.games = games;
    rt.library.byId = new Map(games.map((g) => [g.appid, g]));
    spinner.succeed(foundText(games.length));
  } catch (err) {
    spinner.fail('Failed to fetch games');
    throw err;
  }
}

// The selection to start from: the saved file, or the old favorites it is
// migrated from. Games found in the library take their current library name
// (a migration only has placeholders); missing ones keep the saved name.
// null when there is nothing, an empty list included.
function loadStartSelection(rt: Runtime): { games: GameSelection[]; migrated: boolean } | null {
  const loaded = loadSelection(rt.accountName);
  if (!loaded?.games.length) return null;
  const games = loaded.games.map((g) => {
    const name = rt.library.byId.get(g.appid)?.name;
    return name === undefined ? g : { appid: g.appid, name };
  });
  return { games, migrated: loaded.source === 'favorites' };
}

// Lists the saved games the library does not have right now. They stay in the
// selection (family sharing can be late, or lent again later), and this line
// tells the owner why they are not idling.
function announceMissing(rt: Runtime, games: GameSelection[]): void {
  const names = games.filter((g) => !rt.library.byId.has(g.appid)).map((g) => g.name);
  if (names.length === 0) return;
  console.log(
    chalk.yellow(`Saved but not in your library right now: ${names.join(', ')}; kept, retried at the next start.`)
  );
}

// Logs on with the saved token. A rate limit is waited out here rather than by
// exiting: systemd would restart within seconds and each logon extends
// Steam's lockout.
async function headlessLogin(app: App): Promise<LoginResult> {
  const { rt, client } = app;
  let result = await loginWithStoredCredentials(client);
  for (let limited = 1; !result.success && RATE_LIMIT_ERESULTS.has(result.eresult ?? -1); limited++) {
    if (limited >= RATE_LIMIT_RETRY_LIMIT) break;
    const wait = Math.max(RATE_LIMIT_MIN_WAIT_MS, backoffMs(limited, RATE_LIMIT_BACKOFF_CAP_MS));
    console.log(chalk.yellow(`Rate limited by Steam — retrying login in ${formatDuration(wait)}.`));
    if (limited === 1) rt.discord.send('⏸️ Headless start rate-limited by Steam — waiting before retrying.');
    await new Promise((r) => setTimeout(r, wait));
    result = await loginWithStoredCredentials(client);
  }
  return result;
}

// Headless start (systemd): saved login, saved selection, no prompts
export async function runHeadless(app: App): Promise<void> {
  const { rt } = app;
  if (!hasStoredLogin()) {
    await failHeadless(rt, 'No stored login found. Run interactively first to log in.', EXIT_SETUP);
  }

  const login = await headlessLogin(app);
  if (!login.success) {
    // A dead token, a banned account or an old protocol is the same after a
    // restart: exit 2 so systemd stops instead of logging on every 10 s
    const permanent = TERMINAL_ERESULTS.has(login.eresult ?? -1);
    await failHeadless(rt, login.error || 'Unknown error', permanent ? EXIT_SETUP : EXIT_RETRY);
  }
  rt.accountName = login.accountName!;
  announceWebhookOnly(rt);

  try {
    await loadLibrary(rt, (n) => `Found ${n} games`);
  } catch (err) {
    await failHeadless(rt, (err as Error).message, EXIT_RETRY);
  }

  const saved = loadStartSelection(rt);
  if (!saved) {
    return failHeadless(rt, 'No games selected. Run steamidler interactively once to pick games.', EXIT_SETUP);
  }
  const startable = saved.games.filter((g) => rt.library.byId.has(g.appid)).length;
  if (startable === 0) {
    // Family-shared games only show up once license data has arrived; a slow
    // boot must not pass for a setup error. The selection file stays as it is.
    if (!rt.client.ownershipCacheComplete) {
      return failHeadless(rt, 'No matching games found — library incomplete (license data timed out). Retrying.', EXIT_RETRY);
    }
    return failHeadless(rt, `None of your ${saved.games.length} saved games are in your library.`, EXIT_SETUP);
  }
  announceMissing(rt, saved.games);

  console.log(`Starting ${startable} saved game(s)...`);
  startIdling(app, saved.games);
  // A migrated selection is written straight away, so the next start reads
  // the selection file; one loaded from that file has nothing new to save
  if (saved.migrated) rt.actions.saveSelection();
}

// Asks how to log in and runs that login
async function interactiveLogin(client: SteamClient): Promise<LoginResult> {
  const method = await promptAuthMethod(hasStoredLogin());
  if (method === 'stored') return loginWithStoredCredentials(client);
  if (method === 'qr') return loginWithQR(client);
  if (method === 'credentials') return loginWithCredentials(client);
  return { success: false, error: 'Invalid login method' };
}

// Offers the Discord setup once, on a machine without a discord.json
async function offerDiscordSetup(rt: Runtime): Promise<void> {
  const wanted = await confirm({
    message: 'Configure Discord notifications now? You can do this later with --setup-discord.',
    default: true,
  });
  if (wanted) {
    try {
      await runDiscordSetup(packageVersion());
    } catch (err) {
      console.log(chalk.yellow(`Discord setup failed: ${(err as Error).message}`));
      console.log(chalk.gray('Continuing without notifications. Run --setup-discord to retry.'));
    }
  } else if (!existsSync(DISCORD_CONFIG_PATH)) {
    // Remember the "no". A file that exists but does not load is left alone:
    // it may hold a token or webhook the owner only has to fix by hand.
    saveDiscordDisabled();
  }
  rt.discord.reload();
}

// Interactive start: login menu, Discord offer, picker
export async function runInteractive(app: App): Promise<void> {
  const { rt, client } = app;
  showWelcome(packageVersion());

  // A failed login goes back to the menu; Ctrl+C there is the way out
  let login = await interactiveLogin(client);
  while (!login.success) {
    showLoginError(login.error || 'Unknown error');
    login = await interactiveLogin(client);
  }
  rt.accountName = login.accountName!;
  showLoginSuccess(rt.accountName);

  if (!rt.discord.hasFile()) await offerDiscordSetup(rt);
  announceWebhookOnly(rt);
  await pickAndStart(app);
}

// Loads the library, opens the picker on the saved selection and starts
// idling the result. Kept apart from runInteractive so tests can run it
// without a login.
export async function pickAndStart(app: App): Promise<void> {
  const { rt } = app;
  try {
    await loadLibrary(rt, (n) => `Found ${n} games in your library`);
  } catch (err) {
    showError((err as Error).message);
    rt.exit(1);
  }
  if (rt.library.games.length === 0) {
    showError('No games found in your library');
    rt.exit(1);
  }

  // Nothing saved opens the picker with nothing ticked
  const saved = loadStartSelection(rt);
  // The picker clears the screen, but this line stays in scrollback and in piped logs
  if (saved) announceMissing(rt, saved.games);
  const picked = await selectGames(rt.library.games, saved?.games ?? [], false);

  if (picked.aborted) {
    app.shutdown.handleShutdown(0);
    return;
  }
  if (picked.selectedGames.length === 0) {
    showError('No games selected');
    app.shutdown.handleShutdown(1);
    return;
  }
  startIdling(app, picked.selectedGames);
  // Enter changed the selection, so save it; this also finishes a favorites
  // migration, so the next start reads the selection file
  rt.actions.saveSelection();
}

// Another device on the account started or stopped playing. Steam ignores our
// games for as long as it plays, so every clock freezes and the game it plays,
// if ours, shows as paused. Steam also sends playingState(false, appid) as an
// echo of our own gamesPlayed, so only real changes count; answering every
// echo with a re-send would loop for ever.
function onPlayingState(app: App, blocked: boolean, playingApp: number): void {
  const { rt, flush, view } = app;
  // While waiting for resume the clocks are frozen already
  const live = !rt.isWaitingForResume;
  if (!rt.session.setBlocked(blocked, playingApp, { bank: live, restartClocks: live })) return;

  // Steam's playtime stands still during a block; a zombie baseline from
  // before it would count as a failed check afterwards
  if (blocked) flush.resetBaseline();

  // The picker re-sends the final list itself when it closes; while waiting,
  // restoreIdling does
  if (rt.isInEditMode || !live) return;
  // After a block Steam does not restore our list by itself: without this
  // nothing idles until the next change or the 4-hour flush
  if (!blocked) rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));
  view.render();
}

// The session dropped. A takeover cancels a flush relog in flight (that
// relog is over either way, and the pause must be announced) and gets the
// longer first retry.
function onDisconnected(app: App, eresult: number, msg: string): void {
  const { rt } = app;
  if (rt.isShuttingDown) return;
  const takeover = TAKEOVER_ERESULTS.has(eresult);
  if (takeover) {
    rt.selfInitiatedRelog = false;
    app.flush.noteTakeover();
  }
  let reason = `disconnected (${msg}, eresult ${eresult})`;
  if (takeover) reason = TAKEOVER_REASON;
  else if (rt.selfInitiatedRelog) reason = 'flushing playtime (scheduled relog)';
  if (!rt.isInEditMode && !rt.selfInitiatedRelog) console.log(`\nDisconnected from Steam: ${msg} (${eresult})`);
  app.resume.enterWaiting(reason, takeover);
}

// steam-user raised an error, which also ends the session
function onSteamError(app: App, err: Error & { eresult?: number }): void {
  const { rt } = app;
  if (rt.isShuttingDown) return;
  const takeover = isTakeoverError(err);
  if (takeover) {
    rt.selfInitiatedRelog = false;
    app.flush.noteTakeover();
  }
  if (!rt.isInEditMode) console.log(`\nSteam error: ${err.message}`);
  app.resume.enterWaiting(takeover ? TAKEOVER_REASON : `Steam error: ${err.message}`, takeover);
}

// Starts the Discord side of a running session: the bot and the status box.
// Both wait for idling, so a --setup-discord run or a session still in the
// picker never answers commands for this account.
function startDiscord(app: App): void {
  const { rt } = app;
  const bot = rt.discord.botConfig();
  if (!bot) return;
  rt.botHandle = startBot(bot, app.controlPanel, app.discord);
  // The box talks REST, so it keeps updating while the Gateway reconnects
  if (bot.statusChannelId && !rt.statusPanel) {
    rt.statusPanel = new StatusPanel({ ...bot, statusChannelId: bot.statusChannelId }, () => statusSnapshot(rt), {
      version: packageVersion(),
    });
    rt.statusPanel.start();
  }
}

// Starts idling `games`: the session, the screen, the Steam handlers, the
// timers and Discord
export function startIdling(app: App, games: GameSelection[]): void {
  const { rt, view, resume, flush, report } = app;
  rt.isIdling = true;
  rt.idlingStartedAt = new Date();

  // A block Steam reported right after logon, before any handler, counts from the start
  rt.session.start(games, rt.library.byId, rt.client.isPlayingBlocked);
  // Missing games never go to Steam
  rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));

  setupKeyboardInput(rt, app.editMode);
  view.render();
  view.start();

  rt.client.onPlayingState((blocked, playingApp) => onPlayingState(app, blocked, playingApp));
  rt.client.onDisconnected((eresult, msg) => onDisconnected(app, eresult, msg));
  rt.client.onError((err) => onSteamError(app, err));
  // A logon steam-user makes by itself restores idling at once, before the
  // pending attempt could log on into a connected client
  rt.client.onLoggedOn(() => resume.onLoggedOn());

  report.start();
  flush.start();
  rt.discord.send(`▶️ Idling started — ${rt.session.idling.length} games`);
  startDiscord(app);

  // A drop between login and now (in the picker, say) found no handler. Left
  // alone the screen would say Idling for ever with nothing played or retried.
  if (!rt.client.isConnected) resume.enterWaiting('disconnected before idling started');
}
