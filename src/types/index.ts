// How a library game is held: bought, a free license, or lent through Steam Family
export type GameSource = 'owned' | 'free' | 'shared';

// One game from the account's library, as the client reports it
export interface SteamGame {
  appid: number;
  name: string;
  playtime_forever: number; // minutes, as Steam last committed them
  source: GameSource;
}

// What credentials.json holds
export interface StoredCredentials {
  accountName: string;
  refreshToken: string;
}

// Outcome of one login attempt; a failure carries Steam's EResult when it sent one
export interface LoginResult {
  success: boolean;
  accountName?: string;
  error?: string;
  eresult?: number;
}

// The interactive login choices besides reusing the saved login
export type AuthMethod = 'qr' | 'credentials';

// A game the owner picked; the name is kept so a game missing from the library can still be shown
export interface GameSelection {
  appid: number;
  name: string;
}

// A selected game that is in the library, with its playtime clock
export interface IdlingGame {
  appid: number;
  name: string;
  initialPlaytime: number; // Steam's playtime_forever at the start, in minutes
  startTime: Date; // when the clock last started running
  accumulatedMs: number; // idle time banked before the last pause
}

// What the picker returns; aborted means Ctrl+C was pressed inside it
export interface GameSelectorResult {
  selectedGames: GameSelection[];
  aborted?: boolean;
}
