import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';

const { computeSelection } = await import(dist('selection.js'));

const mk = (appid, over = {}) => ({
  appid, name: `g${appid}`, startTime: new Date(0), accumulatedMs: 1000,
  nextPauseAtMs: 5000, pauseUntil: null, ...over,
});
const sel = (appid) => ({ appid, name: `g${appid}` });
const rnd = () => 7;
const now = new Date(99);
const noCreate = () => { throw new Error('unexpected create'); };

test('keeps kept games as the same objects', () => {
  const A = mk(1);
  const r = computeSelection({ idling: [A], pausing: [], paused: [] }, [sel(1)], null, noCreate, rnd, now);
  assert.equal(r.idling[0], A);
  assert.equal(A.startTime.getTime(), 0);
});

test('drops deselected games from all three arrays', () => {
  const r = computeSelection(
    { idling: [mk(1), mk(2)], pausing: [mk(3), mk(4)], paused: [mk(5), mk(6)] },
    [sel(2), sel(4), sel(6)], null, noCreate, rnd, now);
  assert.deepEqual(r.idling.map((g) => g.appid), [2]);
  assert.deepEqual(r.pausing.map((g) => g.appid), [4]);
  assert.deepEqual(r.paused.map((g) => g.appid), [6]);
});

test('new games come from createGame with the exempt flag', () => {
  const calls = [];
  const C = mk(3);
  const r = computeSelection({ idling: [mk(1)], pausing: [], paused: [] }, [sel(1), sel(3)], 3,
    (s, e) => { calls.push([s, e]); return C; }, rnd, now);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].appid, 3);
  assert.equal(calls[0][1], true);
  assert.equal(r.idling[r.idling.length - 1], C);
});

test('becoming exempt clears the cooldown threshold', () => {
  const A = mk(1);
  computeSelection({ idling: [A], pausing: [], paused: [] }, [sel(1)], 1, noCreate, rnd, now);
  assert.equal(A.nextPauseAtMs, null);
  assert.equal(A.pauseUntil, null);
});

test('losing exempt rolls a new phase from accumulatedMs', () => {
  const A = mk(1, { nextPauseAtMs: null });
  computeSelection({ idling: [A], pausing: [], paused: [] }, [sel(1)], null, noCreate, rnd, now);
  assert.equal(A.nextPauseAtMs, 1007);
});

test('a cooling game that becomes exempt moves to idling with startTime = now', () => {
  const P = mk(1, { pauseUntil: new Date(500) });
  const r = computeSelection({ idling: [], pausing: [P], paused: [] }, [sel(1)], 1, noCreate, rnd, now);
  assert.deepEqual(r.idling, [P]);
  assert.equal(r.pausing.length, 0);
  assert.equal(P.startTime.getTime(), 99);
  assert.equal(P.pauseUntil, null);
});

test('a cooling game that stays non-exempt stays in pausing; paused games stay paused', () => {
  const P = mk(1, { pauseUntil: new Date(500) });
  const Q = mk(2);
  const r = computeSelection({ idling: [], pausing: [P], paused: [Q] }, [sel(1), sel(2)], null, noCreate, rnd, now);
  assert.deepEqual(r.pausing, [P]);
  assert.deepEqual(r.paused, [Q]);
  assert.equal(r.idling.length, 0);
});
