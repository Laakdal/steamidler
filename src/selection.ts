import type { IdlingGame, GameSelection } from './types/index.js';

export interface SelectionState {
  idling: IdlingGame[];
  paused: IdlingGame[];
}

// Shared by the E key and the Discord commands so both apply a new selection
// identically; mutates game objects (as edit mode always did) but not the arrays.
export function computeSelection(
  state: SelectionState,
  newSelection: GameSelection[],
  createGame: (selection: GameSelection) => IdlingGame
): SelectionState {
  const oldAppIds = new Set([...state.idling, ...state.paused].map((g) => g.appid));
  const newAppIds = new Set(newSelection.map((g) => g.appid));

  // Kept idling games keep their running clock: the selector time was idled
  // too. A block or disconnect that landed meanwhile already owns startTime.
  const keptIdlingGames = state.idling.filter((g) => newAppIds.has(g.appid));
  const keptPausedGames = state.paused.filter((g) => newAppIds.has(g.appid));

  for (const selection of newSelection) {
    if (!oldAppIds.has(selection.appid)) {
      keptIdlingGames.push(createGame(selection));
    }
  }

  return { idling: keptIdlingGames, paused: keptPausedGames };
}
