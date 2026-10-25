import { test, beforeEach, afterEach, mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dist, tempHome } from './helpers.mjs';
import { createFakeClient } from './fake/steamClient.mjs';
import { createFakeNotifier } from './fake/notifier.mjs';

// Before the imports: the config dir is fixed when the storage modules load
const home = tempHome();
const DIR = path.join(home, '.steam-idler');

const { createControlPanel, statusSnapshot } = await import(dist('discord/controlPanel.js'));
const { DailyReport } = await import(dist('notifications/dailyReport.js'));
const { createRuntime } = await import(dist('runtime.js'));
const { saveCurrentSelection } = await import(dist('selection.js'));
const { loadSelection } = await import(dist('storage/selection.js'));

const T0 = Date.UTC(2026, 9, 25, 12);
const MIN = 60_000;

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// An idling session over a library of `libSize` games with the first `selected`
// of them idling; renders are counted instead of painted.
function setup({ libSize = 3, selected = 2, missing = [] } = {}) {
  const client = createFakeClient();
  const discord = createFakeNotifier();
  const rt = createRuntime({ client, discord, isHeadless: true });
  const renders = { count: 0 };
  rt.accountName = 'alice';
  rt.actions = {
    render: () => { renders.count += 1; },
    shutdown: () => {},
    saveSelection: () => saveCurrentSelection(rt),
  };
  const games = Array.from({ length: libSize }, (_, i) => ({ appid: i + 1, name: `g${i + 1}`, playtime_forever: 0, source: 'owned' }));
  const byId = new Map(games.map((g) => [g.appid, g]));
  rt.library = { games, byId };
  // Saved games that are not in the library (appids past libSize)
  const picked = games.slice(0, selected).map((g) => ({ appid: g.appid, name: g.name }));
  rt.session.start([...picked, ...missing.map((appid) => ({ appid, name: `m${appid}` }))], byId, false);
  rt.idlingStartedAt = new Date();
  rt.isIdling = true;
  const panel = createControlPanel(rt, new DailyReport(rt));
  return { rt, client, discord, panel, renders };
}

const ids = (rt) => rt.session.selection().map((g) => g.appid);

test('busyReason mirrors the guards', () => {
  const { rt, panel } = setup();
  assert.equal(panel.busyReason(), null);

  rt.idlingStartedAt = null;
  assert.equal(panel.busyReason(), "Idling hasn't started yet.");
  rt.idlingStartedAt = new Date();

  rt.isInEditMode = true;
  assert.equal(panel.busyReason(), 'The game selector is open on the PC — try again after closing it.');
  rt.isInEditMode = false;

  rt.isWaitingForResume = true;
  rt.waitingReason = 'player active on this account elsewhere';
  assert.equal(
    panel.busyReason(),
    'Disconnected from Steam (player active on this account elsewhere) — try again after it reconnects.'
  );
  assert.equal(panel.waitingReason(), 'player active on this account elsewhere');

  // Precedence: edit mode before waiting, not started before edit mode, shutting down before all
  rt.isInEditMode = true;
  assert.equal(panel.busyReason(), 'The game selector is open on the PC — try again after closing it.');
  rt.idlingStartedAt = null;
  assert.equal(panel.busyReason(), "Idling hasn't started yet.");
  rt.isShuttingDown = true;
  assert.equal(panel.busyReason(), 'steamidler is shutting down.');

  rt.isWaitingForResume = false;
  assert.equal(panel.waitingReason(), null);
});

test('add ignores unknown, duplicate and the 33rd game', () => {
  const { rt, client, panel, renders } = setup({ libSize: 33, selected: 31 });

  panel.add(999);
  panel.add(1);
  assert.equal(client.gamesPlayed.length, 0, 'unknown and duplicate ids send nothing');
  assert.equal(renders.count, 0);

  panel.add(32);
  assert.equal(client.gamesPlayed.length, 1);
  assert.equal(client.gamesPlayed[0].length, 32);
  assert.ok(client.gamesPlayed[0].includes(32));
  assert.equal(renders.count, 1);

  panel.add(33);
  assert.equal(client.gamesPlayed.length, 1, 'the 33rd game is ignored');
  assert.equal(rt.session.selection().length, 32);
  assert.ok(!ids(rt).includes(33));
});

test('remove re-sends gamesPlayed unless waiting', () => {
  const { rt, client, panel, renders } = setup({ libSize: 3, selected: 3 });

  panel.remove(99);
  assert.equal(client.gamesPlayed.length, 0, 'an unselected id is ignored');

  panel.remove(1);
  assert.deepEqual(client.gamesPlayed, [[2, 3]]);
  assert.deepEqual(ids(rt), [2, 3]);
  assert.equal(renders.count, 1);

  rt.isWaitingForResume = true;
  panel.remove(2);
  assert.deepEqual(client.gamesPlayed, [[2, 3]], 'no gamesPlayed while waiting; restoreIdling re-sends');
  assert.deepEqual(ids(rt), [3]);
  assert.equal(renders.count, 2);

  // The selector owns the screen in edit mode: no repaint
  rt.isWaitingForResume = false;
  rt.isInEditMode = true;
  panel.add(1);
  assert.equal(renders.count, 2);
});

test('statusSnapshot: waiting wins over blocked', () => {
  const { rt } = setup({ libSize: 2, selected: 2 });
  mock.timers.tick(10 * MIN);

  const live = statusSnapshot(rt);
  assert.equal(live.state, 'idling');
  assert.equal(live.waitingReason, null);
  assert.deepEqual(live.games.map((g) => [g.name, g.state, g.gainedMs]), [
    ['g1', 'idling', 10 * MIN],
    ['g2', 'idling', 10 * MIN],
  ]);

  rt.session.setBlocked(true, 2, { bank: true, restartClocks: true });
  assert.equal(statusSnapshot(rt).state, 'blocked');

  rt.isWaitingForResume = true;
  rt.waitingReason = 'disconnected (x, eresult 3)';
  mock.timers.tick(5 * MIN);
  const waiting = statusSnapshot(rt);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.waitingReason, 'disconnected (x, eresult 3)');
  for (const g of waiting.games) assert.equal(g.gainedMs, 10 * MIN, 'no live delta while frozen');

  rt.isShuttingDown = true;
  assert.equal(statusSnapshot(rt).state, 'stopped');
});

const SAVE_FAILED = '⚠️ Could not save the game selection — a restart will forget recent changes';

// Empties the config dir so each save test starts with no selection file
function clean() {
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { force: true });
}

// The saved appids, or null when no selection file exists
function savedIds() {
  const loaded = loadSelection('alice', () => {});
  return loaded && loaded.source === 'saved' ? loaded.games.map((g) => g.appid) : null;
}

test('add and remove save the selection', () => {
  clean();
  const { discord, panel } = setup({ libSize: 4, selected: 2, missing: [90] });

  panel.add(999);
  panel.add(1);
  assert.equal(savedIds(), null, 'an ignored add writes nothing');

  panel.add(3);
  assert.deepEqual(savedIds(), [1, 2, 3, 90], 'idling, then paused, then missing');
  const names = loadSelection('alice', () => {}).games.map((g) => g.name);
  assert.deepEqual(names, ['g1', 'g2', 'g3', 'm90']);

  panel.remove(1);
  assert.deepEqual(savedIds(), [2, 3, 90]);
  assert.deepEqual(discord.sent, [], 'a successful save sends nothing');
});

test('save failure warns once until a save succeeds', () => {
  clean();
  const { rt, client, discord, panel } = setup({ libSize: 4, selected: 2 });
  const errs = [];
  const origError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  // Portable stand-in for an unwritable config dir: its path is a file
  const breakDir = () => { fs.rmSync(DIR, { recursive: true, force: true }); fs.writeFileSync(DIR, 'not a folder'); };
  const fixDir = () => { fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR); };
  try {
    breakDir();
    panel.add(3);
    assert.deepEqual(discord.sent, [SAVE_FAILED]);
    assert.equal(rt.saveFailureNotified, true);
    assert.deepEqual(client.gamesPlayed, [[1, 2, 3]], 'idling carries on');

    panel.remove(3);
    panel.add(4);
    assert.deepEqual(discord.sent, [SAVE_FAILED], 'later failures stay console-only');
    assert.equal(errs.length, 3, 'every failure is logged');
    assert.ok(errs.every((e) => e.startsWith('Could not save ')));

    fixDir();
    panel.remove(4);
    assert.deepEqual(savedIds(), [1, 2]);
    assert.equal(rt.saveFailureNotified, false, 'a success ends the streak');
    assert.deepEqual(discord.sent, [SAVE_FAILED]);

    breakDir();
    panel.add(3);
    assert.deepEqual(discord.sent, [SAVE_FAILED, SAVE_FAILED], 'a new streak warns again');
  } finally {
    console.error = origError;
    fixDir();
  }
});

test('cap counts missing games', () => {
  clean();
  const { rt, client, panel } = setup({ libSize: 33, selected: 31, missing: [90] });
  assert.equal(rt.session.selection().length, 32);

  panel.add(32);
  assert.deepEqual(client.gamesPlayed, [], 'the missing game holds the 32nd place');
  assert.equal(rt.session.idling.length, 31);
  assert.equal(savedIds(), null);
});

test('remove accepts a missing game', () => {
  clean();
  const { rt, client, panel } = setup({ libSize: 2, selected: 2, missing: [90, 91] });
  assert.deepEqual(
    panel.selection().map((g) => [g.appid, g.state]),
    [[1, 'idling'], [2, 'idling'], [90, 'missing'], [91, 'missing']]
  );
  // Missing games are not idled, so the status box never shows them
  assert.deepEqual(statusSnapshot(rt).games.map((g) => g.name), ['g1', 'g2']);

  panel.remove(90);
  assert.deepEqual(rt.session.missing.map((g) => g.appid), [91]);
  assert.deepEqual(client.gamesPlayed, [[1, 2]], 'only library games are sent to Steam');
  assert.deepEqual(savedIds(), [1, 2, 91]);
});
