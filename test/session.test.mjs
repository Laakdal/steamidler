import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist, tempHome } from './helpers.mjs';

// selection.js reaches the config dir; keep any write away from the real home
tempHome();

const { Session } = await import(dist('session.js'));
const { createRuntime, isFrozen } = await import(dist('runtime.js'));
const { installSelection } = await import(dist('selection.js'));

const T0 = 1_000_000;
const sel = (appid) => ({ appid, name: `g${appid}` });
const lib = (...ids) => new Map(ids.map((appid) => [appid, { appid, name: `g${appid}`, playtime_forever: appid * 10, source: 'owned' }]));
const ids = (games) => games.map((g) => g.appid);
const both = { bank: true, restartClocks: true };

// A session on a hand-driven clock, started with the given games
function started(appids, { blocked = false } = {}) {
  const clock = { now: new Date(T0) };
  const s = new Session(() => clock.now);
  s.start(appids.map(sel), lib(...appids), blocked);
  return { s, clock, at: (ms) => { clock.now = new Date(T0 + ms); return clock.now; } };
}

test('start creates idling games from the library and takes the blocked flag', () => {
  const { s } = started([1, 2], { blocked: true });
  assert.deepEqual(ids(s.idling), [1, 2]);
  assert.equal(s.paused.length, 0);
  assert.equal(s.blocked, true);
  assert.equal(s.idling[1].initialPlaytime, 20);
  assert.equal(s.idling[0].accumulatedMs, 0);
  assert.equal(s.idling[0].startTime.getTime(), T0);
});

test('apply keeps kept games as the same objects', () => {
  const { s, at } = started([1]);
  const A = s.idling[0];
  at(5000);
  s.apply([sel(1)], lib(1));
  assert.equal(s.idling[0], A);
  assert.equal(A.startTime.getTime(), T0);
});

test('apply drops deselected games from idling and paused', () => {
  const { s } = started([1, 2, 5, 6]);
  s.setBlocked(true, 5, both);
  assert.deepEqual(ids(s.paused), [5]);
  s.apply([sel(2), sel(5)], lib(1, 2, 5, 6));
  assert.deepEqual(ids(s.idling), [2]);
  assert.deepEqual(ids(s.paused), [5]);
  s.apply([sel(2)], lib(1, 2, 5, 6));
  assert.deepEqual(ids(s.idling), [2]);
  assert.deepEqual(ids(s.paused), []);
});

test('apply returns created appids', () => {
  const { s, at } = started([1]);
  at(7000);
  const created = s.apply([sel(1), sel(3)], lib(1, 3));
  assert.deepEqual(created, [3]);
  const C = s.idling[s.idling.length - 1];
  assert.equal(C.appid, 3);
  assert.equal(C.initialPlaytime, 30);
  assert.equal(C.startTime.getTime(), T0 + 7000);
  assert.deepEqual(s.apply([sel(1), sel(3)], lib(1, 3)), []);
});

test('apply puts a game missing from the library into missing, not idling', () => {
  const { s } = started([1]);
  assert.deepEqual(s.apply([sel(1), sel(9)], lib(1)), [], 'a missing game is not created');
  assert.deepEqual(ids(s.idling), [1]);
  assert.deepEqual(s.missing, [sel(9)]);
});

test('missing games survive apply and saves', () => {
  const s = new Session(() => new Date(T0));
  s.start([sel(1), sel(9), sel(2), sel(8)], lib(1, 2, 3), false);
  assert.deepEqual(ids(s.idling), [1, 2]);
  assert.deepEqual(s.missing, [sel(9), sel(8)], 'start keeps the saved names, in order');
  // Any number of applies that keep them selected leaves them alone, with no duplicates
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(s.apply(s.selection(), lib(1, 2, 3)), []);
    assert.deepEqual(s.missing, [sel(9), sel(8)]);
  }
  s.apply([...s.selection(), sel(3)], lib(1, 2, 3));
  assert.deepEqual(ids(s.idling), [1, 2, 3]);
  assert.deepEqual(s.missing, [sel(9), sel(8)]);
  assert.deepEqual(s.toSaved(), [sel(1), sel(2), sel(3), sel(9), sel(8)]);
  // A fresh start from the saved form (the next run) still knows them
  const next = new Session(() => new Date(T0));
  next.start(s.toSaved(), lib(1, 2, 3), false);
  assert.deepEqual(next.toSaved(), s.toSaved());
  // Once a game is back in the library, the next start idles it
  next.start(s.toSaved(), lib(1, 2, 3, 9), false);
  assert.deepEqual(ids(next.idling), [1, 2, 3, 9]);
  assert.deepEqual(next.missing, [sel(8)]);
});

test('toSaved includes paused and missing games', () => {
  const s = new Session(() => new Date(T0));
  s.start([sel(1), sel(2), sel(7), sel(3)], lib(1, 2, 3), false);
  s.setBlocked(true, 2, both);
  assert.deepEqual(ids(s.paused), [2]);
  // idling, then paused, then missing; plain {appid, name} copies
  assert.deepEqual(s.toSaved(), [sel(1), sel(3), sel(2), sel(7)]);
  assert.deepEqual(s.selection(), s.toSaved());
  const saved = s.toSaved();
  saved[3].name = 'changed';
  assert.equal(s.missing[0].name, 'g7', 'the saved form is a copy');
  assert.ok(!('startTime' in saved[0]));
});

test('deselecting a missing game drops it', () => {
  const s = new Session(() => new Date(T0));
  s.start([sel(1), sel(7), sel(8)], lib(1), false);
  s.apply([sel(1), sel(8)], lib(1));
  assert.deepEqual(s.missing, [sel(8)]);
  assert.deepEqual(s.toSaved(), [sel(1), sel(8)]);
  s.apply([sel(1)], lib(1));
  assert.deepEqual(s.missing, []);
  assert.deepEqual(ids(s.idling), [1]);
});

test('apply leaves paused games paused', () => {
  const { s } = started([2]);
  s.setBlocked(true, 2, both);
  const Q = s.paused[0];
  s.apply([sel(2)], lib(2));
  assert.deepEqual(s.paused, [Q]);
  assert.equal(s.idling.length, 0);
});

test('selection lists idling then paused', () => {
  const { s } = started([1, 2, 3]);
  s.setBlocked(true, 1, both);
  assert.deepEqual(s.selection(), [sel(2), sel(3), sel(1)]);
});

test('bank is idempotent', () => {
  const { s, at } = started([1]);
  const now = at(1000);
  s.bank(now);
  s.bank(now);
  assert.equal(s.idling[0].accumulatedMs, 1000);
  assert.equal(s.idling[0].startTime, now);
  at(1500);
  s.bank();
  assert.equal(s.idling[0].accumulatedMs, 1500);
});

test('setBlocked moves the played game to paused and banks once', () => {
  const { s, at } = started([1, 2]);
  at(5000);
  assert.equal(s.setBlocked(true, 2, both), true);
  assert.equal(s.blocked, true);
  assert.deepEqual(ids(s.idling), [1]);
  assert.deepEqual(ids(s.paused), [2]);
  assert.deepEqual(s.paused.concat(s.idling).map((g) => g.accumulatedMs), [5000, 5000]);
  at(9000);
  assert.equal(s.setBlocked(true, 1, both), false);
  assert.deepEqual(ids(s.paused), [2]);
  assert.deepEqual(s.paused.concat(s.idling).map((g) => g.accumulatedMs), [5000, 5000]);
});

test('setBlocked without bank leaves the clocks alone', () => {
  const { s, at } = started([1]);
  at(5000);
  assert.equal(s.setBlocked(true, 99, { bank: false, restartClocks: false }), true);
  assert.equal(s.idling[0].accumulatedMs, 0);
  assert.equal(s.idling[0].startTime.getTime(), T0);
});

test('setBlocked returns false without a transition', () => {
  const { s } = started([1, 2]);
  assert.equal(s.setBlocked(false, 1, both), false);
  assert.deepEqual(ids(s.idling), [1, 2]);
  assert.equal(s.blocked, false);
});

test('unblocking releases paused games and restarts clocks only when asked', () => {
  const { s, at } = started([1, 2]);
  s.setBlocked(true, 2, both);
  at(4000);
  assert.equal(s.setBlocked(false, 0, { bank: true, restartClocks: false }), true);
  assert.deepEqual(ids(s.idling), [1, 2]);
  assert.equal(s.paused.length, 0);
  assert.deepEqual(s.idling.map((g) => g.startTime.getTime()), [T0, T0]);

  s.setBlocked(true, 1, both);
  const now = at(6000);
  s.setBlocked(false, 0, both);
  assert.deepEqual(ids(s.idling), [2, 1]);
  assert.deepEqual(s.idling.map((g) => g.startTime), [now, now]);
});

test('release returns paused games and clears blocked', () => {
  const { s, at } = started([1, 2]);
  s.setBlocked(true, 2, both);
  const now = at(3000);
  s.release(now);
  assert.equal(s.blocked, false);
  assert.deepEqual(ids(s.idling), [1, 2]);
  assert.equal(s.paused.length, 0);
  assert.deepEqual(s.idling.map((g) => g.startTime), [now, now]);
});

test('restartClocks sets startTime on idling games only', () => {
  const { s, at } = started([1, 2]);
  s.setBlocked(true, 2, both);
  const now = at(2000);
  s.restartClocks(now);
  assert.equal(s.idling[0].startTime, now);
  assert.equal(s.paused[0].startTime.getTime(), T0);
});

test('gainedMs adds no live delta while frozen', () => {
  const { s, at } = started([1]);
  s.bank(at(1000));
  const now = at(4000);
  assert.equal(s.gainedMs(s.idling[0], true, now), 1000);
  assert.equal(s.gainedMs(s.idling[0], false, now), 4000);
  assert.equal(s.gainedMs(s.idling[0], false), 4000);
});

test('installSelection forgets the day-start of created games only', () => {
  const rt = createRuntime({ client: {}, discord: {}, isHeadless: true, exit: () => {} });
  rt.library = { games: [], byId: lib(1, 2, 3) };
  rt.session.start([sel(1), sel(2)], rt.library.byId, false);
  const forgotten = [];
  let saves = 0;
  rt.actions.saveSelection = () => { saves += 1; };
  installSelection(rt, (appids) => forgotten.push(...appids), [sel(2), sel(3)]);
  assert.deepEqual(forgotten, [3]);
  assert.equal(saves, 1, 'every installed selection is saved');
  assert.deepEqual(ids(rt.session.idling), [2, 3]);
});

test('isFrozen is true while waiting or blocked', () => {
  const rt = createRuntime({ client: {}, discord: {}, isHeadless: true, exit: () => {} });
  rt.session.start([sel(1)], lib(1), false);
  assert.equal(isFrozen(rt), false);
  rt.isWaitingForResume = true;
  assert.equal(isFrozen(rt), true);
  rt.isWaitingForResume = false;
  rt.session.setBlocked(true, 1, both);
  assert.equal(isFrozen(rt), true);
});

test('createRuntime starts with every guard off', () => {
  const rt = createRuntime({ client: {}, discord: {}, isHeadless: false });
  assert.equal(rt.idlingStartedAt, null);
  for (const f of ['isIdling', 'isWaitingForResume', 'isInEditMode', 'isShuttingDown', 'stopNotified', 'selfInitiatedRelog', 'saveFailureNotified']) {
    assert.equal(rt[f], false, f);
  }
  assert.equal(rt.waitingReason, '');
  assert.equal(rt.accountName, '');
  assert.equal(rt.botHandle, null);
  assert.equal(rt.statusPanel, null);
  assert.equal(rt.library.games.length, 0);
});
