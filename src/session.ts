import type { IdlingGame, GameSelection, SteamGame } from './types/index.js';

// The selected games and their playtime clocks. Each game is in exactly one of
// idling (sent to Steam), paused (being played elsewhere) or missing (saved but
// not in the library). No Steam or Discord imports and an injectable clock, so
// it is testable offline.
export class Session {
  private idlingGames: IdlingGame[] = [];
  private pausedGames: IdlingGame[] = [];
  // Saved games not in the library (family sharing late or withdrawn): kept in
  // the selection and the cap, never idled; retried at the next start.
  private missingGames: GameSelection[] = [];
  // True while another session on this account is playing. Steam blocks this
  // session's gamesPlayed entirely, so local time accounting freezes for every
  // idling game, not just the one being played.
  private playingBlocked = false;

  // now is injectable so tests can drive the clocks
  constructor(private readonly now: () => Date = () => new Date()) {}

  // Games currently sent to Steam
  get idling(): readonly IdlingGame[] {
    return this.idlingGames;
  }

  // Games paused because another session plays them
  get paused(): readonly IdlingGame[] {
    return this.pausedGames;
  }

  // Saved games that are not in the library; never sent to Steam or shown in the status table
  get missing(): readonly GameSelection[] {
    return this.missingGames;
  }

  // Whether another session on the account is playing (was playingBlocked)
  get blocked(): boolean {
    return this.playingBlocked;
  }

  // The whole selection in the selector's form, idling then paused then
  // missing, so every 32-game cap check counts the missing games too.
  selection(): GameSelection[] {
    return [...this.idlingGames, ...this.pausedGames, ...this.missingGames].map((g) => ({
      appid: g.appid,
      name: g.name,
    }));
  }

  // What the selection file stores: the same games, so paused and missing
  // games survive a restart.
  toSaved(): GameSelection[] {
    return this.selection();
  }

  // Initializes the session from the first selection; games not in the
  // library go to missing. Steam reports a block right after logon, before the
  // playingState handler exists, hence blocked.
  start(selection: GameSelection[], library: Map<number, SteamGame>, blocked: boolean): void {
    this.idlingGames = [];
    this.missingGames = [];
    for (const game of selection) {
      const steamGame = library.get(game.appid);
      if (steamGame) this.idlingGames.push(this.createGame(game, steamGame));
      else this.missingGames.push({ appid: game.appid, name: game.name });
    }
    this.pausedGames = [];
    this.playingBlocked = blocked;
  }

  // Folds the live delta into accumulatedMs and restarts the clock. Idempotent,
  // so overlapping freeze paths (edit mode, waiting state, playing-blocked) can
  // never double-count the same interval.
  bank(now = this.now()): void {
    for (const game of this.idlingGames) {
      game.accumulatedMs += now.getTime() - game.startTime.getTime();
      game.startTime = now;
    }
  }

  // Shared by the E key and the Discord commands so both apply a new selection
  // identically; keeps kept games as the same objects. A missing game that is
  // still selected stays missing; a new one not in the library joins missing.
  // Returns the appids of the idling games it created, so the caller can reset
  // their day-start.
  apply(selection: GameSelection[], library: Map<number, SteamGame>): number[] {
    const oldAppIds = new Set(this.selection().map((g) => g.appid));
    const newAppIds = new Set(selection.map((g) => g.appid));

    // Kept idling games keep their running clock: the selector time was idled
    // too. A block or disconnect that landed meanwhile already owns startTime.
    const keptIdlingGames = this.idlingGames.filter((g) => newAppIds.has(g.appid));
    const keptPausedGames = this.pausedGames.filter((g) => newAppIds.has(g.appid));
    const keptMissingGames = this.missingGames.filter((g) => newAppIds.has(g.appid));

    const created: number[] = [];
    for (const game of selection) {
      if (oldAppIds.has(game.appid)) continue;
      const steamGame = library.get(game.appid);
      if (steamGame) {
        keptIdlingGames.push(this.createGame(game, steamGame));
        created.push(game.appid);
      } else {
        keptMissingGames.push({ appid: game.appid, name: game.name });
      }
    }

    this.idlingGames = keptIdlingGames;
    this.pausedGames = keptPausedGames;
    this.missingGames = keptMissingGames;
    return created;
  }

  // Applies a block or unblock from Steam's playingState. Only reacts to
  // transitions (returns false otherwise): Steam also echoes
  // playingState(false, appid) after our own gamesPlayed calls. On block the
  // played game (if idled) moves to paused; on unblock paused games rejoin.
  // The caller passes bank/restartClocks false while waiting for resume, when
  // the clocks are already frozen.
  setBlocked(
    blocked: boolean,
    playingApp: number,
    opts: { bank: boolean; restartClocks: boolean }
  ): boolean {
    if (blocked === this.playingBlocked) return false;
    this.playingBlocked = blocked;
    const now = this.now();

    if (blocked) {
      if (opts.bank) this.bank(now);
      const idleIndex = this.idlingGames.findIndex((g) => g.appid === playingApp);
      if (idleIndex !== -1) {
        const [pausedGame] = this.idlingGames.splice(idleIndex, 1);
        if (pausedGame) this.pausedGames.push(pausedGame);
      }
    } else {
      this.releasePaused();
      if (opts.restartClocks) this.restartClocks(now);
    }
    return true;
  }

  // A fresh Steam session starts unblocked: games paused by a block before the
  // disconnect rejoin now, and every idling clock restarts (restoreIdling).
  release(now = this.now()): void {
    this.playingBlocked = false;
    this.releasePaused();
    this.restartClocks(now);
  }

  // Restarts the clock of every idling game after a frozen stretch
  restartClocks(now = this.now()): void {
    for (const game of this.idlingGames) game.startTime = now;
  }

  // Playtime gained this run: no live delta while frozen, since no
  // server-side playtime accrues then.
  gainedMs(game: IdlingGame, frozen: boolean, now = this.now()): number {
    return frozen ? game.accumulatedMs : game.accumulatedMs + (now.getTime() - game.startTime.getTime());
  }

  // Moves paused games back into rotation once the block is over.
  private releasePaused(): void {
    this.idlingGames.push(...this.pausedGames);
    this.pausedGames = [];
  }

  // Creates an IdlingGame from a selected library game, its total starting at Steam's playtime
  private createGame(game: GameSelection, steamGame: SteamGame): IdlingGame {
    return {
      appid: game.appid,
      name: game.name,
      initialPlaytime: steamGame.playtime_forever,
      startTime: this.now(),
      accumulatedMs: 0,
    };
  }
}
