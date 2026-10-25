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
import { saveCurrentSelection } from './selection.js';
import { createShutdown, discordSecrets } from './shutdown.js';
import { Flush } from './steam/flush.js';
import { Resume } from './steam/resume.js';
import { main } from './cli.js';

// Builds every module once and hands them to main (src/cli.ts).

// Login and the bot need the concrete client and notifier; the rest reach them through rt
const client = new SteamClient();
const discord = new DiscordNotifier();
// The shared state: the session, the guard flags, the named timers
const rt = createRuntime({ client, discord, isHeadless: IS_HEADLESS });
const view = new StatusView(rt); // the idling screen and its refresh loop
const report = new DailyReport(rt); // the midnight Discord report
const shutdown = createShutdown(rt);
// Lets any module redraw, stop or save without importing these (no import cycles)
rt.actions = {
  render: () => view.render(),
  shutdown: shutdown.handleShutdown,
  saveSelection: () => saveCurrentSelection(rt),
};
const flush = new Flush(rt); // the 4-hour relog and the zombie check
const resume = new Resume(rt, flush, view); // reconnects and the paused/resumed notices
const editMode = createEditMode(rt, view, report); // the E key
const controlPanel = createControlPanel(rt, report); // what the bot may see and change

// Steam renewed the refresh token at logon. The old one stops working, so the
// new one has to reach disk or the next start cannot log in; this session runs
// on the in-memory copy either way.
function saveRenewedToken(refreshToken: string): void {
  const accountName = loadCredentials()?.accountName ?? rt.accountName;
  if (!accountName) return;
  if (!saveCredentials({ accountName, refreshToken })) {
    rt.discord.send(
      '⚠️ Steam renewed the login token but it could not be saved — the next restart will need an interactive login.'
    );
  }
}

// Signal, crash and token handlers. main installs them only after ruling out
// the CLI-only flags, so --setup-discord keeps Node's default Ctrl+C.
function installHandlers(): void {
  // SIGHUP: the terminal or SSH session closed; still stop and log off cleanly
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => shutdown.handleShutdown(0));
  }
  process.on('uncaughtException', shutdown.handleCrash);
  process.on('unhandledRejection', shutdown.handleRejection);
  rt.client.onRefreshToken(saveRenewedToken);
}

const app = { rt, client, discord, view, report, flush, resume, shutdown, editMode, controlPanel, installHandlers };

main(app, process.argv.slice(2)).catch((err: Error) => {
  // Ctrl+C in an inquirer prompt (raw mode, so no SIGINT) rejects with
  // ExitPromptError: an ordinary way out, not an error
  if (err.name === 'ExitPromptError') {
    showGoodbye();
    process.exit(0);
  }
  showError(redactSecrets(err.message, discordSecrets(rt)));
  process.exit(1);
});
