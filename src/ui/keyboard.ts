import * as readline from 'node:readline';
import type { Runtime } from '../runtime.js';
import type { DailyReport } from '../notifications/dailyReport.js';
import type { StatusView } from './statusView.js';
import { selectGames } from './gameSelector.js';
import { showError } from './display.js';
import { installSelection } from '../selection.js';

// Raw mode, so single keys arrive without Enter. Taken at start and again
// after the picker, which leaves raw mode off when it closes.
function takeKeyboard(): void {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
}

// The idling screen's keys: E opens the picker, Q and Ctrl+C quit. Nothing
// here runs headless: raw mode in a background process (`--headless &`)
// gets it stopped by SIGTTOU.
export function setupKeyboardInput(rt: Runtime, editMode: () => Promise<void>): void {
  if (rt.isHeadless || !process.stdin.isTTY) return;
  takeKeyboard();
  process.stdin.on('keypress', (str: string | undefined, key: readline.Key | undefined) => {
    // Raw mode is still on during the exit grace: no key may draw over the goodbye
    if (rt.isShuttingDown) return;
    // Ctrl+C quits even with the picker open; other keys belong to the picker then
    if (key?.ctrl && key.name === 'c') {
      rt.actions.shutdown();
    } else if (rt.isInEditMode) {
      return;
    } else if (str?.toLowerCase() === 'e') {
      void editMode();
    } else if (str?.toLowerCase() === 'q') {
      rt.actions.shutdown();
    }
  });
}

// Builds what the E key runs: the picker over the running selection, then the
// new selection applied in place
export function createEditMode(rt: Runtime, view: StatusView, report: DailyReport): () => Promise<void> {
  return async function enterEditMode(): Promise<void> {
    if (rt.isWaitingForResume) {
      showError('Edit disabled while waiting for resume');
      return;
    }
    rt.isInEditMode = true;
    view.stop();
    // gamesPlayed stays set while the picker is open, so Steam keeps counting;
    // bank up to now and let the clocks run on (a block has frozen them already)
    if (!rt.session.blocked) rt.session.bank();
    console.clear();

    // The running selection includes missing games, so the picker lists them
    // and applying keeps them
    const picked = await selectGames(rt.library.games, rt.session.selection(), true);

    // Ctrl+C in the picker: the shutdown has begun, and the screen belongs to the goodbye
    if (picked.aborted || rt.isShuttingDown) {
      rt.isInEditMode = false;
      rt.actions.shutdown(0);
      return;
    }

    if (picked.selectedGames.length > 0) {
      installSelection(rt, (appids) => report.forget(appids), picked.selectedGames);
    } else {
      showError('No games selected - keeping current selection');
    }

    // Send the list again even when nothing changed: an unblock during the
    // picker left its re-send to this point, and Steam does not bring back a
    // blocked session's games by itself
    if (!rt.isWaitingForResume) rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));

    if (process.stdin.isTTY) takeKeyboard();
    rt.isInEditMode = false;

    if (!rt.idlingStartedAt) return;
    view.render();
    // A disconnect during the picker means we are waiting now: the clocks stay
    // frozen and restoreIdling restarts the refresh loop when the session is back
    if (!rt.isWaitingForResume) view.start();
  };
}
