// Offline tests for src/steam/client.ts: steam-user and steam-session are replaced by fakes.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';

const { SteamClient } = await import(dist('steam/client.js'));

const OWN = 1000;
const FAMILY = 2000;

// A client whose fake steam-user holds a session for account OWN
function connectedClient() {
  const client = new SteamClient();
  const user = client.steamUser;
  user.steamID = { accountid: OWN };
  user.emit('loggedOn');
  return { client, user };
}

// Gives the fake steam-user a license list, a PICS package cache and an owned-apps answer
function stockLibrary(user, { licenses, packages, apps = {}, owned }) {
  user.licenses = licenses;
  user.picsCache = { packages, apps };
  user.getUserOwnedApps = async (_id, opts) => ({
    apps: opts.filterAppids ? owned.filter((a) => opts.filterAppids.includes(a.appid)) : owned,
  });
  user.emit('ownershipCached');
}

test('logon does not change the Steam status', () => {
  const client = new SteamClient();
  client.steamUser.emit('loggedOn');
  assert.equal(client.steamUser.personaCalls.length, 0);
});

test('logging on while a session exists is refused before steam-user can throw', async () => {
  const { client, user } = connectedClient();
  await assert.rejects(client.loginWithRefreshToken('t', 'alice'), /Already logged on/);
  assert.equal(user.logOnCalls.length, 0);
});

test('logging on while steam-user is still connecting is refused', async () => {
  const client = new SteamClient();
  client.steamUser._connecting = true;
  await assert.rejects(client.loginWithRefreshToken('t', 'alice'), /in progress/);
  assert.equal(client.steamUser.logOnCalls.length, 0);
});

test('a logon resolves on loggedOn and records the account', async () => {
  const client = new SteamClient();
  const p = client.loginWithRefreshToken('tok', 'alice');
  assert.deepEqual(client.steamUser.logOnCalls, [{ refreshToken: 'tok' }]);
  client.steamUser.emit('loggedOn');
  await p;
  assert.equal(client.isLoggedIn, true);
  assert.equal(client.accountName, 'alice');
  assert.equal(client.currentRefreshToken, 'tok');
});

test('a logon rejects with the steam-user error', async () => {
  const client = new SteamClient();
  client.onError(() => {});
  const p = client.loginWithRefreshToken('tok', 'alice');
  client.steamUser.emit('error', Object.assign(new Error('Expired'), { eresult: 27 }));
  await assert.rejects(p, /Expired/);
});

test('an error event without an error object still fails the logon', async () => {
  const client = new SteamClient();
  client.onError(() => {});
  const p = client.loginWithRefreshToken('tok', 'alice');
  client.steamUser.emit('error', undefined);
  await assert.rejects(p);
  assert.equal(client.accountName, null);
});

test('a logon steam-user abandons times out after two minutes and tears the attempt down', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const client = new SteamClient();
    const p = client.loginWithRefreshToken('tok', 'alice');
    mock.timers.tick(2 * 60 * 1000 - 1);
    let settled = false;
    p.catch(() => {}).finally(() => (settled = true));
    await Promise.resolve();
    assert.equal(settled, false);
    mock.timers.tick(1);
    await assert.rejects(p, /timed out/);
    assert.equal(client.steamUser.logOffCalls, 1);
  } finally {
    mock.timers.reset();
  }
});

test('the library tags owned, free and family-shared games', async () => {
  const { client, user } = connectedClient();
  stockLibrary(user, {
    licenses: [
      { owner_id: OWN, package_id: 1 }, // paid package: app 10
      { owner_id: OWN, package_id: 2 }, // free package: app 20
      { owner_id: OWN, package_id: 3 }, // free package also holding app 10
      { owner_id: FAMILY, package_id: 4 }, // family package: apps 30 and 40
    ],
    packages: {
      1: { packageinfo: { appids: [10], billingtype: 1 } },
      2: { packageinfo: { appids: [20], billingtype: 12 } },
      3: { packageinfo: { appids: [10], billingtype: 0 } },
      4: { packageinfo: { appids: [30, 40], billingtype: 1 } },
    },
    apps: { 40: { appinfo: { common: { name: 'Shared Forty' } } } },
    owned: [
      { appid: 10, name: 'Paid', playtime_forever: 5 },
      { appid: 20, name: 'Free', playtime_forever: 0 },
      { appid: 30, name: '', playtime_forever: 7 },
      { appid: 50, name: 'No license info' },
    ],
  });
  const games = await client.getOwnedGames();
  assert.deepEqual(games, [
    { appid: 10, name: 'Paid', playtime_forever: 5, source: 'owned' },
    { appid: 20, name: 'Free', playtime_forever: 0, source: 'free' },
    { appid: 30, name: 'App 30', playtime_forever: 7, source: 'shared' },
    { appid: 50, name: 'No license info', playtime_forever: 0, source: 'owned' },
    { appid: 40, name: 'Shared Forty', playtime_forever: 0, source: 'shared' },
  ]);
  assert.equal(client.ownershipCacheComplete, true);
});

for (const billingtype of [0, 3, 5, 12]) {
  test(`billing type ${billingtype} alone counts as free`, async () => {
    const { client, user } = connectedClient();
    stockLibrary(user, {
      licenses: [{ owner_id: OWN, package_id: 1 }],
      packages: { 1: { packageinfo: { appids: [10], billingtype } } },
      owned: [{ appid: 10, name: 'G', playtime_forever: 0 }],
    });
    assert.equal((await client.getOwnedGames())[0].source, 'free');
  });
}

test('license data that never arrives gives an incomplete library after 10 s', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const original = console.error;
  console.error = () => {};
  try {
    const { client, user } = connectedClient();
    user.getUserOwnedApps = async () => ({ apps: [{ appid: 10, name: 'G', playtime_forever: 1 }] });
    const p = client.getOwnedGames();
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(10_000);
    const games = await p;
    assert.deepEqual(games, [{ appid: 10, name: 'G', playtime_forever: 1, source: 'owned' }]);
    assert.equal(client.ownershipCacheComplete, false);
  } finally {
    console.error = original;
    mock.timers.reset();
  }
});

test('the library and playtime probe refuse while logged out', async () => {
  const client = new SteamClient();
  await assert.rejects(client.getOwnedGames(), /Not logged in/);
  await assert.rejects(client.getPlaytimeForever(10), /Not logged in/);
});

test('the playtime probe returns the app playtime, or null when Steam leaves it out', async () => {
  const { client, user } = connectedClient();
  stockLibrary(user, { licenses: [], packages: {}, owned: [{ appid: 10, name: 'G', playtime_forever: 42 }] });
  assert.equal(await client.getPlaytimeForever(10), 42);
  assert.equal(await client.getPlaytimeForever(99), null);
});

test('setting games is a no-op while logged out and refuses more than 32', () => {
  const offline = new SteamClient();
  offline.setGamesPlaying([1]);
  assert.equal(offline.steamUser.gamesPlayedCalls.length, 0);

  const { client, user } = connectedClient();
  client.setGamesPlaying([1, 2]);
  assert.deepEqual(user.gamesPlayedCalls, [[1, 2]]);
  assert.throws(() => client.setGamesPlaying(Array.from({ length: 33 }, (_, i) => i)), /32/);
  client.stopPlaying();
  assert.deepEqual(user.gamesPlayedCalls.at(-1), []);
});

test('a disconnect steam-user will retry on its own counts as reconnecting', () => {
  const { client, user } = connectedClient();
  user.steamID = null;
  user.emit('disconnected', 3, 'NoConnection');
  assert.equal(client.isLoggedIn, false);
  assert.equal(client.isReconnecting, true);
});

test('an unanswered logOff (0, "Logged off") leaves the reconnect to the app', () => {
  const { client, user } = connectedClient();
  user.steamID = null;
  user.emit('disconnected', 0, 'Logged off');
  assert.equal(client.isReconnecting, false);
});

test('a relog steam-user cannot do falls back to a plain logOff that is not a pending reconnect', () => {
  const { client, user } = connectedClient();
  user.relog = () => {
    throw new Error('no access token');
  };
  client.relog();
  assert.equal(user.logOffCalls, 1);
  user.steamID = null;
  user.emit('disconnected', 3, 'NoConnection');
  assert.equal(client.isReconnecting, false);
});

test('relog refuses without a session', () => {
  const client = new SteamClient();
  assert.throws(() => client.relog(), /not connected/);
});

test('logout clears the account and does not count as reconnecting', () => {
  const { client, user } = connectedClient();
  client.logout();
  assert.equal(client.accountName, null);
  assert.equal(client.isLoggedIn, false);
  user.steamID = null;
  user.emit('disconnected', 3, 'NoConnection');
  assert.equal(client.isReconnecting, false);
});

test('an error with no app handler yet does not crash, and clears the state', () => {
  const { client, user } = connectedClient();
  user.emit('playingState', true, 730);
  assert.equal(client.isPlayingBlocked, true);
  user.emit('error', new Error('LoggedInElsewhere'));
  assert.equal(client.isLoggedIn, false);
  assert.equal(client.isPlayingBlocked, false);
});

test('a renewed refresh token is handed over and replaces the one steam-user relogs with', async () => {
  const client = new SteamClient();
  const user = client.steamUser;
  const saved = [];
  client.onRefreshToken((t) => saved.push(t));
  user._logOnDetails = { access_token: 'old' };
  user._getLoginSession = () => ({
    refreshToken: null,
    async renewRefreshToken() {
      this.refreshToken = 'new';
      return true;
    },
  });
  const p = client.loginWithRefreshToken('old', 'alice');
  user.emit('loggedOn');
  await p;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(saved, ['new']);
  assert.equal(client.currentRefreshToken, 'new');
  assert.equal(user._logOnDetails.access_token, 'new');
});

test('a failed renewal logs only the message and keeps the old token', async () => {
  const client = new SteamClient();
  const user = client.steamUser;
  const lines = [];
  const original = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    user._getLoginSession = () => ({
      async renewRefreshToken() {
        throw new Error('AccessDenied');
      },
    });
    const p = client.loginWithRefreshToken('old', 'alice');
    user.emit('loggedOn');
    await p;
    await new Promise((r) => setImmediate(r));
  } finally {
    console.error = original;
  }
  assert.equal(client.currentRefreshToken, 'old');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('AccessDenied'));
  assert.ok(!lines[0].includes('old'));
});
