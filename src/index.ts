#!/usr/bin/env node

import { SteamClient } from './steam/client.js';
import { showGoodbye, showError } from './ui/display.js';
import { loadCredentials, saveCredentials } from './storage/credentials.js';
import { DiscordNotifier } from './discord/notifier.js';
import { redactSecrets } from './discord/format.js';
import { createControlPanel } from './discord/controlPanel.js';
import { DailyReport } from './notifications/dailyReport.js';
import { IS_HEADLESS } from './constants.js';
import { StatusView } from './ui/statusView.js';
import { createEditMode } from './ui/keyboard.js';
import { createRuntime } from './runtime.js';
import { createShutdown, discordSecrets } from './shutdown.js';
import { Flush } from './steam/flush.js';
import { Resume } from './steam/resume.js';
import { main } from './cli.js';

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
const shutdown = createShutdown(rt);
const { handleShutdown, handleCrash, handleRejection } = shutdown;
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

// Signal, crash and token-renewal handlers. main installs them only once a
// CLI-only flag is ruled out, so --setup-discord keeps the default Ctrl+C.
function installHandlers(): void {
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
}

const app = { rt, client, discord, view, report, flush, resume, shutdown, editMode, controlPanel, installHandlers };

main(app, process.argv.slice(2)).catch((err: Error) => {
  // Ctrl+C inside an inquirer prompt (raw mode, so no SIGINT) rejects with
  // ExitPromptError — a normal exit, not an error to print.
  if (err.name === 'ExitPromptError') {
    showGoodbye();
    process.exit(0);
  }
  showError(redactSecrets(err.message, discordSecrets(rt)));
  process.exit(1);
});
