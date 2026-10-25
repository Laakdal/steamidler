import type { SteamClient } from './steam/client.js';
import type { DiscordNotifier } from './discord/notifier.js';
import type { BotHandle } from './discord/bot.js';
import type { StatusPanel } from './discord/statusPanel.js';
import type { SteamGame } from './types/index.js';
import { Session } from './session.js';
import { Timers } from './timers.js';

// The Steam client surface the idler uses, so offline tests can hand in a fake
export type SteamLike = Pick<
  SteamClient,
  | 'isLoggedIn'
  | 'isConnected'
  | 'isConnecting'
  | 'isReconnecting'
  | 'isPlayingBlocked'
  | 'currentRefreshToken'
  | 'ownershipCacheComplete'
  | 'loginWithRefreshToken'
  | 'abortPendingConnect'
  | 'setGamesPlaying'
  | 'stopPlaying'
  | 'relog'
  | 'logout'
  | 'getOwnedGames'
  | 'getPlaytimeForever'
  | 'onDisconnected'
  | 'onLoggedOn'
  | 'onError'
  | 'onPlayingState'
  | 'onRefreshToken'
>;

// The notifier surface the idler uses, for the same reason
export type NotifierLike = Pick<DiscordNotifier, 'send' | 'botConfig' | 'isConfigured' | 'hasFile' | 'reload'>;

// Actions one module triggers in another without importing it (no import cycles)
export interface Actions {
  render(): void;
  shutdown(exitCode?: number): void;
}

// The shared context: one object passed to every module, so no module keeps
// its own copy of a guard flag.
export interface Runtime {
  readonly client: SteamLike;
  readonly discord: NotifierLike;
  readonly session: Session;
  readonly timers: Timers;
  readonly isHeadless: boolean;
  exit(code: number): void;
  accountName: string;
  library: { games: SteamGame[]; byId: Map<number, SteamGame> };
  // When idling started; null until then (was startTime)
  idlingStartedAt: Date | null;
  isIdling: boolean;
  // Disconnected or kicked: clocks frozen, restoreIdling re-sends the list
  isWaitingForResume: boolean;
  waitingReason: string;
  // The TTY selector is open and overwrites the selection when it closes
  isInEditMode: boolean;
  // Nothing repaints or changes state
  isShuttingDown: boolean;
  // True once a terminal 🛑 "stopped" message has been sent (give-up paths). A
  // 🛑 "paused" message does not count: a later quit still deserves its own.
  stopNotified: boolean;
  // Set immediately before a self-initiated relog (periodic flush or zombie
  // recovery). Suppresses the 🛑/▶️ Discord pair for the relog cycle; cleared in
  // restoreIdling once the session is back.
  selfInitiatedRelog: boolean;
  botHandle: BotHandle | null;
  // The live status box in Discord; created in startIdling when a status channel is set
  statusPanel: StatusPanel | null;
  // Filled in by the wiring in index.ts
  actions: Actions;
}

// Builds the context with every guard off; the Steam client and notifier are
// passed in, never created here, so tests can use fakes.
export function createRuntime(deps: {
  client: SteamLike;
  discord: NotifierLike;
  isHeadless: boolean;
  exit?: (code: number) => void;
  now?: () => Date;
}): Runtime {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  return {
    client: deps.client,
    discord: deps.discord,
    session: new Session(deps.now),
    timers: new Timers(),
    isHeadless: deps.isHeadless,
    exit,
    accountName: '',
    library: { games: [], byId: new Map() },
    idlingStartedAt: null,
    isIdling: false,
    isWaitingForResume: false,
    waitingReason: '',
    isInEditMode: false,
    isShuttingDown: false,
    stopNotified: false,
    selfInitiatedRelog: false,
    botHandle: null,
    statusPanel: null,
    // Placeholders until the wiring replaces them
    actions: { render: () => {}, shutdown: () => {} },
  };
}

// True while idling games accrue no server-side playtime, so the display and
// daily report must not add the live delta.
export function isFrozen(rt: Runtime): boolean {
  return rt.isWaitingForResume || rt.session.blocked;
}
