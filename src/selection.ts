import type { GameSelection } from './types/index.js';
import type { Runtime } from './runtime.js';

// Runs the shared selection diff and installs the result, for edit mode and the
// Discord commands alike. A game the diff creates (new, or removed and re-added
// the same day) drops its old day-start snapshot, so the daily report counts it
// from zero instead of clamping a negative gain to 0m.
export function installSelection(
  rt: Runtime,
  forgetDayStart: (appids: number[]) => void,
  selection: GameSelection[]
): void {
  const created = rt.session.apply(selection, rt.library.byId);
  forgetDayStart(created);
}
