import SteamUser from 'steam-user';
import { LoginSession, EAuthTokenPlatformType } from 'steam-session';
import { MAX_IDLE_GAMES } from '../constants.js';
import { buildLibrary } from './library.js';
import type { SteamGame } from '../types/index.js';

const LOGON_LIMIT_MS = 2 * 60 * 1000;
const SELF_RETRY_GRACE_MS = 5 * 60 * 1000;
const LICENSE_WAIT_MS = 10_000;

// steamidler's only door to steam-user. Several steam-user calls throw from
// inside process.nextTick when made at the wrong moment (logOn during a logon
// or a session), where no try/catch can reach. So this class follows
// steam-user's events to know its state, and its callers ask before they act.
export class SteamClient {
  private readonly user = new SteamUser({ enablePicsCache: true });
  private loggedIn = false;
  private account: string | null = null;
  private blocked = false;
  // Kept here first when Steam renews it, so a reconnect never depends on the
  // copy on disk having been saved
  private token: string | null = null;
  private tokenListener: ((token: string) => void) | null = null;
  private errorListener: ((err: Error) => void) | null = null;
  // Since when steam-user has been reconnecting by itself; null when it is not
  private selfRetryStartedAt: number | null = null;
  // Our own logOff is under way, so its disconnect is not a reconnect by steam-user
  private ownLogOff = false;
  private licensesReady = false;
  private licenseWait: Promise<boolean> | null = null;
  private libraryComplete = true;

  // Attaches the lifetime listeners before anything can emit
  constructor() {
    this.trackSession();
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  // Logs on with a refresh token. Refuses straight away when steam-user holds
  // a session or a logon (its logOn would throw out of reach), and gives up
  // after two minutes: a connection refused mid-auth can leave steam-user
  // silent, and a headless start would otherwise wait for ever.
  loginWithRefreshToken(refreshToken: string, accountName?: string): Promise<void> {
    if (this.isConnected) return Promise.reject(new Error('Already logged on'));
    if (this.isConnecting) return Promise.reject(new Error('Logon already in progress'));

    this.token = refreshToken;
    return new Promise((resolve, reject) => {
      const settle = (err: Error | null): void => {
        clearTimeout(limit);
        this.user.removeListener('loggedOn', onLoggedOn);
        this.user.removeListener('error', onError);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      const onLoggedOn = (): void => {
        this.loggedIn = true;
        if (accountName) this.account = accountName;
        settle(null);
      };
      // steam-user re-emits whatever a handler threw, which need not be an Error
      const onError = (err?: Error): void => settle(err ?? new Error('Steam error'));
      const limit = setTimeout(() => {
        this.abortPendingConnect();
        settle(new Error('Logon timed out'));
      }, LOGON_LIMIT_MS);

      this.user.on('loggedOn', onLoggedOn);
      this.user.on('error', onError);
      this.user.logOn({ refreshToken });
    });
  }

  // Cancels a logon steam-user is stuck in. With no session, logOff shuts the
  // socket, clears its connecting flag and retry timers on the spot and emits
  // nothing, so the next logOn starts clean (logout() would wait for an event).
  abortPendingConnect(): void {
    if (this.isConnected) return;
    this.user.logOff();
    this.selfRetryStartedAt = null;
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

  // What Steam has committed for one app, read to catch a session whose
  // playtime stopped counting. null when Steam leaves the app out: unknown,
  // never "no increase".
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

  // Sends the games to play. Does nothing while logged out: timers and events
  // that call this can race a disconnect, and the resume path sends the whole
  // list again when the session is back.
  setGamesPlaying(appIds: number[]): void {
    if (!this.loggedIn || !this.isConnected) return;
    if (appIds.length > MAX_IDLE_GAMES) throw new Error(`Cannot idle more than ${MAX_IDLE_GAMES} games at once`);
    this.user.gamesPlayed(appIds);
  }

  // Clears the games being played
  stopPlaying(): void {
    if (this.isConnected) this.user.gamesPlayed([]);
  }

  // Off and straight back on. Steam commits a session's playtime when it ends
  // cleanly, and the new logon replaces a session that went stale; the normal
  // disconnect and logon handlers do the rest.
  relog(): void {
    if (!this.isConnected) throw new Error('Cannot relog: not connected');
    try {
      this.user.relog();
    } catch {
      // No token in steam-user's logon details: a plain logOff still commits,
      // and the resume path logs on again with the saved token
      this.ownLogOff = true;
      this.user.logOff();
    }
  }

  // Ends the session for good: quit, or a token Steam no longer accepts
  logout(): void {
    this.ownLogOff = true;
    this.user.logOff();
    this.loggedIn = false;
    this.account = null;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  // Logged on as far as this class has seen
  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  // steam-user holds a session, however it got one: the test for whether a
  // logOn would collide
  get isConnected(): boolean {
    return this.user.steamID != null;
  }

  // steam-user is reconnecting by itself and has not been at it too long. Its
  // retry loop can stall silently (a refused CM connection ends it, CM
  // timeouts keep it busy), so after SELF_RETRY_GRACE_MS the app takes over.
  get isReconnecting(): boolean {
    if (this.isConnected || this.selfRetryStartedAt === null) return false;
    return Date.now() - this.selfRetryStartedAt < SELF_RETRY_GRACE_MS;
  }

  // steam-user's private "logon in flight" flag, the exact condition under
  // which its logOn throws; trusted over the event-based isReconnecting
  get isConnecting(): boolean {
    return this.user._connecting === true;
  }

  // Another device on the account is playing, and Steam ignores our games meanwhile
  get isPlayingBlocked(): boolean {
    return this.blocked;
  }

  // The account of the last successful logon, until logout
  get accountName(): string | null {
    return this.account;
  }

  // False when the last library load gave up waiting for license data, so
  // family-shared games may be missing
  get ownershipCacheComplete(): boolean {
    return this.libraryComplete;
  }

  // The token the live session runs on (renewed in place)
  get currentRefreshToken(): string | null {
    return this.token;
  }

  // The raw steam-user instance, for tests
  get steamUser(): SteamUser {
    return this.user;
  }

  // ── Event registration ────────────────────────────────────────────────────

  // Every disconnect, ours and steam-user's
  onDisconnected(listener: (eresult: number, msg: string) => void): void {
    this.user.on('disconnected', listener);
  }

  // Steam renewed the refresh token: the old one no longer works, so this must save it
  onRefreshToken(listener: (token: string) => void): void {
    this.tokenListener = listener;
  }

  // Every logon, steam-user's own reconnects included
  onLoggedOn(listener: () => void): void {
    this.user.on('loggedOn', listener);
  }

  // Steam errors, passed on by the listener trackSession attached at construction
  onError(listener: (err: Error) => void): void {
    this.errorListener = listener;
  }

  // Another device started or stopped playing on the account
  onPlayingState(listener: (blocked: boolean, playingApp: number) => void): void {
    this.user.on('playingState', listener);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  // Listeners for the client's whole life. Unlike one added per login call,
  // they also see the logons and disconnects of steam-user's own retries. The
  // 'error' one means steam-user never emits 'error' to nobody, which throws.
  private trackSession(): void {
    this.user.on('ownershipCached', () => {
      this.licensesReady = true;
    });

    // The Steam status is never set: only the games played, the rest stays the owner's
    this.user.on('loggedOn', () => {
      this.loggedIn = true;
      this.selfRetryStartedAt = null;
      void this.renewToken();
    });

    // A 'disconnected' from steam-user means it will reconnect by itself, with
    // two exceptions where nothing follows: our own logOff, and the (0,
    // 'Logged off') it emits after 4 s when Steam never answered a logOff.
    this.user.on('disconnected', (eresult: number, msg: string) => {
      const answeredNever = eresult === 0 && msg === 'Logged off';
      this.loggedIn = false;
      this.blocked = false;
      this.selfRetryStartedAt = this.ownLogOff || answeredNever ? null : Date.now();
      this.ownLogOff = false;
    });

    this.user.on('error', (err: Error) => {
      this.loggedIn = false;
      this.blocked = false;
      this.selfRetryStartedAt = null;
      this.errorListener?.(err);
    });

    // Kept from the start: Steam can report a block right after logon, before
    // the app has its own playingState handler
    this.user.on('playingState', (isBlocked: boolean) => {
      this.blocked = isBlocked;
    });
  }

  // Asks Steam for a fresh refresh token after each logon, as the Steam client
  // does. Steam issues one only near expiry, and the old token dies with it, so
  // the new one goes to the listener to be saved. The request must travel over
  // the CM connection (steam-user's session factory); steam-session's default
  // Web API route is refused with AccessDenied. steam-user's own
  // renewRefreshTokens option is off because it awaits this with no catch.
  private async renewToken(): Promise<void> {
    if (!this.token) return;
    const session = this.user._getLoginSession?.() ?? new LoginSession(EAuthTokenPlatformType.SteamClient);
    session.refreshToken = this.token;
    try {
      if (!(await session.renewRefreshToken()) || !session.refreshToken) return;
      const fresh = session.refreshToken;
      this.token = fresh;
      // steam-user's own reconnects and relog() reuse its stored logon details
      if (this.user._logOnDetails) this.user._logOnDetails.access_token = fresh;
      this.tokenListener?.(fresh);
    } catch (err) {
      console.error(`Refresh token renewal failed: ${(err as Error).message}`);
    }
  }

  // True once steam-user has the license data, or false after LICENSE_WAIT_MS
  // (big libraries can be slow). Callers at the same time share one wait.
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
}
