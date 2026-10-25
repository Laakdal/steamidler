import type { Runtime } from './runtime.js';
import { isDiscordLibraryError } from './discord/bot.js';
import { redactSecrets } from './discord/format.js';
import { showGoodbye } from './ui/display.js';

// Grace before exit so a clean logOff socket write (and Discord post) can land.
const CRASH_FLUSH_GRACE_MS = 2000;
export const SHUTDOWN_FLUSH_GRACE_MS = 1500;
// Cap on closing the Discord Gateway at exit, so a hung socket never delays it
const BOT_DESTROY_TIMEOUT_MS = 1000;

// Secrets that error text must never carry to the console or Discord
export function discordSecrets(rt: Runtime): string[] {
  const token = rt.discord.botConfig()?.token;
  return token ? [token] : [];
}

// The shutdown, crash and unhandled-rejection paths. Shutdown and crash end in
// rt.exit, so tests can stub the exit; a rejection from inside the Discord
// libraries is logged and does not exit.
export function createShutdown(rt: Runtime): {
  handleShutdown(exitCode?: number): void;
  handleCrash(err: unknown): void;
  handleRejection(reason: unknown): void;
} {
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
    // land, and the final Discord post (4 s bot + 4 s webhook per part) gets to finish.
    const grace = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_GRACE_MS));
    void Promise.all([grace, finalMessage, panelStopped])
      .then(() => stopBot())
      .then(() => rt.exit(exitCode));
  }

  // Closes the Gateway after the final notification went out. Never rejects and
  // is time-capped, so both exit paths always reach rt.exit.
  function stopBot(): Promise<void> {
    if (!rt.botHandle) return Promise.resolve();
    const cap = new Promise<void>((resolve) => setTimeout(resolve, BOT_DESTROY_TIMEOUT_MS));
    return Promise.race([rt.botHandle.destroy().catch(() => {}), cap]);
  }

  // Discord stays optional: a rejection from inside the Discord libraries is
  // logged and idling carries on; any other rejection is a real crash.
  function handleRejection(reason: unknown): void {
    if (isDiscordLibraryError(reason)) {
      const error = reason as Error;
      console.error(`[discord] ignored a library error: ${redactSecrets(error.stack ?? error.message, discordSecrets(rt))}`);
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
    console.error('\nFatal error:', redactSecrets(detail, discordSecrets(rt)));

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
    const message = redactSecrets(err instanceof Error ? err.message : String(err), discordSecrets(rt));
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
      .then(() => rt.exit(1));
  }

  return { handleShutdown, handleCrash, handleRejection };
}
