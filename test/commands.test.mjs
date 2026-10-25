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
const sel = (appid, name, extra = {}) => ({ appid, name, state: 'idling', ...extra });
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
  assert.equal(r, '▶️ Now idling Game 02.');
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
  assert.equal(m.runRemove(p, '2'), '⏹️ Stopped idling B.');
  assert.deepEqual(p.calls.remove, [2]);
});

test('formatStatus lists sections, waiting reason, and the saved note', () => {
  const p = fake({
    waiting: 'Logged in elsewhere',
    selection: [
      sel(1, 'Alpha'),
      sel(3, 'Gamma', { state: 'paused' }),
      sel(4, 'Delta'),
    ],
  });
  const s = m.formatStatus(p);
  assert.ok(s.includes('Idling (2)'));
  assert.ok(s.includes('Paused — playing elsewhere (1)'));
  assert.ok(s.includes('Steam: disconnected — Logged in elsewhere'));
  assert.ok(s.endsWith('Changes are saved and kept after a restart.'));
  const q = m.formatStatus(fake({ selection: [sel(1, 'A')] }));
  assert.ok(!q.includes('Steam:'));
});

test('status has no cooldown or exempt lines', () => {
  const s = m.formatStatus(fake({ selection: [sel(1, 'Alpha'), sel(2, 'Beta', { state: 'paused' })] }));
  assert.ok(!/cooldown|exempt|∞/i.test(s));
});

test('NOT_ALLOWED_REPLY', () => {
  assert.equal(m.NOT_ALLOWED_REPLY, "You're not allowed to control this steamidler.");
});

test('suggestRemove offers missing games, suggestAdd does not', () => {
  const p = fake({ library: bigLib(3), selection: [sel(1, 'Game 01'), sel(90, 'Gone Game', { state: 'missing' })] });
  assert.deepEqual(m.suggestRemove(p, 'gone'), [{ name: 'Gone Game', value: '90' }]);
  assert.ok(!m.suggestAdd(p, '').some((c) => c.value === '90'));
});

test('status lists missing games under Not in library', () => {
  const p = fake({
    selection: [
      sel(1, 'Alpha'),
      sel(3, 'Gamma', { state: 'paused' }),
      sel(90, 'Lent *Game*', { state: 'missing' }),
      sel(91, 'Other', { state: 'missing' }),
    ],
  });
  const s = m.formatStatus(p);
  assert.ok(s.includes('Idling (1)\n• Alpha'));
  assert.ok(s.includes('Paused — playing elsewhere (1)\n• Gamma'));
  assert.ok(s.includes('Not in library — kept, retried at the next start (2)\n• Lent *Game*\n• Other'));
  assert.ok(s.indexOf('Paused') < s.indexOf('Not in library'));
  const none = m.formatStatus(fake({ selection: [sel(1, 'A')] }));
  assert.ok(!none.includes('Not in library'));
});

test('status footer says changes are saved', () => {
  const s = m.formatStatus(fake({ selection: [sel(1, 'A')] }));
  assert.ok(s.endsWith('Changes are saved and kept after a restart.'));
  assert.ok(!/restarts;|favorites/.test(s));
});

test('add and remove replies no longer say until restart', () => {
  const p = fake({ library: bigLib(5), selection: [sel(1, 'Game 01'), sel(2, 'Game 02')] });
  assert.equal(m.runAdd(p, '3'), '▶️ Now idling Game 03.');
  assert.equal(m.runRemove(p, '2'), '⏹️ Stopped idling Game 02.');
  assert.deepEqual(p.calls, { add: [3], remove: [2] });
});

test('removing the last game in the library is refused, a missing one is allowed', () => {
  const p = fake({ selection: [sel(1, 'Only'), sel(90, 'Gone', { state: 'missing' })] });
  assert.equal(m.runRemove(p, '1'), 'Only is the only game left — steamidler needs at least one.');
  assert.deepEqual(p.calls.remove, []);
  assert.equal(m.runRemove(p, '90'), '⏹️ Stopped idling Gone.');
  assert.deepEqual(p.calls.remove, [90]);
  // A paused library game counts as one that is left
  const q = fake({ selection: [sel(1, 'A'), sel(2, 'B', { state: 'paused' }), sel(90, 'Gone', { state: 'missing' })] });
  assert.equal(m.runRemove(q, '1'), '⏹️ Stopped idling A.');
});
