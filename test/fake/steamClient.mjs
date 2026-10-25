// Offline stand-in for our SteamClient wrapper (the SteamLike surface in runtime.ts):
// flags the test sets by hand, recorded calls, and handlers the test fires itself.
export function createFakeClient(over = {}) {
  const handlers = { disconnected: [], loggedOn: [], error: [], playingState: [], refreshToken: [] };
  const client = {
    isLoggedIn: true,
    isConnected: true,
    isConnecting: false,
    isReconnecting: false,
    isPlayingBlocked: false,
    currentRefreshToken: null,
    ownershipCacheComplete: true,

    // Recorded calls
    gamesPlayed: [],
    relogs: 0,
    logouts: 0,
    logins: [],
    aborts: 0,
    stops: 0,
    probes: [],

    // Replace these to script a login or a playtime probe
    loginImpl: async () => {},
    playtimeImpl: async () => null,

    loginWithRefreshToken(refreshToken, accountName) {
      client.logins.push({ refreshToken, accountName });
      return client.loginImpl(refreshToken, accountName);
    },
    abortPendingConnect() {
      client.aborts += 1;
    },
    setGamesPlaying(appIds) {
      client.gamesPlayed.push([...appIds]);
    },
    stopPlaying() {
      client.stops += 1;
    },
    relog() {
      client.relogs += 1;
    },
    logout() {
      client.logouts += 1;
    },
    async getOwnedGames() {
      return [];
    },
    getPlaytimeForever(appid) {
      client.probes.push(appid);
      return client.playtimeImpl(appid);
    },

    onDisconnected(fn) {
      handlers.disconnected.push(fn);
    },
    onLoggedOn(fn) {
      handlers.loggedOn.push(fn);
    },
    onError(fn) {
      handlers.error.push(fn);
    },
    onPlayingState(fn) {
      handlers.playingState.push(fn);
    },
    onRefreshToken(fn) {
      handlers.refreshToken.push(fn);
    },

    emitDisconnected(eresult, msg) {
      for (const fn of handlers.disconnected) fn(eresult, msg);
    },
    emitLoggedOn() {
      for (const fn of handlers.loggedOn) fn();
    },
    emitError(err) {
      for (const fn of handlers.error) fn(err);
    },
    emitPlayingState(blocked, appid) {
      for (const fn of handlers.playingState) fn(blocked, appid);
    },
  };
  return Object.assign(client, over);
}
