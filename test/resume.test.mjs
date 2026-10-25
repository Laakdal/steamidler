import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dist, tempHome } from './helpers.mjs';
import { createFakeClient } from './fake/steamClient.mjs';
import { createFakeNotifier } from './fake/notifier.mjs';

// credentials.js fixes its path at import time
const home = tempHome();
const credentialsFile = path.join(home, '.steam-idler', 'credentials.json');

const { Resume } = await import(dist('steam/resume.js'));
const { Flush } = await import(dist('steam/flush.js'));
const { createRuntime, isFrozen } = await import(dist('runtime.js'));

const T0 = Date.UTC(2026, 9, 25, 12);
const SEC = 1000;
const MIN = 60 * SEC;

// A token shaped like a Steam refresh token, so loadCredentials keeps the file
const jwt = (payload) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');
const TOKEN = jwt({ iss: 'steam', aud: ['client'], sub: '76561197960287930' });

// Lets an awaited login or probe settle after a mocked timer fired it
const settle = () => new Promise((resolve) => setImmediate(resolve));
const never = () => new Promise(() => {});

beforeEach(() => {
  fs.writeFileSync(credentialsFile, JSON.stringify({ accountName: 'acct', refreshToken: TOKEN }));
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });
  // showError prints to the console; keep the test output clean
  mock.method(console, 'log', () => {});
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// An idling session wired as startIdling wires it, on fakes. Shutdown only records the exit code.
function setup(games = [1, 2]) {
  const client = createFakeClient();
  const discord = createFakeNotifier();
  const exits = [];
  const rt = createRuntime({ client, discord, isHeadless: true });
  rt.actions = { render: () => {}, shutdown: (code = 0) => exits.push(code) };
  const byId = new Map(games.map((appid) => [appid, { appid, name: `g${appid}`, playtime_forever: 0, source: 'owned' }]));
  rt.library = { games: [...byId.values()], byId };
  rt.session.start(games.map((appid) => ({ appid, name: `g${appid}` })), byId, false);
  rt.idlingStartedAt = new Date();
  rt.isIdling = true;
  const loop = {
    starts: 0,
    stops: 0,
    start() { loop.starts += 1; },
    stop() { loop.stops += 1; },
  };
  const flush = new Flush(rt);
  const resume = new Resume(rt, flush, loop);
  client.onLoggedOn(() => resume.onLoggedOn());
  return { client, discord, exits, rt, loop, resume };
}

test('disconnect enters waiting and freezes clocks', async () => {
  const { rt, client, loop, resume } = setup();
  mock.timers.tick(10 * MIN);
  client.isConnected = false;
  client.loginImpl = never;
  resume.enterWaiting('disconnected (NoConnection, eresult 3)');

  assert.equal(rt.isWaitingForResume, true);
  assert.equal(rt.waitingReason, 'disconnected (NoConnection, eresult 3)');
  assert.equal(isFrozen(rt), true);
  assert.equal(loop.stops, 1);
  assert.equal(rt.timers.has('resume'), true);
  for (const g of rt.session.idling) assert.equal(g.accumulatedMs, 10 * MIN);

  // Time passing and a second disconnect while waiting credit nothing
  mock.timers.tick(5 * MIN);
  await settle();
  resume.enterWaiting('disconnected again');
  assert.equal(rt.waitingReason, 'disconnected (NoConnection, eresult 3)');
  for (const g of rt.session.idling) {
    assert.equal(g.accumulatedMs, 10 * MIN);
    assert.equal(rt.session.gainedMs(g, isFrozen(rt)), 10 * MIN);
  }
  // The 60 s retry logged on with the stored token
  assert.deepEqual(client.logins, [{ refreshToken: TOKEN, accountName: 'acct' }]);
});

test("steam-user's own reconnect restores without a second logon", async () => {
  const { rt, client, loop, resume } = setup();
  client.isConnected = false;
  resume.enterWaiting('disconnected (NoConnection, eresult 3)');
  mock.timers.tick(20 * SEC);
  client.isConnected = true;
  client.emitLoggedOn();

  assert.equal(rt.isWaitingForResume, false);
  assert.equal(rt.waitingReason, '');
  assert.equal(rt.timers.has('resume'), false);
  assert.deepEqual(client.gamesPlayed, [[1, 2]]);
  assert.equal(loop.starts, 1);
  mock.timers.tick(10 * MIN);
  await settle();
  assert.equal(client.logins.length, 0);

  // The retry timer finding the client already connected restores too
  resume.enterWaiting('disconnected (Fail, eresult 2)');
  mock.timers.tick(60 * SEC);
  await settle();
  assert.equal(rt.isWaitingForResume, false);
  assert.equal(client.logins.length, 0);
  assert.deepEqual(client.gamesPlayed, [[1, 2], [1, 2]]);
});

test('terminal EResult 26 stops with exit 0 and a stop message', async () => {
  const { rt, client, discord, exits, resume } = setup();
  client.isConnected = false;
  client.loginImpl = async () => {
    throw Object.assign(new Error('Revoked'), { eresult: 26 });
  };
  resume.enterWaiting('disconnected (NoConnection, eresult 3)');
  mock.timers.tick(60 * SEC);
  await settle();

  assert.equal(client.logins.length, 1);
  assert.deepEqual(exits, [0]);
  assert.equal(rt.stopNotified, true);
  assert.ok(
    discord.sent.some((m) => /^🛑 Idling stopped — .*26.*\. Manual re-login required\.$/.test(m)),
    discord.sent.join('\n')
  );
  // A revoked token is dead: the next start goes straight to a fresh login
  assert.equal(fs.existsSync(credentialsFile), false);
  assert.equal(rt.timers.has('resume'), false);
});

test('rate limit waits at least 10 minutes and gives up after 10', async () => {
  mock.method(Math, 'random', () => 0);
  const { client, discord, exits, resume } = setup();
  client.isConnected = false;
  client.loginImpl = async () => {
    throw Object.assign(new Error('RateLimitExceeded'), { eresult: 84 });
  };
  resume.enterWaiting('disconnected (NoConnection, eresult 3)');
  mock.timers.tick(60 * SEC);
  await settle();
  assert.equal(client.logins.length, 1);

  for (let attempt = 2; attempt <= 10; attempt++) {
    assert.deepEqual(exits, []);
    mock.timers.tick(10 * MIN - 1);
    await settle();
    assert.equal(client.logins.length, attempt - 1, `no retry ${attempt} before 10 minutes`);
    mock.timers.tick(20 * MIN + 1);
    await settle();
    assert.equal(client.logins.length, attempt);
  }
  assert.deepEqual(exits, [1]);
  assert.ok(discord.sent.some((m) => m.startsWith('🛑 Idling stopped — rate-limited 10×')), discord.sent.join('\n'));
});

test('transient errors give up after 30', async () => {
  mock.method(Math, 'random', () => 0.999);
  const { client, discord, exits, resume } = setup();
  client.isConnected = false;
  client.loginImpl = async () => {
    throw new Error('ETIMEDOUT');
  };
  resume.enterWaiting('disconnected (NoConnection, eresult 3)');
  mock.timers.tick(60 * SEC);
  await settle();
  assert.equal(client.logins.length, 1);

  for (let attempt = 2; attempt <= 30; attempt++) {
    assert.deepEqual(exits, []);
    mock.timers.tick(15 * MIN);
    await settle();
    assert.equal(client.logins.length, attempt);
  }
  assert.deepEqual(exits, [1]);
  assert.ok(
    discord.sent.includes('🛑 Idling stopped — failed to reconnect after 30× (last error: ETIMEDOUT).'),
    discord.sent.join('\n')
  );
});

test('takeover retries after 5 minutes', async () => {
  const { client, resume } = setup();
  client.isConnected = false;
  client.loginImpl = never;
  resume.enterWaiting('player active on this account elsewhere', true);
  mock.timers.tick(5 * MIN - 1);
  await settle();
  assert.equal(client.logins.length, 0);
  mock.timers.tick(1);
  await settle();
  assert.equal(client.logins.length, 1);
});

test('a blip inside 30 s sends no paused notice', async () => {
  const { rt, client, discord, resume } = setup();
  client.isConnected = false;
  resume.enterWaiting('disconnected (NoConnection, eresult 3)');
  mock.timers.tick(20 * SEC);
  client.isConnected = true;
  client.emitLoggedOn();
  mock.timers.tick(5 * MIN);
  await settle();
  assert.equal(rt.isWaitingForResume, false);
  assert.deepEqual(discord.sent, []);
});

test('resumed notice waits 90 s and is cancelled by a new kick', async () => {
  const { client, discord, resume } = setup();
  client.loginImpl = never;
  const kick = () => {
    client.isConnected = false;
    resume.enterWaiting('player active on this account elsewhere', true);
  };
  const reconnect = () => {
    client.isConnected = true;
    client.emitLoggedOn();
  };

  kick();
  mock.timers.tick(30 * SEC);
  assert.deepEqual(discord.sent, ['⏸️ Idling paused — player active on this account elsewhere. Auto-retrying.']);
  mock.timers.tick(10 * SEC);
  reconnect();
  mock.timers.tick(89 * SEC);
  assert.equal(discord.sent.length, 1, 'no resumed notice before 90 s');

  // Kicked again inside the grace: the episode was announced, so no new pair
  kick();
  mock.timers.tick(10 * MIN);
  await settle();
  assert.equal(discord.sent.length, 1);

  reconnect();
  mock.timers.tick(90 * SEC);
  assert.deepEqual(discord.sent, [
    '⏸️ Idling paused — player active on this account elsewhere. Auto-retrying.',
    '▶️ Idling resumed after 13m — 2 games',
  ]);
});

test('restoreIdling after shutdown logs out', async () => {
  const { rt, client, discord, loop, resume } = setup();
  let land;
  client.loginImpl = () => new Promise((resolve) => { land = resolve; });
  client.isConnected = false;
  resume.enterWaiting('disconnected (NoConnection, eresult 3)');
  mock.timers.tick(60 * SEC);
  await settle();
  assert.equal(client.logins.length, 1);

  // The user quits while the login is in flight
  rt.isShuttingDown = true;
  rt.timers.clearAll();
  land();
  await settle();
  assert.equal(client.logouts, 1);
  assert.deepEqual(client.gamesPlayed, []);
  assert.equal(loop.starts, 0);
  assert.equal(rt.timers.has('resumeNotify'), false);

  // steam-user's own reconnect landing after the goodbye logs off as well
  client.isConnected = true;
  client.emitLoggedOn();
  assert.equal(client.logouts, 2);
  assert.deepEqual(client.gamesPlayed, []);
  assert.ok(!discord.sent.some((m) => m.startsWith('▶️') || m.startsWith('🔄')), discord.sent.join('\n'));
});
