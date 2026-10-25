import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';
import { createFakeClient } from './fake/steamClient.mjs';
import { createFakeNotifier } from './fake/notifier.mjs';

const { Flush } = await import(dist('steam/flush.js'));
const { createRuntime } = await import(dist('runtime.js'));

const T0 = Date.UTC(2026, 9, 25, 12);
const MIN = 60 * 1000;
const ZOMBIE_NOTICE = '⚠️ Zombie session — playtime not committing after a relog. Forcing reconnect.';

// Lets an awaited probe settle after a mocked timer fired it
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// An idling, connected session on fakes
function setup(games = [1, 2]) {
  const client = createFakeClient();
  const discord = createFakeNotifier();
  const rt = createRuntime({ client, discord, isHeadless: true });
  const byId = new Map(games.map((appid) => [appid, { appid, name: `g${appid}`, playtime_forever: 0, source: 'owned' }]));
  rt.library = { games: [...byId.values()], byId };
  rt.session.start(games.map((appid) => ({ appid, name: `g${appid}` })), byId, false);
  rt.idlingStartedAt = new Date();
  rt.isIdling = true;
  return { client, discord, rt, flush: new Flush(rt) };
}

test('flush relog only when connected and idle', async () => {
  const { rt, client, flush } = setup();
  flush.start();
  assert.equal(rt.timers.has('flush'), true);
  assert.equal(rt.timers.has('zombie'), true);
  // One 4-hour window; the relog's restoreIdling would clear the flag
  const window = async () => {
    mock.timers.tick(4 * 60 * MIN);
    await settle();
    rt.selfInitiatedRelog = false;
  };

  await window();
  assert.equal(client.relogs, 1);

  client.isConnected = false;
  await window();
  assert.equal(client.relogs, 1, 'not while disconnected');
  client.isConnected = true;

  rt.isWaitingForResume = true;
  await window();
  assert.equal(client.relogs, 1, 'not while waiting for resume');
  rt.isWaitingForResume = false;

  rt.isInEditMode = true;
  await window();
  assert.equal(client.relogs, 1, 'not while the selector is open');
  rt.isInEditMode = false;

  rt.session.setBlocked(true, 99, { bank: true, restartClocks: true });
  await window();
  assert.equal(client.relogs, 1, 'not while another session plays');
  rt.session.setBlocked(false, 99, { bank: true, restartClocks: true });

  await window();
  assert.equal(client.relogs, 2);

  // A relog already in flight is not started twice
  rt.selfInitiatedRelog = true;
  flush.forceRelog();
  assert.equal(client.relogs, 2);
  rt.selfInitiatedRelog = false;

  rt.session.apply([], rt.library.byId);
  await window();
  assert.equal(client.relogs, 2, 'not with nothing to idle');
});

test('two flat probes: relog, then zombie notice', async () => {
  const { rt, client, discord, flush } = setup();
  client.playtimeImpl = async () => 100;

  await flush.runZombieCheck();
  assert.equal(client.relogs, 0, 'the first probe only sets the baseline');

  mock.timers.tick(90 * MIN);
  await flush.runZombieCheck();
  assert.equal(client.relogs, 1, 'first flat probe forces a flush relog');
  assert.equal(rt.selfInitiatedRelog, true);
  assert.deepEqual(discord.sent, []);
  rt.selfInitiatedRelog = false;

  mock.timers.tick(90 * MIN);
  await flush.runZombieCheck();
  assert.equal(client.relogs, 2);
  assert.deepEqual(discord.sent, [ZOMBIE_NOTICE]);
  assert.deepEqual(client.probes, [1, 1, 1]);
});

test('resetBaseline clears strikes', async () => {
  const { rt, client, discord, flush } = setup();
  client.playtimeImpl = async () => 100;

  await flush.runZombieCheck();
  await flush.runZombieCheck();
  assert.equal(client.relogs, 1);
  rt.selfInitiatedRelog = false;

  // A block came and went: the next probe starts a fresh baseline
  flush.resetBaseline();
  await flush.runZombieCheck();
  assert.equal(client.relogs, 1);
  await flush.runZombieCheck();
  assert.equal(client.relogs, 2, 'a first strike again, not a zombie');
  assert.deepEqual(discord.sent, []);
});

test('unprobeable app is skipped next time', async () => {
  const { client, flush } = setup([1, 2]);
  let climbing = 50;
  client.playtimeImpl = async (appid) => (appid === 1 ? null : climbing++);

  await flush.runZombieCheck();
  await flush.runZombieCheck();
  await flush.runZombieCheck();
  assert.deepEqual(client.probes, [1, 2, 2]);
  assert.equal(client.relogs, 0);
});

test('a zombie check finishing after shutdown does not re-arm', async () => {
  const { rt, client, flush } = setup();
  let answer;
  client.playtimeImpl = () => new Promise((resolve) => { answer = resolve; });
  flush.start();
  mock.timers.tick(90 * MIN);
  await settle();
  assert.deepEqual(client.probes, [1]);

  // The user quits while the probe is in flight, then it answers
  rt.isShuttingDown = true;
  rt.timers.clearAll();
  answer(100);
  await settle();
  assert.equal(rt.timers.has('zombie'), false);
});
