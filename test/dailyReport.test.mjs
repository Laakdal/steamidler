import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';

const { formatDailyReport } = await import(dist('notifications/dailyReport.js'));

const NOW = Date.parse('2026-10-25T00:00:10Z');
const mk = (appid, name, over = {}) => ({
  appid, name, initialPlaytime: 600, startTime: new Date(NOW - 60 * 60_000), accumulatedMs: 2 * 3600_000, ...over,
});

test('report lists idling and paused only', () => {
  const idling = [mk(1, 'Alpha')];
  const paused = [mk(2, 'Beta')];
  const text = formatDailyReport(idling, paused, new Map([[1, 3600_000]]), new Date('2026-10-24T12:00:00Z'), false, NOW);
  assert.ok(text.includes('Idling (1):'));
  assert.ok(text.includes('• Alpha — +2h 0m today, 13h total'));
  assert.ok(text.includes('User-paused (1):'));
  assert.ok(text.includes('• Beta'));
  assert.ok(!/cooldown|exempt|∞/i.test(text));
});

test('frozen report adds no live delta and says so', () => {
  const text = formatDailyReport([mk(1, 'Alpha')], [], new Map(), new Date('2026-10-24T12:00:00Z'), true, NOW);
  assert.ok(text.includes('Idling (1) — currently paused:'));
  assert.ok(text.includes('+2h 0m today'));
});
