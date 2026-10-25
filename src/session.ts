import type { IdlingGame, GameSelection, SteamGame } from './types/index.js';

// The selected games and their playtime clocks. Each game is in exactly one of
// idling (sent to Steam) or paused (being played elsewhere). No Steam or
// Discord imports and an injectable clock, so it is testable offline.
export class Session {
  private idlingGames: IdlingGame[] = [];
  private pausedGames: IdlingGame[] = [];
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

  // Whether another session on the account is playing (was playingBlocked)
  get blocked(): boolean {
    return this.playingBlocked;
  }

  // Converts both arrays back to the selector's form, idling then paused
  selection(): GameSelection[] {
    return [...this.idlingGames, ...this.pausedGames].map((g) => ({
      appid: g.appid,
      name: g.name,
    }));
  }

  // Initializes the session from the first selection. Steam reports a block
  // right after logon, before the playingState handler exists, hence blocked.
  start(selection: GameSelection[], library: Map<number, SteamGame>, blocked: boolean): void {
    this.idlingGames = selection.map((game) => {
      const steamGame = library.get(game.appid);
      return this.createGame(game, steamGame);
    });
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
  // identically; keeps kept games as the same objects. Returns the appids of
  // the games it created, so the caller can reset their day-start.
  apply(selection: GameSelection[], library: Map<number, SteamGame>): number[] {
    const oldAppIds = new Set([...this.idlingGames, ...this.pausedGames].map((g) => g.appid));
    const newAppIds = new Set(selection.map((g) => g.appid));

    // Kept idling games keep their running clock: the selector time was idled
    // too. A block or disconnect that landed meanwhile already owns startTime.
    const keptIdlingGames = this.idlingGames.filter((g) => newAppIds.has(g.appid));
    const keptPausedGames = this.pausedGames.filter((g) => newAppIds.has(g.appid));

    const created: number[] = [];
    for (const game of selection) {
      if (!oldAppIds.has(game.appid)) {
        keptIdlingGames.push(this.createGame(game, library.get(game.appid)));
        created.push(game.appid);
      }
    }

    this.idlingGames = keptIdlingGames;
    this.pausedGames = keptPausedGames;
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

  // Creates an IdlingGame from a selection; a game missing from the library starts at 0 minutes
  private createGame(game: GameSelection, steamGame?: SteamGame): IdlingGame {
    const initialPlaytime = steamGame?.playtime_forever ?? 0;
    return {
      appid: game.appid,
      name: game.name,
      initialPlaytime,
      startTime: this.now(),
      accumulatedMs: 0,
    };
  }
}
