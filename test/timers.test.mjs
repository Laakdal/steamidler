import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';

const { Timers } = await import(dist('timers.js'));

afterEach(() => mock.timers.reset());

test('re-arming a name clears the old timer', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const t = new Timers();
  const fired = [];
  t.timeout('resume', () => fired.push('old'), 1000);
  t.timeout('resume', () => fired.push('new'), 2000);
  mock.timers.tick(5000);
  assert.deepEqual(fired, ['new']);

  let ticks = 0;
  t.interval('display', () => { ticks += 100; }, 1000);
  t.interval('display', () => { ticks += 1; }, 1000);
  mock.timers.tick(3000);
  assert.equal(ticks, 3);
});

test('clearAll leaves nothing pending', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const t = new Timers();
  let fired = 0;
  for (const name of ['resume', 'flush', 'zombie', 'takeoverDrift']) t.timeout(name, () => { fired += 1; }, 1000);
  t.interval('display', () => { fired += 1; }, 1000);
  t.clearAll();
  for (const name of ['resume', 'flush', 'zombie', 'takeoverDrift', 'display']) assert.equal(t.has(name), false);
  mock.timers.tick(10_000);
  assert.equal(fired, 0);
});

test('has is false after a timeout fires, and true for an interval until cleared', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const t = new Timers();
  t.timeout('pauseNotify', () => {}, 1000);
  assert.equal(t.has('pauseNotify'), true);
  mock.timers.tick(1000);
  assert.equal(t.has('pauseNotify'), false);

  t.interval('display', () => {}, 1000);
  mock.timers.tick(3000);
  assert.equal(t.has('display'), true);
  t.clear('display');
  assert.equal(t.has('display'), false);
});

test('a timeout that re-arms its own name from its callback stays pending', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const t = new Timers();
  let runs = 0;
  const schedule = () => t.timeout('flush', () => { runs += 1; schedule(); }, 1000);
  schedule();
  mock.timers.tick(1000);
  assert.equal(runs, 1);
  assert.equal(t.has('flush'), true);
  mock.timers.tick(1000);
  assert.equal(runs, 2);
});

test('clear of an unknown or fired name is a no-op', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const t = new Timers();
  t.clear('midnight');
  t.timeout('midnight', () => {}, 10);
  mock.timers.tick(10);
  t.clear('midnight');
  assert.equal(t.has('midnight'), false);
});
