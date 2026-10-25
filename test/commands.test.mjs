import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';

const m = await import(dist('discord/commands.js'));

function fake({ library = [], selection = [], busy = null, waiting = null } = {}) {
  const calls = { add: [], remove: [] };
  return {
    calls,
    library: () => library,
    selection: () => selection,
    busyReason: () => busy,
    waitingReason: () => waiting,
    add: (a) => calls.add.push(a),
    remove: (a) => calls.remove.push(a),
  };
}
const sel = (appid, name, extra = {}) => ({ appid, name, state: 'idling', exempt: false, cooldownEndsAt: null, ...extra });
const bigLib = (n) => Array.from({ length: n }, (_, i) => ({ appid: i + 1, name: `Game ${String(i + 1).padStart(2, '0')}` }));

test('isAuthorized', () => {
  const bot = { ownerId: 'o', guildId: 'g' };
  assert.equal(m.isAuthorized({ userId: 'o', guildId: 'g' }, bot), true);
  assert.equal(m.isAuthorized({ userId: 'x', guildId: 'g' }, bot), false);
  assert.equal(m.isAuthorized({ userId: 'o', guildId: 'h' }, bot), false);
  assert.equal(m.isAuthorized({ userId: 'o', guildId: null }, bot), false);
});

test('suggestAdd excludes selected games and caps at 25', () => {
  const p = fake({ library: bigLib(40), selection: [sel(1, 'Game 01')] });
  const r = m.suggestAdd(p, '');
  assert.equal(r.length, 25);
  assert.ok(!r.some((c) => c.value === '1'));
  assert.deepEqual(r[0], { name: 'Game 02', value: '2' });
});

test('suggestAdd ranks prefix matches first', () => {
  const p = fake({ library: [
    { appid: 1, name: 'Zed Portal' }, { appid: 2, name: 'Portal 2' }, { appid: 3, name: 'Alpha portal' }, { appid: 4, name: 'Portal' },
  ] });
  assert.deepEqual(m.suggestAdd(p, 'PORTAL').map((c) => c.name), ['Portal', 'Portal 2', 'Alpha portal', 'Zed Portal']);
});

test('suggestAdd truncates names over 100 chars to 100', () => {
  const p = fake({ library: [{ appid: 5, name: 'x'.repeat(300) }, { appid: 6, name: 'y'.repeat(100) }] });
  const r = m.suggestAdd(p, '');
  assert.equal(r[0].name.length, 100);
  assert.equal(r[0].name, 'x'.repeat(99) + '…');
  assert.equal(r[1].name, 'y'.repeat(100));
});

test('suggestRemove lists only the selection', () => {
  const p = fake({ library: bigLib(5), selection: [sel(3, 'Game 03'), sel(2, 'Game 02')] });
  assert.deepEqual(m.suggestRemove(p, ''), [{ name: 'Game 02', value: '2' }, { name: 'Game 03', value: '3' }]);
  assert.deepEqual(m.suggestRemove(p, '03'), [{ name: 'Game 03', value: '3' }]);
});

test('runAdd rejects non-library values', () => {
  const p = fake({ library: bigLib(10) });
  for (const v of ['abc', '-1', '1e3', ' 10 ', '999', '']) {
    assert.equal(m.runAdd(p, v), 'Unknown game.');
  }
  assert.deepEqual(p.calls.add, []);
});

test('runAdd refuses the 33rd game', () => {
  const p = fake({ library: bigLib(40), selection: bigLib(32).map((g) => sel(g.appid, g.name)) });
  assert.equal(m.runAdd(p, '33'), 'Already idling 32 games — remove one first.');
  assert.deepEqual(p.calls.add, []);
});

test('runAdd refuses an already selected game', () => {
  const p = fake({ library: bigLib(5), selection: [sel(2, 'Game 02')] });
  assert.equal(m.runAdd(p, '2'), 'Already idling Game 02.');
  assert.deepEqual(p.calls.add, []);
});

test('runAdd returns busyReason and does not call add when busy', () => {
  const p = fake({ library: bigLib(5), busy: 'Steam is busy.' });
  assert.equal(m.runAdd(p, '2'), 'Steam is busy.');
  assert.equal(m.runAdd(p, 'abc'), 'Steam is busy.');
  assert.deepEqual(p.calls.add, []);
});

test('runAdd success calls add(appid)', () => {
  const p = fake({ library: bigLib(5), selection: [sel(1, 'Game 01')] });
  const r = m.runAdd(p, '2');
  assert.deepEqual(p.calls.add, [2]);
  assert.equal(r, '▶️ Now idling Game 02 (until steamidler restarts).');
});

test('runRemove refuses the last game', () => {
  const p = fake({ selection: [sel(1, 'Game 01')] });
  assert.equal(m.runRemove(p, '1'), 'Game 01 is the only game left — steamidler needs at least one.');
  assert.deepEqual(p.calls.remove, []);
});

test('runRemove unknown, not selected, busy', () => {
  const p = fake({ selection: [sel(1, 'A'), sel(2, 'B')] });
  assert.equal(m.runRemove(p, '9'), 'Unknown game.');
  assert.equal(m.runRemove(fake({ selection: [sel(1, 'A')], busy: 'nope' }), '1'), 'nope');
});

test('runRemove success calls remove', () => {
  const p = fake({ selection: [sel(1, 'A'), sel(2, 'B')] });
  assert.equal(m.runRemove(p, '2'), '⏹️ Stopped idling B (until steamidler restarts).');
  assert.deepEqual(p.calls.remove, [2]);
});

test('formatStatus lists sections, time left, waiting reason, and the restart note', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const p = fake({
    waiting: 'Logged in elsewhere',
    selection: [
      sel(1, 'Alpha'),
      sel(2, 'Beta', { state: 'cooldown', cooldownEndsAt: new Date(now.getTime() + (2 * 60 + 5) * 60000) }),
      sel(3, 'Gamma', { state: 'paused' }),
      sel(4, 'Delta', { exempt: true }),
    ],
  });
  const s = m.formatStatus(p, now);
  assert.ok(s.includes('Idling (2)'));
  assert.ok(s.includes('Cooldown (1)'));
  assert.ok(s.includes('Beta — 2h 05m left'));
  assert.ok(s.includes('Paused — playing elsewhere (1)'));
  assert.ok(s.includes('Exempt: Delta ∞'));
  assert.ok(s.includes('Steam: disconnected — Logged in elsewhere'));
  assert.ok(s.endsWith('Changes made here last until steamidler restarts; favorites are unchanged.'));
  const q = m.formatStatus(fake({ selection: [sel(1, 'A')] }), now);
  assert.ok(!q.includes('Cooldown') && !q.includes('Exempt') && !q.includes('Steam:'));
});

test('NOT_ALLOWED_REPLY', () => {
  assert.equal(m.NOT_ALLOWED_REPLY, "You're not allowed to control this steamidler.");
});
