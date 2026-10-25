// Type declarations for the untyped libraries, limited to what steamidler calls.

declare module 'qrcode-terminal' {
  // Prints the QR code for `text` to stdout; small uses half-height blocks
  export function generate(text: string, options?: { small?: boolean }): void;
}

declare module 'steam-user' {
  import { EventEmitter } from 'events';

  // The fields of a steamid SteamID object we read. The steamid package is not a
  // direct dependency, and an import that cannot resolve would quietly become any.
  interface AccountSteamID {
    accountid: number;
  }

  interface OwnedAppsQuery {
    includePlayedFreeGames?: boolean;
    includeFreeSub?: boolean;
    includeAppInfo?: boolean;
    filterAppids?: number[];
  }

  interface OwnedAppsAnswer {
    apps: { appid: number; name?: string; playtime_forever?: number }[];
  }

  interface PicsCacheData {
    apps?: Record<number, { appinfo?: { common?: { name?: string } } } | undefined>;
    packages?: Record<number, { packageinfo?: { appids?: number[]; billingtype?: number } | null } | undefined>;
  }

  interface Events {
    loggedOn: () => void;
    disconnected: (eresult: number, msg: string) => void;
    error: (err: Error & { eresult?: number }) => void;
    playingState: (blocked: boolean, playingApp: number) => void;
    ownershipCached: () => void;
  }

  class SteamUser extends EventEmitter {
    constructor(options?: { enablePicsCache?: boolean });

    // Number to name, for readable error labels
    static EResult: Record<number, string>;

    steamID: AccountSteamID | null;
    licenses?: { owner_id: number; package_id: number }[];
    picsCache: PicsCacheData;

    // Private steam-user state the app has to read or patch (lib/components):
    // true from logOn() until the logon settles; logOn() throws while it is set,
    // and some retry paths keep it set without emitting anything.
    _connecting?: boolean;
    // The details its own reconnects log on with; a renewed token goes here.
    _logOnDetails?: { access_token?: string };
    // A LoginSession bound to the CM connection, the only route on which Steam
    // renews a SteamClient refresh token.
    _getLoginSession?(): import('steam-session').LoginSession;

    on<E extends keyof Events>(event: E, listener: Events[E]): this;
    once<E extends keyof Events>(event: E, listener: Events[E]): this;
    removeListener<E extends keyof Events>(event: E, listener: Events[E]): this;

    logOn(details: { refreshToken: string }): void;
    logOff(): void;
    relog(): void;
    gamesPlayed(appIds: number[]): void;
    getUserOwnedApps(steamID: AccountSteamID, query?: OwnedAppsQuery): Promise<OwnedAppsAnswer>;
  }

  export = SteamUser;
}
