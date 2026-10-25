import type { Runtime } from '../runtime.js';
import { isFrozen } from '../runtime.js';
import type { DailyReport } from '../notifications/dailyReport.js';
import { installSelection } from '../selection.js';
import { MAX_IDLE_GAMES } from '../constants.js';
import type { ControlPanel, SelectedGameView } from './commands.js';
import type { PanelGame, StatusSnapshot } from './statusEmbed.js';
import type { GameSelection, IdlingGame } from '../types/index.js';

// What the Discord status box shows, computed like the terminal table: no
// live delta while frozen or for games that are not idling. Waiting wins over
// blocked, since a disconnected session cannot be blocked meaningfully.
export function statusSnapshot(rt: Runtime): StatusSnapshot {
  const now = Date.now();
  const frozen = isFrozen(rt);
  const view = (g: IdlingGame, state: PanelGame['state']): PanelGame => {
    const gainedMs = g.accumulatedMs + (state === 'idling' && !frozen ? now - g.startTime.getTime() : 0);
    return {
      name: g.name,
      state,
      totalMinutes: g.initialPlaytime + Math.floor(gainedMs / 60000),
      gainedMs,
    };
  };
  return {
    state: rt.isShuttingDown ? 'stopped' : rt.isWaitingForResume ? 'waiting' : rt.session.blocked ? 'blocked' : 'idling',
    waitingReason: rt.isWaitingForResume ? rt.waitingReason : null,
    games: [
      ...rt.session.idling.map((g) => view(g, 'idling')),
      ...rt.session.paused.map((g) => view(g, 'paused')),
    ],
  };
}

// Builds what the Discord bot may see and do; startIdling hands it to the bot client.
export function createControlPanel(rt: Runtime, report: DailyReport): ControlPanel {
  // Applies a changed selection from the Discord commands exactly as edit mode does.
  function applyRemoteSelection(newSelection: GameSelection[]): void {
    if (!rt.session.blocked) rt.session.bank();
    installSelection(rt, (appids) => report.forget(appids), newSelection);
    if (!rt.isWaitingForResume) rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid));
    if (!rt.isInEditMode) rt.actions.render();
  }

  return {
    // Reports why a remote change is unsafe right now, or null when it is fine.
    busyReason(): string | null {
      if (rt.isShuttingDown) return 'steamidler is shutting down.';
      if (!rt.idlingStartedAt) return "Idling hasn't started yet.";
      if (rt.isInEditMode) return 'The game selector is open on the PC — try again after closing it.';
      if (rt.isWaitingForResume) {
        return `Disconnected from Steam (${rt.waitingReason}) — try again after it reconnects.`;
      }
      return null;
    },
    // Exposes the disconnect reason, or null while connected.
    waitingReason(): string | null {
      return rt.isWaitingForResume ? rt.waitingReason : null;
    },
    // Lists the owned games the commands may offer.
    library(): { appid: number; name: string }[] {
      return rt.library.games.map((g) => ({ appid: g.appid, name: g.name }));
    },
    // Maps the two internal arrays to the read-only view the bot renders.
    selection(): SelectedGameView[] {
      const view = (g: IdlingGame, state: SelectedGameView['state']): SelectedGameView => ({
        appid: g.appid,
        name: g.name,
        state,
      });
      return [
        ...rt.session.idling.map((g) => view(g, 'idling')),
        ...rt.session.paused.map((g) => view(g, 'paused')),
      ];
    },
    // Adds a library game to the live selection; unknown or already-selected ids,
    // and anything past Steam's 32-game limit, are ignored.
    add(appid: number): void {
      const game = rt.library.byId.get(appid);
      const current = rt.session.selection();
      if (!game || current.some((g) => g.appid === appid) || current.length >= MAX_IDLE_GAMES) return;
      applyRemoteSelection([...current, { appid, name: game.name }]);
    },
    // Drops a game from the live selection; unselected ids are ignored.
    remove(appid: number): void {
      const current = rt.session.selection();
      if (!current.some((g) => g.appid === appid)) return;
      applyRemoteSelection(current.filter((g) => g.appid !== appid));
    },
  };
}
