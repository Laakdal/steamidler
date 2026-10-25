import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';

const { computeSelection } = await import(dist('selection.js'));

const mk = (appid, over = {}) => ({
  appid, name: `g${appid}`, initialPlaytime: 0, startTime: new Date(0), accumulatedMs: 1000, ...over,
});
const sel = (appid) => ({ appid, name: `g${appid}` });
const noCreate = () => { throw new Error('unexpected create'); };

test('keeps kept games as the same objects', () => {
  const A = mk(1);
  const r = computeSelection({ idling: [A], paused: [] }, [sel(1)], noCreate);
  assert.equal(r.idling[0], A);
  assert.equal(A.startTime.getTime(), 0);
});

test('drops deselected games from both arrays', () => {
  const r = computeSelection(
    { idling: [mk(1), mk(2)], paused: [mk(5), mk(6)] },
    [sel(2), sel(6)], noCreate);
  assert.deepEqual(r.idling.map((g) => g.appid), [2]);
  assert.deepEqual(r.paused.map((g) => g.appid), [6]);
});

test('new games come from createGame', () => {
  const calls = [];
  const C = mk(3);
  const r = computeSelection({ idling: [mk(1)], paused: [] }, [sel(1), sel(3)],
    (s) => { calls.push(s); return C; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].appid, 3);
  assert.equal(r.idling[r.idling.length - 1], C);
});

test('paused games stay paused', () => {
  const Q = mk(2);
  const r = computeSelection({ idling: [], paused: [Q] }, [sel(2)], noCreate);
  assert.deepEqual(r.paused, [Q]);
  assert.equal(r.idling.length, 0);
});
