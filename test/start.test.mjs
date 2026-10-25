import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dist, tempHome } from './helpers.mjs';
import { createFakeClient } from './fake/steamClient.mjs';
import { createFakeNotifier } from './fake/notifier.mjs';

// credentials.js and favorites.js fix their paths at import time
const home = tempHome();
const configDir = path.join(home, '.steam-idler');
const credentialsFile = path.join(configDir, 'credentials.json');
const favoritesFile = path.join(configDir, 'favorites-acct.json');

const { runHeadless, startIdling } = await import(dist('start.js'));
const { parseArgs } = await import(dist('cli.js'));
const { createRuntime } = await import(dist('runtime.js'));
const { StatusView } = await import(dist('ui/statusView.js'));
const { DailyReport } = await import(dist('notifications/dailyReport.js'));
const { createShutdown } = await import(dist('shutdown.js'));
const { Flush } = await import(dist('steam/flush.js'));
const { Resume, RATE_LIMIT_MIN_WAIT_MS } = await import(dist('steam/resume.js'));
const { createEditMode } = await import(dist('ui/keyboard.js'));
const { createControlPanel } = await import(dist('discord/controlPanel.js'));
const { saveCurrentSelection } = await import(dist('selection.js'));

const T0 = Date.UTC(2026, 9, 25, 12);

// A token shaped like a Steam refresh token, so loadCredentials keeps the file
const jwt = (payload) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');
const TOKEN = jwt({ iss: 'steam', aud: ['client'], sub: '76561197960287930' });

// Lets an awaited login or Discord send settle after a mocked timer fired it
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Thrown by the stubbed exit, so a test run stops where process.exit would
class ExitCalled extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const game = (appid) => ({ appid, name: `g${appid}`, playtime_forever: 0, source: 'owned' });

let apps;

beforeEach(() => {
  fs.writeFileSync(credentialsFile, JSON.stringify({ accountName: 'acct', refreshToken: TOKEN }));
  fs.rmSync(favoritesFile, { force: true });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });
  // The spinner, status table and errors print; keep the test output clean
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
  mock.method(process.stderr, 'write', () => true);
  apps = [];
});

afterEach(() => {
  for (const app of apps) app.rt.timers.clearAll();
  mock.timers.reset();
  mock.restoreAll();
});

// The modules wired as index.ts wires them, on fakes. Exit records its code and throws.
function setup(over = {}) {
  const client = createFakeClient(over);
  const discord = createFakeNotifier();
  const exits = [];
  const rt = createRuntime({
    client,
    discord,
    isHeadless: true,
    exit: (code) => {
      exits.push(code);
      throw new ExitCalled(code);
    },
  });
  const view = new StatusView(rt);
  const report = new DailyReport(rt);
  const shutdown = createShutdown(rt);
  rt.actions = { render: () => view.render(), shutdown: shutdown.handleShutdown, saveSelection: () => saveCurrentSelection(rt) };
  const flush = new Flush(rt);
  const resume = new Resume(rt, flush, view);
  const editMode = createEditMode(rt, view, report);
  const controlPanel = createControlPanel(rt, report);
  const app = { rt, client, discord, view, report, flush, resume, shutdown, editMode, controlPanel, installHandlers() {} };
  apps.push(app);
  return { app, rt, client, discord, exits };
}

// Advances the mocked clock in small steps until the promise settles
async function drive(promise, stepMs = 100) {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  for (let i = 0; i < 1000 && !done; i++) {
    await settle();
    if (!done) mock.timers.tick(stepMs);
  }
  return promise;
}

// Runs a headless start that must end in failHeadless; returns the exit codes and Discord messages
async function failedStart(over) {
  const { app, exits, discord } = setup(over);
  await assert.rejects(drive(runHeadless(app)), ExitCalled);
  return { exits, sent: discord.sent };
}

test('headless without a stored login exits 2', async () => {
  fs.rmSync(credentialsFile);
  const { exits, sent } = await failedStart();
  assert.deepEqual(exits, [2]);
  assert.deepEqual(sent, ['🛑 Headless start failed — No stored login found. Run interactively first to log in.']);
});

test('headless with a dead token exits 2, a network error exits 1', async () => {
  const dead = await failedStart({
    loginImpl: async () => {
      throw Object.assign(new Error('InvalidPassword'), { eresult: 5 });
    },
  });
  assert.deepEqual(dead.exits, [2]);
  assert.match(dead.sent[0], /^🛑 Headless start failed — Stored credentials expired/);

  fs.writeFileSync(credentialsFile, JSON.stringify({ accountName: 'acct', refreshToken: TOKEN }));
  const network = await failedStart({
    loginImpl: async () => {
      throw new Error('ETIMEDOUT');
    },
  });
  assert.deepEqual(network.exits, [1]);
  assert.match(network.sent[0], /^🛑 Headless start failed — ETIMEDOUT — stored credentials kept/);
});

test('headless rate-limited login waits instead of exiting', async () => {
  fs.writeFileSync(favoritesFile, JSON.stringify({ favorites: [10] }));
  let attempt = 0;
  const { app, rt, client, discord, exits } = setup({
    loginImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('RateLimitExceeded'), { eresult: 84 });
    },
    getOwnedGames: async () => [game(10)],
  });
  const run = runHeadless(app);
  await settle();
  await settle();
  assert.equal(client.logins.length, 1);
  assert.deepEqual(discord.sent, ['⏸️ Headless start rate-limited by Steam — waiting before retrying.']);

  // Nothing retries before the minimum wait
  mock.timers.tick(RATE_LIMIT_MIN_WAIT_MS - 1);
  await settle();
  assert.equal(client.logins.length, 1);
  assert.deepEqual(exits, []);

  mock.timers.tick(1);
  await run;
  assert.equal(client.logins.length, 2);
  assert.deepEqual(exits, []);
  assert.equal(rt.accountName, 'acct');
  assert.deepEqual(client.gamesPlayed, [[10]]);
  assert.deepEqual(discord.sent.slice(1), ['▶️ Idling started — 1 games']);
});

test('headless with no favorites exits 2', async () => {
  const { exits, sent } = await failedStart({ getOwnedGames: async () => [game(10)] });
  assert.deepEqual(exits, [2]);
  assert.deepEqual(sent, ['🛑 Headless start failed — No favorites configured. Run interactively first to set favorites.']);
});

test('headless with incomplete license data and no match exits 1', async () => {
  fs.writeFileSync(favoritesFile, JSON.stringify({ favorites: [99] }));
  const { exits, sent } = await failedStart({
    getOwnedGames: async () => [game(10)],
    ownershipCacheComplete: false,
  });
  assert.deepEqual(exits, [1]);
  assert.deepEqual(sent, [
    '🛑 Headless start failed — No matching games found — library incomplete (license data timed out). Retrying.',
  ]);
});

test('startIdling sends Idling started and enters waiting when the client is already disconnected', () => {
  const { app, rt, client, discord, exits } = setup({ isConnected: false });
  const byId = new Map([[1, game(1)], [2, game(2)]]);
  rt.library = { games: [...byId.values()], byId };

  startIdling(app, [
    { appid: 1, name: 'g1' },
    { appid: 2, name: 'g2' },
  ]);

  assert.equal(rt.isIdling, true);
  assert.deepEqual(client.gamesPlayed, [[1, 2]]);
  assert.deepEqual(discord.sent, ['▶️ Idling started — 2 games']);
  assert.equal(rt.isWaitingForResume, true);
  assert.equal(rt.waitingReason, 'disconnected before idling started');
  assert.deepEqual(exits, []);
});

test('unknown flags are listed', () => {
  assert.deepEqual(parseArgs(['--headless', '--bogus', '-x', '--help']), {
    headless: true,
    setupDiscord: false,
    logout: false,
    help: true,
    version: false,
    unknown: ['--bogus', '-x'],
  });
  assert.deepEqual(parseArgs(['-v', '--logout', '--setup-discord']).unknown, []);
  assert.deepEqual(parseArgs([]), {
    headless: false,
    setupDiscord: false,
    logout: false,
    help: false,
    version: false,
    unknown: [],
  });
});
