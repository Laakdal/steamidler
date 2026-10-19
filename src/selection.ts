import type { IdlingGame, GameSelection } from './types/index.js';

export interface SelectionState {
  idling: IdlingGame[];
  pausing: IdlingGame[];
  paused: IdlingGame[];
}

// Shared by the E key and the Discord commands so both apply a new selection
// identically; mutates game objects (as edit mode always did) but not the arrays.
export function computeSelection(
  state: SelectionState,
  newSelection: GameSelection[],
  newExemptAppId: number | null,
  createGame: (selection: GameSelection, isExempt: boolean) => IdlingGame,
  randomIdlePhaseMs: () => number,
  now: Date
): SelectionState {
  const oldAppIds = new Set(
    [...state.idling, ...state.paused, ...state.pausing].map((g) => g.appid)
  );
  const newAppIds = new Set(newSelection.map((g) => g.appid));

  const applyExemptChange = (game: IdlingGame): void => {
    const shouldBeExempt = game.appid === newExemptAppId;
    const wasExempt = game.nextPauseAtMs === null;
    if (shouldBeExempt && !wasExempt) {
      game.nextPauseAtMs = null;
      game.pauseUntil = null;
    } else if (!shouldBeExempt && wasExempt) {
      game.nextPauseAtMs = game.accumulatedMs + randomIdlePhaseMs();
    }
  };

  const keptIdlingGames: IdlingGame[] = [];
  const keptPausedGames: IdlingGame[] = [];
  const keptPausingGames: IdlingGame[] = [];

  // Kept idling games keep their running clock: the selector time was idled
  // too. A block or disconnect that landed meanwhile already owns startTime.
  for (const game of state.idling) {
    if (newAppIds.has(game.appid)) {
      applyExemptChange(game);
      keptIdlingGames.push(game);
    }
  }

  for (const game of state.paused) {
    if (newAppIds.has(game.appid)) {
      applyExemptChange(game);
      keptPausedGames.push(game);
    }
  }

  for (const game of state.pausing) {
    if (newAppIds.has(game.appid)) {
      applyExemptChange(game);
      // Becoming exempt clears pauseUntil — game rejoins idling immediately
      if (game.nextPauseAtMs === null) {
        game.startTime = now;
        keptIdlingGames.push(game);
      } else {
        keptPausingGames.push(game);
      }
    }
  }

  for (const selection of newSelection) {
    if (!oldAppIds.has(selection.appid)) {
      keptIdlingGames.push(createGame(selection, selection.appid === newExemptAppId));
    }
  }

  return { idling: keptIdlingGames, pausing: keptPausingGames, paused: keptPausedGames };
}
