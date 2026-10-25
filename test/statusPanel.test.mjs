// Task 3: StatusPanel timers, REST outcomes and shutdown, with fetch mocked
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const sp = await import(dist('discord/statusPanel.js'));
const store = await import(dist('discord/statusStore.js'));

const keepalive = setInterval(() => {}, 1000);
after(() => clearInterval(keepalive));

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz1234';
const SC = '523456789012345678';
const M1 = '623456789012345678';
const M2 = '723456789012345678';
const BOT = { token: TOKEN, applicationId: '123456789012345678', ownerId: '223456789012345678', guildId: '323456789012345678', channelId: '423456789012345678', statusChannelId: SC };
const SNAP = () => ({ state: 'idling', waitingReason: null, games: [{ name: 'Hades', state: 'idling', exempt: false, totalMinutes: 600, gainedMs: 60_000, cooldownEndsAt: null }] });
const OPTS = { version: '0.1.0', timeoutMs: 100, intervalMs: 60_000, minGapMs: 0, stopCapMs: 300 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(5);
  }
}
const msg = (id, embeds = [{}]) => new Response(JSON.stringify({ id, embeds }), { status: 200 });
const status = (s) => new Response(null, { status: s });
const hang = (init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));

let calls, handler, logs;
console.error = (...a) => logs.push(a.join(' '));
console.log = (...a) => logs.push(a.join(' '));
beforeEach(() => {
  calls = []; logs = [];
  try { fs.rmSync(store.STATUS_PATH); } catch {}
  handler = (c) => (c.init.method === 'POST' ? msg(M1) : msg(M1));
  globalThis.fetch = async (url, init) => {
    const c = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(c);
    return handler(c);
  };
});
const isPost = (c) => c.init.method === 'POST';
const isPatch = (c) => c.init.method === 'PATCH';

test('first publish posts and stores the id', async () => {
  const p = new sp.StatusPanel(BOT, SNAP, OPTS);
  p.start();
  await waitFor(() => store.loadStatusMessage() !== null);
  assert.equal(calls.length, 1);
  assert.ok(isPost(calls[0]));
  assert.ok(calls[0].url.endsWith(`/channels/${SC}/messages`));
  assert.equal(calls[0].body.enforce_nonce, true);
  assert.ok(calls[0].body.nonce.length > 0 && calls[0].body.nonce.length <= 25);
  assert.deepEqual(store.loadStatusMessage(), { channelId: SC, messageId: M1 });
  await p.stop();
});

test('next publish edits the stored message', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  const p = new sp.StatusPanel(BOT, SNAP, OPTS);
  p.start();
  await waitFor(() => calls.length >= 1);
  await sleep(20);
  assert.equal(calls.length, 1);
  assert.ok(isPatch(calls[0]));
  assert.ok(calls[0].url.endsWith(`/channels/${SC}/messages/${M1}`));
  await p.stop();
});

test('a message stored for another channel is not edited', async () => {
  store.saveStatusMessage({ channelId: '999999999999999999', messageId: M1 });
  const p = new sp.StatusPanel(BOT, SNAP, OPTS);
  p.start();
  await waitFor(() => calls.length >= 1);
  assert.ok(isPost(calls[0]));
  await p.stop();
});

test('repost on 404 uses nonce and stores new id', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  let posts = 0;
  handler = (c) => {
    if (isPatch(c)) return status(404);
    posts += 1;
    return posts === 1 ? hang(c.init) : msg(M2);
  };
  const p = new sp.StatusPanel(BOT, SNAP, OPTS);
  p.start();
  await waitFor(() => posts === 1);
  await sleep(150); // the first post times out (timeoutMs 100)
  p.nudge();
  await waitFor(() => posts === 2);
  await waitFor(() => store.loadStatusMessage()?.messageId === M2);
  const postBodies = calls.filter(isPost).map((c) => c.body);
  assert.equal(postBodies[0].nonce, postBodies[1].nonce, 'retry reuses the nonce');
  await p.stop();
});

test('401 disables further requests', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  handler = () => status(401);
  const p = new sp.StatusPanel(BOT, SNAP, OPTS);
  p.start();
  await waitFor(() => calls.length === 1);
  await sleep(20);
  p.nudge();
  await sleep(50);
  await p.stop();
  assert.equal(calls.length, 1);
  assert.equal(logs.length, 1);
});

test('missing embed links logs once', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  handler = () => msg(M1, []);
  const p = new sp.StatusPanel(BOT, SNAP, { ...OPTS, intervalMs: 30 });
  p.start();
  await waitFor(() => calls.length >= 3);
  await p.stop();
  assert.equal(logs.filter((l) => l.includes('Embed Links')).length, 1);

  logs.length = 0; calls.length = 0;
  handler = () => status(403);
  const q = new sp.StatusPanel(BOT, SNAP, { ...OPTS, intervalMs: 30 });
  q.start();
  await waitFor(() => calls.length >= 3);
  await q.stop();
  assert.equal(logs.filter((l) => l.includes('Embed Links')).length, 1);
});

test('a recovered problem is logged again if it comes back', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  // Counted per tick (each tick starts with a PATCH; a 403 PATCH is followed by a POST)
  let ticks = 0;
  handler = (c) => (isPatch(c) && ++ticks === 2 ? msg(M1) : status(403));
  const p = new sp.StatusPanel(BOT, SNAP, { ...OPTS, intervalMs: 30 });
  p.start();
  await waitFor(() => ticks >= 3 && calls.length >= 5);
  await p.stop();
  assert.equal(logs.filter((l) => l.includes('no permission')).length, 2);
});

test('ticks are skipped while a request is in flight', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  handler = () => sleep(150).then(() => msg(M1));
  const p = new sp.StatusPanel(BOT, SNAP, { ...OPTS, timeoutMs: 1000, intervalMs: 20 });
  p.start();
  await sleep(120);
  assert.equal(calls.length, 1);
  await p.stop();
});

test('nudges are coalesced to minGap', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  const p = new sp.StatusPanel(BOT, SNAP, { ...OPTS, minGapMs: 100 });
  p.start();
  await waitFor(() => calls.length === 1);
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) p.nudge();
  await sleep(40);
  assert.equal(calls.length, 1, 'not before minGap');
  await waitFor(() => calls.length === 2);
  assert.ok(Date.now() - t0 >= 50);
  await sleep(150);
  assert.equal(calls.length, 2, 'five nudges became one edit');
  await p.stop();
});

test('a nudge during an in-flight request runs after it', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  handler = () => sleep(60).then(() => msg(M1));
  const p = new sp.StatusPanel(BOT, SNAP, { ...OPTS, timeoutMs: 1000 });
  p.start();
  await waitFor(() => calls.length === 1);
  p.nudge();
  await waitFor(() => calls.length === 2, 1000);
  await p.stop();
});

test('stop resolves within cap when fetch hangs', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  handler = (c) => hang(c.init);
  const p = new sp.StatusPanel(BOT, SNAP, { ...OPTS, timeoutMs: 10_000, stopCapMs: 300 });
  p.start();
  await waitFor(() => calls.length === 1);
  const t0 = Date.now();
  await p.stop();
  const took = Date.now() - t0;
  assert.ok(took < 800, `took ${took}ms`);
  const last = calls[calls.length - 1];
  assert.equal(calls.length, 2, 'the in-flight request was aborted and the final edit sent');
  assert.equal(last.body.embeds[0].color, 0xed4245);
  assert.ok(!last.body.embeds[0].description.includes('<t:'));
});

test('stop is idempotent and never rejects', async () => {
  globalThis.fetch = () => { throw new Error('sync boom'); };
  const p = new sp.StatusPanel(BOT, () => { throw new Error('snapshot boom'); }, OPTS);
  p.start();
  await sleep(20);
  const a = p.stop();
  const b = p.stop();
  await assert.doesNotReject(a);
  await assert.doesNotReject(b);
});

test('no timers survive stop', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  const p = new sp.StatusPanel(BOT, SNAP, { ...OPTS, intervalMs: 20 });
  p.start();
  await waitFor(() => calls.length >= 1);
  await p.stop();
  const n = calls.length;
  p.nudge();
  await sleep(80);
  assert.equal(calls.length, n);
});

test('no token or url in logs', async () => {
  globalThis.fetch = async () => { throw new Error(`boom ${TOKEN} https://discord.com/api/v10/x`); };
  const p = new sp.StatusPanel(BOT, () => { throw new Error(`snap ${TOKEN} https://discord.com/api/webhooks/1/abc`); }, OPTS);
  p.start();
  await sleep(30);
  await p.stop();
  assert.ok(logs.length >= 1, 'the snapshot failure is reported');
  for (const l of logs) {
    assert.ok(!l.includes(TOKEN), l);
    assert.ok(!l.includes('https://'), l);
  }
});

test('publishStatus reports embedShown and never throws', async () => {
  handler = () => msg(M2, []);
  const r = await sp.publishStatus(TOKEN, SC, null, { title: 't', description: 'd', color: 1, fields: [], footer: { text: 'f' }, timestamp: '' }, 'n', 100);
  assert.deepEqual(r, { ok: true, messageId: M2, embedShown: false });
  globalThis.fetch = () => { throw new Error('x'); };
  const r2 = await sp.publishStatus(TOKEN, SC, null, { title: 't', description: 'd', color: 1, fields: [], footer: { text: 'f' }, timestamp: '' }, 'n', 100);
  assert.deepEqual(r2, { ok: false, status: undefined });
});

// Final-review fixes
const errBody = (status, code) => new Response(JSON.stringify({ code, message: `secret ${TOKEN}` }), { status });

test('a 400 is logged once', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  handler = () => errBody(400, 50035);
  const p = new sp.StatusPanel(BOT, SNAP, { ...OPTS, intervalMs: 30 });
  p.start();
  await waitFor(() => calls.length >= 3);
  await p.stop();
  const lines = logs.filter((l) => l.includes('HTTP 400'));
  assert.equal(lines.length, 1);
  assert.ok(!logs.some((l) => l.includes(TOKEN) || l.includes('secret')), 'no response body in logs');
});

test('code 50006 maps to the Embed Links hint', async () => {
  handler = (c) => (isPost(c) ? errBody(400, 50006) : status(404));
  const p = new sp.StatusPanel(BOT, SNAP, { ...OPTS, intervalMs: 30 });
  p.start();
  await waitFor(() => calls.length >= 3);
  await p.stop();
  assert.equal(logs.filter((l) => l.includes('Embed Links')).length, 1);
});

test('PATCH 403 on a foreign message falls back to a post', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  handler = (c) => (isPatch(c) ? errBody(403, 50005) : msg(M2));
  const p = new sp.StatusPanel(BOT, SNAP, OPTS);
  p.start();
  await waitFor(() => store.loadStatusMessage()?.messageId === M2);
  assert.equal(logs.length, 0, 'no misleading permission hint');
  await p.stop();
});

test('PATCH 403 and POST 403 still report the permission problem', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  handler = () => status(403);
  const p = new sp.StatusPanel(BOT, SNAP, OPTS);
  p.start();
  await waitFor(() => calls.length >= 2);
  await p.stop();
  assert.equal(logs.filter((l) => l.includes('no permission')).length, 1);
});
