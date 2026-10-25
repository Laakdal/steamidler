import SteamUser from 'steam-user';
import { LoginSession, EAuthTokenPlatformType } from 'steam-session';
import { MAX_IDLE_GAMES } from '../constants.js';
import { buildLibrary } from './library.js';
import type { SteamGame } from '../types/index.js';

// After a disconnect steam-user says it will retry, we leave the connection to
// it for this long. Its retry loop can stall without a word (a refused CM
// connection ends it, CM timeouts keep it busy for ever), so past this the app
// takes the connection back.
const SELF_RETRY_GRACE_MS = 5 * 60 * 1000;
// Upper bound on one logOn. A connection refused during auth can leave
// steam-user silent, and a headless start would wait on it for ever.
const LOGON_LIMIT_MS = 2 * 60 * 1000;
// How long the library waits for license data (the PICS ownership cache)
const LICENSE_WAIT_MS = 10_000;

// The one place the app talks to steam-user. It tracks what steam-user is
// doing (logged on, retrying, blocked by another session) from its events, so
// callers can ask before acting: several steam-user calls throw from inside
// process.nextTick when made at the wrong moment, and nothing can catch that.
export class SteamClient {
  private readonly user = new SteamUser({ enablePicsCache: true });
  private loggedIn = false;
  private account: string | null = null;
  private blocked = false;
  // The token this session runs on. Steam's renewal replaces it here first,
  // so a reconnect never depends on the copy on disk having been saved.
  private token: string | null = null;
  private tokenListener: ((token: string) => void) | null = null;
  private errorListener: ((err: Error) => void) | null = null;
  // When steam-user started its own reconnect; null when it is not retrying
  private selfRetryStartedAt: number | null = null;
  // Set just before a logOff of ours, so the disconnect that follows is not
  // read as steam-user reconnecting by itself
  private ownLogOff = false;
  private licensesReady = false;
  private licenseWait: Promise<boolean> | null = null;
  private libraryComplete = true;

  // steam-user's renewRefreshTokens option stays off on purpose: it awaits the
  // renewal in its logon handler with no catch, so a refusal from Steam would
  // become an unhandled rejection. renewToken() does the same job safely.
  constructor() {
    this.trackSession();
  }

  // Listeners attached once, for the client's whole life. They see every event,
  // including logons and disconnects from steam-user's own retries, which a
  // listener added per login call would miss. The 'error' one also guarantees
  // steam-user never emits 'error' with nobody listening, which would throw.
  private trackSession(): void {
    this.user.on('ownershipCached', () => {
      this.licensesReady = true;
    });

    this.user.on('loggedOn', () => {
      this.loggedIn = true;
      this.selfRetryStartedAt = null;
      // Only the games played are set; the Steam status stays the owner's choice
      void this.renewToken();
    });

    // steam-user reports 'disconnected' only when it means to reconnect by
    // itself, except in two cases where nothing follows: a logOff we asked for,
    // and its 4 s fallback when Steam never answered a logOff, which emits
    // (0, 'Logged off') without queueing a reconnect.
    this.user.on('disconnected', (eresult: number, msg: string) => {
      const unanswered = eresult === 0 && msg === 'Logged off';
      this.loggedIn = false;
      this.blocked = false;
      this.selfRetryStartedAt = this.ownLogOff || unanswered ? null : Date.now();
      this.ownLogOff = false;
    });

    this.user.on('error', (err: Error) => {
      this.loggedIn = false;
      this.blocked = false;
      this.selfRetryStartedAt = null;
      this.errorListener?.(err);
    });

    // Steam can report a block right after logon, before the app's own
    // playingState handler exists, so the flag is kept from the start
    this.user.on('playingState', (isBlocked: boolean) => {
      this.blocked = isBlocked;
    });
  }

  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  // steam-user holds a session right now, however it got one. This, not
  // isLoggedIn, decides whether logOn may be called.
  get isConnected(): boolean {
    return this.user.steamID != null;
  }

  // steam-user is reconnecting by itself and has not been at it for too long;
  // a logOn now would collide with it
  get isReconnecting(): boolean {
    if (this.isConnected || this.selfRetryStartedAt === null) return false;
    return Date.now() - this.selfRetryStartedAt < SELF_RETRY_GRACE_MS;
  }

  // steam-user's own "logon in flight" flag: the exact condition under which
  // logOn throws, so it is trusted over the event-based isReconnecting
  get isConnecting(): boolean {
    return this.user._connecting === true;
  }

  // Another device on the account is playing; Steam ignores our games meanwhile
  get isPlayingBlocked(): boolean {
    return this.blocked;
  }

  get accountName(): string | null {
    return this.account;
  }

  // False when the last library load gave up waiting for license data, so
  // family-shared games may be missing from it
  get ownershipCacheComplete(): boolean {
    return this.libraryComplete;
  }

  get currentRefreshToken(): string | null {
    return this.token;
  }

  // The raw steam-user instance, for tests
  get steamUser(): SteamUser {
    return this.user;
  }

  // Cancels a logon steam-user is stuck in. Without a session, logOff closes
  // the socket, clears its connecting flag and its retry timers at once and
  // emits nothing, so the next logOn starts clean. logout() would wrongly
  // expect a disconnect event.
  abortPendingConnect(): void {
    if (this.isConnected) return;
    this.user.logOff();
    this.selfRetryStartedAt = null;
  }

  // Asks Steam for a fresh refresh token after each logon, as the Steam client
  // does. Steam only issues one near expiry, and the old token dies with it, so
  // the new one is handed to the listener to save. The request has to go over
  // the CM connection (steam-user's session factory); steam-session's default
  // Web API route answers AccessDenied.
  private async renewToken(): Promise<void> {
    if (!this.token) return;
    const session = this.user._getLoginSession?.() ?? new LoginSession(EAuthTokenPlatformType.SteamClient);
    session.refreshToken = this.token;
    try {
      if (!(await session.renewRefreshToken()) || !session.refreshToken) return;
      const fresh = session.refreshToken;
      this.token = fresh;
      // steam-user's own reconnects and relog() log on with its stored details,
      // which would otherwise still carry the dead token
      if (this.user._logOnDetails) this.user._logOnDetails.access_token = fresh;
      this.tokenListener?.(fresh);
    } catch (err) {
      console.error(`Refresh token renewal failed: ${(err as Error).message}`);
    }
  }

  // Logs on with a refresh token. Refuses up front when steam-user already has
  // a session or a logon running (its own logOn would throw where nothing can
  // catch it), and gives up after LOGON_LIMIT_MS.
  loginWithRefreshToken(refreshToken: string, accountName?: string): Promise<void> {
    if (this.isConnected) return Promise.reject(new Error('Already logged on'));
    if (this.isConnecting) return Promise.reject(new Error('Logon already in progress'));

    this.token = refreshToken;
    return new Promise((resolve, reject) => {
      const done = (err?: Error): void => {
        clearTimeout(limit);
        this.user.removeListener('loggedOn', succeeded);
        this.user.removeListener('error', done);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      const succeeded = (): void => {
        this.loggedIn = true;
        if (accountName) this.account = accountName;
        done();
      };
      const limit = setTimeout(() => {
        this.abortPendingConnect();
        done(new Error('Logon timed out'));
      }, LOGON_LIMIT_MS);

      this.user.on('loggedOn', succeeded);
      this.user.on('error', done);
      this.user.logOn({ refreshToken });
    });
  }

  // The account's library: bought, free and family-shared games
  async getOwnedGames(): Promise<SteamGame[]> {
    const me = this.user.steamID;
    if (!this.loggedIn || !me) throw new Error('Not logged in');

    const { apps } = await this.user.getUserOwnedApps(me, { includePlayedFreeGames: true, includeFreeSub: true });
    this.libraryComplete = await this.waitForLicenses();
    if (!this.libraryComplete) {
      console.error(
        'License data did not arrive in time — family-shared games may be missing and free/paid tags may be off. Restart to retry.'
      );
    }

    const { licenses, picsCache } = this.user;
    const packages = picsCache?.packages;
    const data =
      licenses && packages
        ? { licenses, packages, appNames: (appid: number) => picsCache.apps?.[appid]?.appinfo?.common?.name }
        : null;
    return buildLibrary(apps, data, me.accountid);
  }

  // Resolves true once steam-user has the license data, or false after
  // LICENSE_WAIT_MS (it can be slow on big libraries). Concurrent callers share one wait.
  private waitForLicenses(): Promise<boolean> {
    if (this.licensesReady) return Promise.resolve(true);
    this.licenseWait ??= new Promise<boolean>((resolve) => {
      const arrived = (): void => {
        clearTimeout(giveUp);
        resolve(true);
      };
      const giveUp = setTimeout(() => {
        this.user.removeListener('ownershipCached', arrived);
        resolve(false);
      }, LICENSE_WAIT_MS);
      this.user.once('ownershipCached', arrived);
    });
    return this.licenseWait;
  }

  // Sends the list of games to play. Quietly does nothing while logged out:
  // these calls come from timers and events that can race a disconnect, and
  // the resume path sends the whole list again once the session is back.
  setGamesPlaying(appIds: number[]): void {
    if (!this.loggedIn || !this.isConnected) return;
    if (appIds.length > MAX_IDLE_GAMES) throw new Error(`Cannot idle more than ${MAX_IDLE_GAMES} games at once`);
    this.user.gamesPlayed(appIds);
  }

  // Clears the games being played
  stopPlaying(): void {
    if (this.isConnected) this.user.gamesPlayed([]);
  }

  // Logs off and straight back on. A clean logOff is what makes Steam commit
  // the playtime of the running session, and the fresh logon also replaces a
  // session that stopped working. The usual disconnect and logon handlers do the rest.
  relog(): void {
    if (!this.isConnected) throw new Error('Cannot relog: not connected');
    try {
      this.user.relog();
    } catch {
      // steam-user cannot relog without a token in its logon details. A plain
      // logOff still commits the playtime, and the app's resume path logs on
      // again with the saved token.
      this.ownLogOff = true;
      this.user.logOff();
    }
  }

  // The playtime Steam has committed for one app, used to spot a session whose
  // playtime stopped counting. null when Steam left the app out of its answer:
  // that means "unknown", never "no increase".
  async getPlaytimeForever(appid: number): Promise<number | null> {
    const me = this.user.steamID;
    if (!this.loggedIn || !me) throw new Error('Not logged in');
    const { apps } = await this.user.getUserOwnedApps(me, {
      filterAppids: [appid],
      includeAppInfo: false,
      includePlayedFreeGames: true,
      includeFreeSub: true,
    });
    return apps[0]?.playtime_forever ?? null;
  }

  // Ends the session for good (quit, or a token Steam no longer accepts)
  logout(): void {
    this.ownLogOff = true;
    this.user.logOff();
    this.loggedIn = false;
    this.account = null;
  }

  onDisconnected(listener: (eresult: number, msg: string) => void): void {
    this.user.on('disconnected', listener);
  }

  // Steam renewed the refresh token: the old one no longer works, so this must save it
  onRefreshToken(listener: (token: string) => void): void {
    this.tokenListener = listener;
  }

  // Every logon, including steam-user's own reconnects
  onLoggedOn(listener: () => void): void {
    this.user.on('loggedOn', listener);
  }

  // Steam errors, forwarded by the listener trackSession attached at construction
  onError(listener: (err: Error) => void): void {
    this.errorListener = listener;
  }

  // Another session started or stopped playing on the account
  onPlayingState(listener: (blocked: boolean, playingApp: number) => void): void {
    this.user.on('playingState', listener);
  }
}
