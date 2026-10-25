import * as readline from 'node:readline';
import type { Runtime } from '../runtime.js';
import type { DailyReport } from '../notifications/dailyReport.js';
import type { StatusView } from './statusView.js';
import { selectGames } from './gameSelector.js';
import { showError } from './display.js';
import { installSelection } from '../selection.js';

// Sets up raw mode keyboard input handling for edit and quit commands. Headless
// never touches stdin: `steamidler --headless &` from a shell would otherwise
// be stopped by SIGTTOU when setRawMode runs in the background.
export function setupKeyboardInput(rt: Runtime, editMode: () => Promise<void>): void {
  if (rt.isHeadless) return;
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdin.on('keypress', async (str, key) => {
      // Raw mode stays on during the exit grace; nothing may repaint over the goodbye
      if (rt.isShuttingDown) return;
      if (key && key.ctrl && key.name === 'c') {
        rt.actions.shutdown();
        return;
      }

      if (rt.isInEditMode) {
        return;
      }

      if (str === 'e' || str === 'E') {
        await editMode();
        return;
      }

      if (str === 'q' || str === 'Q') {
        rt.actions.shutdown();
        return;
      }
    });
  }
}

// Builds the E key's edit mode, which changes the game selection while idling
export function createEditMode(rt: Runtime, view: StatusView, report: DailyReport): () => Promise<void> {
  // Handles edit mode for changing game selection while idling
  return async function enterEditMode(): Promise<void> {
    if (rt.isWaitingForResume) {
      showError('Edit disabled while waiting for resume');
      return;
    }
    rt.isInEditMode = true;

    view.stop();
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
      rt.actions.shutdown(0);
      return;
    }

    if (newSelection.length === 0) {
      showError('No games selected - keeping current selection');
    } else {
      installSelection(rt, (appids) => report.forget(appids), newSelection);
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
    view.render();
    // A disconnect that landed while the selector was open leaves us waiting:
    // keep the clocks frozen and let restoreIdling restart the loop.
    if (!rt.isWaitingForResume) view.start();
  };
}
