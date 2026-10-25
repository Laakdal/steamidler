import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';

const { GatewayHealth, FATAL_CLOSE_CODES, GATEWAY_DOWN_GRACE_MS } = await import(
  dist('discord/health.js')
);
const { BOT_DOWN_REASONS } = await import(
  dist('discord/notifier.js')
);

function make() {
  const downs = [];
  const ups = [];
  const h = new GatewayHealth((r, f) => downs.push([r, f]), () => ups.push(1), 120_000);
  return { h, downs, ups };
}

test('grace constant and fatal set', () => {
  assert.equal(GATEWAY_DOWN_GRACE_MS, 120_000);
  assert.deepEqual([...FATAL_CLOSE_CODES].sort(), [4004, 4010, 4011, 4012, 4013, 4014]);
});

for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
  test(`fatal close code ${code} reports down immediately with fatal=true`, () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { h, downs, ups } = make();
    h.disconnected(code);
    const expected =
      code === 4004 ? BOT_DOWN_REASONS.tokenRejected
      : code === 4013 || code === 4014 ? BOT_DOWN_REASONS.intentsRejected
      : BOT_DOWN_REASONS.gatewayRejected(code);
    assert.deepEqual(downs, [[expected, true]]);
    h.ready();
    h.disconnected(1006);
    mock.timers.tick(300_000);
    assert.equal(downs.length, 1);
    assert.equal(ups.length, 0);
    h.stop();
    mock.timers.reset();
  });
}

test('flapping under the grace never reports', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { h, downs, ups } = make();
  for (let i = 0; i < 60; i++) {
    h.disconnected(1006);
    mock.timers.tick(9000);
    h.ready();
    mock.timers.tick(1000);
  }
  assert.equal(downs.length, 0);
  assert.equal(ups.length, 0);
  h.stop();
  mock.timers.reset();
});

test('outage over the grace reports down once, then up once', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { h, downs, ups } = make();
  h.disconnected(1006);
  mock.timers.tick(60_000);
  h.disconnected(null);
  mock.timers.tick(61_000);
  assert.deepEqual(downs, [[BOT_DOWN_REASONS.gatewayUnreachable, false]]);
  h.disconnected(null);
  mock.timers.tick(300_000);
  assert.equal(downs.length, 1);
  h.ready();
  assert.equal(ups.length, 1);
  h.ready();
  assert.equal(ups.length, 1);
  h.stop();
  mock.timers.reset();
});

test('stop cancels a pending timer', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { h, downs } = make();
  h.disconnected(1006);
  h.stop();
  mock.timers.tick(300_000);
  assert.equal(downs.length, 0);
  h.disconnected(4004);
  assert.equal(downs.length, 0);
  mock.timers.reset();
});
