import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';
import { createFakeClient } from './fake/steamClient.mjs';
import { createFakeNotifier } from './fake/notifier.mjs';

const { createShutdown } = await import(dist('shutdown.js'));
const { createRuntime } = await import(dist('runtime.js'));

const T0 = Date.UTC(2026, 9, 25, 12);
const SECRET = 'bot-token-SECRET.abc';

// Lets the Promise.all / stopBot / exit chain run after a mocked timer fired
const settle = () => new Promise((resolve) => setImmediate(resolve));
const never = () => new Promise(() => {});

let logged;

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });
  logged = [];
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', (...parts) => logged.push(parts.join(' ')));
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// An idling session on fakes; exit only records its code.
function setup({ idling = true } = {}) {
  const client = createFakeClient();
  const discord = createFakeNotifier();
  const exits = [];
  const rt = createRuntime({ client, discord, isHeadless: true, exit: (code) => exits.push(code) });
  if (idling) {
    rt.idlingStartedAt = new Date();
    rt.isIdling = true;
  }
  const handlers = createShutdown(rt);
  rt.actions = { render: () => {}, shutdown: handlers.handleShutdown, saveSelection: () => {} };
  return { rt, client, discord, exits, ...handlers };
}

test('shutdown clears every timer and exits after 1500 ms', async () => {
  const { rt, client, discord, exits, handleShutdown } = setup();
  const names = ['display', 'resume', 'resumeNotify', 'pauseNotify', 'midnight', 'flush', 'zombie', 'takeoverDrift'];
  const fired = [];
  for (const name of names) rt.timers.timeout(name, () => fired.push(name), 1000);
  rt.timers.interval('display', () => fired.push('display'), 60_000);

  handleShutdown(0);
  for (const name of names) assert.equal(rt.timers.has(name), false, `${name} cleared`);
  assert.equal(rt.isShuttingDown, true);
  assert.equal(rt.isIdling, false);
  assert.equal(client.stops, 1);
  assert.equal(client.logouts, 1);
  assert.deepEqual(discord.sent, ['🛑 Idling stopped — quit by user']);

  // A second signal is ignored
  handleShutdown(1);
  assert.equal(client.logouts, 1);

  mock.timers.tick(1499);
  await settle();
  assert.deepEqual(exits, []);
  mock.timers.tick(1);
  await settle();
  assert.deepEqual(exits, [0]);
  mock.timers.tick(120_000);
  assert.deepEqual(fired, [], 'no cleared timer fires');
});

test('shutdown waits for a slow Discord send, then a stuck bot destroy is capped at 1 s', async () => {
  const { rt, discord, exits, handleShutdown } = setup();
  discord.send = (text) => {
    discord.sent.push(text);
    return new Promise((resolve) => setTimeout(resolve, 8000));
  };
  let destroyed = 0;
  rt.botHandle = { destroy: () => { destroyed += 1; return never(); } };

  handleShutdown(1);
  mock.timers.tick(7999);
  await settle();
  assert.equal(destroyed, 0, 'the bot stays up until the final message went out');
  mock.timers.tick(1);
  await settle();
  assert.equal(destroyed, 1);
  mock.timers.tick(999);
  await settle();
  assert.deepEqual(exits, []);
  mock.timers.tick(1);
  await settle();
  assert.deepEqual(exits, [1], 'exit at 9000 ms: 8000 send, then the 1000 cap');
});

test('crash exits 1 after 2000 ms with the message redacted', async () => {
  const { rt, client, discord, exits, handleCrash } = setup();
  discord.botConfig = () => ({ token: SECRET });

  handleCrash(new Error(`request to https://discord.com/api/v10/x failed with ${SECRET}`));
  assert.equal(rt.isShuttingDown, true);
  assert.equal(client.stops, 1);
  assert.equal(client.logouts, 1);

  assert.equal(logged.length, 1);
  assert.ok(logged[0].startsWith('\nFatal error:'));
  assert.ok(logged[0].includes('<token>') && logged[0].includes('<url>'));
  assert.ok(!logged[0].includes(SECRET) && !logged[0].includes('discord.com'));
  assert.deepEqual(discord.sent, ['🛑 Idling stopped — crashed (request to <url> failed with <token>).']);

  mock.timers.tick(1999);
  await settle();
  assert.deepEqual(exits, []);
  mock.timers.tick(1);
  await settle();
  assert.deepEqual(exits, [1]);
});

test('crash before idling says it crashed before idling started', async () => {
  const { client, discord, exits, handleCrash } = setup({ idling: false });

  handleCrash('boom');
  assert.equal(client.stops, 0, 'nothing was being played');
  assert.deepEqual(discord.sent, ['🛑 steamidler crashed before idling started (boom).']);
  mock.timers.tick(2000);
  await settle();
  assert.deepEqual(exits, [1]);
});

test('a discord.js library rejection is ignored', async () => {
  const { rt, discord, exits, handleRejection } = setup();
  discord.botConfig = () => ({ token: SECRET });
  const libraryError = new Error(`gateway hiccup ${SECRET}`);
  libraryError.stack = `Error: gateway hiccup ${SECRET}\n    at WebSocketShard.x (/opt/app/node_modules/@discordjs/ws/dist/index.js:1:1)`;

  handleRejection(libraryError);
  mock.timers.tick(10_000);
  await settle();
  assert.equal(rt.isShuttingDown, false);
  assert.deepEqual(exits, []);
  assert.deepEqual(discord.sent, []);
  assert.equal(logged.length, 1);
  assert.ok(logged[0].startsWith('[discord] ignored a library error:'));
  assert.ok(!logged[0].includes(SECRET));

  // Anything else is a real crash
  handleRejection(new Error('ours'));
  assert.equal(rt.isShuttingDown, true);
  mock.timers.tick(2000);
  await settle();
  assert.deepEqual(exits, [1]);
});
