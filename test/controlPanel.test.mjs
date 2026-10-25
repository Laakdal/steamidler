import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';
import { createFakeClient } from './fake/steamClient.mjs';
import { createFakeNotifier } from './fake/notifier.mjs';

const { createControlPanel, statusSnapshot } = await import(dist('discord/controlPanel.js'));
const { DailyReport } = await import(dist('notifications/dailyReport.js'));
const { createRuntime } = await import(dist('runtime.js'));

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
function setup({ libSize = 3, selected = 2 } = {}) {
  const client = createFakeClient();
  const discord = createFakeNotifier();
  const rt = createRuntime({ client, discord, isHeadless: true });
  const renders = { count: 0 };
  rt.actions = { render: () => { renders.count += 1; }, shutdown: () => {} };
  const games = Array.from({ length: libSize }, (_, i) => ({ appid: i + 1, name: `g${i + 1}`, playtime_forever: 0, source: 'owned' }));
  const byId = new Map(games.map((g) => [g.appid, g]));
  rt.library = { games, byId };
  rt.session.start(games.slice(0, selected).map((g) => ({ appid: g.appid, name: g.name })), byId, false);
  rt.idlingStartedAt = new Date();
  rt.isIdling = true;
  const panel = createControlPanel(rt, new DailyReport(rt));
  return { rt, client, panel, renders };
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
