import type { GameSelection } from './types/index.js';
import type { Runtime } from './runtime.js';
import { saveSelection } from './storage/selection.js';

const SAVE_FAILED_NOTICE = '⚠️ Could not save the game selection — a restart will forget recent changes';

// Saves the current selection (idling, paused and missing games). A failure is
// already on the console; Discord hears about the first one only, until a save
// succeeds again, so an unwritable config dir does not repeat the notice on
// every change. Idling carries on either way.
export function saveCurrentSelection(rt: Runtime): void {
  if (saveSelection(rt.accountName, rt.session.toSaved())) {
    rt.saveFailureNotified = false;
    return;
  }
  if (rt.saveFailureNotified) return;
  rt.saveFailureNotified = true;
  rt.discord.send(SAVE_FAILED_NOTICE);
}

// Runs the shared selection diff and installs the result, for edit mode and the
// Discord commands alike. A game the diff creates (new, or removed and re-added
// the same day) drops its old day-start snapshot, so the daily report counts it
// from zero instead of clamping a negative gain to 0m. Every installed
// selection is saved, so edit mode, /add and /remove all persist.
export function installSelection(
  rt: Runtime,
  forgetDayStart: (appids: number[]) => void,
  selection: GameSelection[]
): void {
  const created = rt.session.apply(selection, rt.library.byId);
  forgetDayStart(created);
  rt.actions.saveSelection();
}
