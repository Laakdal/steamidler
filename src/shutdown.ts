import type { Runtime } from './runtime.js';
import { isDiscordLibraryError } from './discord/bot.js';
import { redactSecrets } from './discord/format.js';
import { showGoodbye } from './ui/display.js';

// Time given to the logOff packet (the trigger for Steam's playtime commit)
// and the last Discord post before the process exits
export const SHUTDOWN_FLUSH_GRACE_MS = 1500;
const CRASH_FLUSH_GRACE_MS = 2000;
// The Discord Gateway gets this long to close; a hung socket must not hold the exit
const BOT_CLOSE_LIMIT_MS = 1000;

// The secrets error text must never carry to the console or Discord
export function discordSecrets(rt: Runtime): string[] {
  const token = rt.discord.botConfig()?.token;
  return token ? [token] : [];
}

// The three ways the process ends: a requested stop, a crash, and an
// unhandled rejection (a crash unless it came from inside the Discord
// libraries). Stop and crash end in rt.exit, which tests replace.
export function createShutdown(rt: Runtime): {
  handleShutdown(exitCode?: number): void;
  handleCrash(err: unknown): void;
  handleRejection(reason: unknown): void;
} {
  // Clears the games and logs off. Each step is tried on its own, so a throw
  // in one never skips the other or the exit after them.
  function releaseSteam(onError: (err: Error) => void): void {
    try {
      if (rt.isIdling) rt.client.stopPlaying();
      rt.isIdling = false;
    } catch (err) {
      onError(err as Error);
    }
    try {
      if (rt.client.isLoggedIn || rt.client.isConnected) rt.client.logout();
    } catch (err) {
      onError(err as Error);
    }
  }

  // Closes the Gateway once the last message is out. Never rejects and is
  // capped, so the exit always comes.
  function closeBot(): Promise<void> {
    if (!rt.botHandle) return Promise.resolve();
    const limit = new Promise<void>((resolve) => setTimeout(resolve, BOT_CLOSE_LIMIT_MS));
    return Promise.race([rt.botHandle.destroy().catch(() => {}), limit]);
  }

  // Waits for the grace, the last Discord message and the status box turning
  // red (each bounded, none rejects), closes the bot, then exits
  function exitAfter(graceMs: number, lastMessage: Promise<unknown>, exitCode: number): void {
    const grace = new Promise((resolve) => setTimeout(resolve, graceMs));
    const panel = rt.statusPanel ? rt.statusPanel.stop() : Promise.resolve();
    void Promise.all([grace, lastMessage, panel])
      .then(closeBot)
      .then(() => rt.exit(exitCode));
  }

  // A stop: quit key, signal, or a give-up path. The exit code tells systemd
  // whether a restart could help (1) or not (0).
  function handleShutdown(exitCode = 0): void {
    if (rt.isShuttingDown) return;
    rt.isShuttingDown = true;
    console.log('\n');
    rt.timers.clearAll();
    releaseSteam((err) => console.error('Logout failed:', err.message));

    // "quit by user" only once idling had started, and only when no give-up
    // path has already said why it stopped
    const quitNotice =
      !rt.stopNotified && rt.idlingStartedAt ? rt.discord.send('🛑 Idling stopped — quit by user') : Promise.resolve();
    showGoodbye();
    exitAfter(SHUTDOWN_FLUSH_GRACE_MS, quitNotice, exitCode);
  }

  // A fatal error: stop playing and log off anyway, so Steam still commits the
  // playtime of the session, then exit 1
  function handleCrash(err: unknown): void {
    if (rt.isShuttingDown) return;
    rt.isShuttingDown = true;
    const secrets = discordSecrets(rt);
    // The stack only, never the error object: discord.js errors carry request
    // URLs that can embed an interaction token
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error('\nFatal error:', redactSecrets(detail, secrets));
    rt.timers.clearAll();
    releaseSteam(() => {});

    const reason = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    let crashNotice: Promise<unknown> = Promise.resolve();
    if (!rt.stopNotified) {
      crashNotice = rt.discord.send(
        rt.idlingStartedAt
          ? `🛑 Idling stopped — crashed (${reason}).`
          : `🛑 steamidler crashed before idling started (${reason}).`
      );
    }
    exitAfter(CRASH_FLUSH_GRACE_MS, crashNotice, 1);
  }

  // Discord is optional: its libraries' own rejections are logged and idling
  // carries on. Any other rejection is a crash.
  function handleRejection(reason: unknown): void {
    if (!isDiscordLibraryError(reason)) {
      handleCrash(reason);
      return;
    }
    const error = reason as Error;
    console.error(`[discord] ignored a library error: ${redactSecrets(error.stack ?? error.message, discordSecrets(rt))}`);
  }

  return { handleShutdown, handleCrash, handleRejection };
}
