// Task 2: status embed builder and the post/edit REST helpers
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';

const e = await import(dist('discord/statusEmbed.js'));
const rest = await import(dist('discord/rest.js'));

// AbortSignal.timeout timers are unref'd; the real app has other handles alive
const keepalive = setInterval(() => {}, 1000);
after(() => clearInterval(keepalive));

const NOW = new Date('2026-10-23T12:00:00Z');
const NEXT = new Date('2026-10-23T12:01:00Z');
const H = 3600_000;
const game = (over = {}) => ({ name: 'Stardew Valley', state: 'idling', totalMinutes: 125 * 60, gainedMs: 2 * H + 5 * 60_000, ...over });
const snap = (games, over = {}) => ({ state: 'idling', waitingReason: null, games, ...over });
const embedSize = (em) => em.title.length + em.description.length + em.footer.text.length + em.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
const FENCE = '```';

test('idling snapshot renders state, countdown and rows', () => {
  const em = e.buildStatusEmbed(snap([game(), game({ name: 'Hades' })]), NOW, NEXT, '0.1.0');
  assert.equal(em.title, 'Steam Idler');
  assert.equal(em.color, 0x57f287);
  assert.match(em.description, /🟢 Idling 2 games/);
  assert.ok(em.description.includes(`<t:${Math.floor(NEXT.getTime() / 1000)}:R>`));
  assert.equal(em.fields[0].name, '🎮 Idling (2)');
  assert.ok(em.fields[0].value.startsWith(FENCE + '\n') && em.fields[0].value.endsWith('\n' + FENCE));
  assert.match(em.fields[0].value, /Stardew Valley.*125h.*\+2h 05m/);
  assert.match(em.fields[0].value, /Hades/);
  assert.equal(em.footer.text, 'steamidler v0.1.0');
  assert.equal(em.timestamp, NOW.toISOString());
});

test('one game uses the singular', () => {
  assert.match(e.buildStatusEmbed(snap([game()]), NOW, NEXT, '0.1.0').description, /Idling 1 game$/m);
});

test('stopped has red colour and no countdown', () => {
  const em = e.buildStatusEmbed(snap([game()], { state: 'stopped' }), NOW, NEXT, '0.1.0');
  assert.equal(em.color, 0xed4245);
  assert.match(em.description, /^🛑 Stopped/);
  assert.ok(!em.description.includes('<t:'));
});

test('waiting wins and escapes the reason', () => {
  const em = e.buildStatusEmbed(snap([game()], { state: 'waiting', waitingReason: 'kicked *by* `x`' }), NOW, NEXT, '0.1.0');
  assert.equal(em.color, 0xfee75c);
  assert.ok(em.description.startsWith('🟡 Waiting to resume — kicked \\*by\\* \\`x\\`'));
});

test('blocked and starting states', () => {
  const b = e.buildStatusEmbed(snap([game()], { state: 'blocked' }), NOW, NEXT, '0.1.0');
  assert.equal(b.color, 0xfee75c);
  assert.match(b.description, /^🟡 Paused — a game is being played on this account elsewhere/);
  const s = e.buildStatusEmbed(snap([], { state: 'starting' }), NOW, null, '0.1.0');
  assert.equal(s.color, 0x99aab5);
  assert.equal(s.description, '⏳ Waiting for idling to start');
  assert.deepEqual(s.fields, []);
});

test('empty sections are omitted', () => {
  const em = e.buildStatusEmbed(snap([game({ state: 'paused' })]), NOW, NEXT, '0.1.0');
  assert.deepEqual(em.fields.map((f) => f.name), ['⏸️ Paused (1)']);
});

test('no cooldown field and no ∞ mark', () => {
  const em = e.buildStatusEmbed(snap([game(), game({ name: 'Hades', state: 'paused' })]), NOW, NEXT, '0.1.0');
  assert.deepEqual(em.fields.map((f) => f.name), ['🎮 Idling (1)', '⏸️ Paused (1)']);
  assert.ok(!em.fields.some((f) => /∞|ooldown/.test(f.name + f.value)));
});

test('paused section lists total only', () => {
  const em = e.buildStatusEmbed(snap([game({ state: 'paused' })]), NOW, NEXT, '0.1.0');
  assert.equal(em.fields[0].name, '⏸️ Paused (1)');
  assert.match(em.fields[0].value, /Stardew Valley\s+125h/);
  assert.ok(!em.fields[0].value.includes('+'));
});

test('hostile names stay inside limits', () => {
  const name = ('```@everyone **x** https://e.x/ ').repeat(10).slice(0, 300);
  const games = Array.from({ length: 32 }, (_, i) => game({ name: `${name}${i}`, totalMinutes: 123456 * 60 }));
  const em = e.buildStatusEmbed(snap(games), NOW, NEXT, '0.1.0');
  assert.ok(em.fields.length <= 25);
  assert.ok(em.fields.length >= 2, 'a 32-row section continues into more fields');
  for (const f of em.fields) {
    assert.ok(f.value.length <= 1024, `field ${f.value.length}`);
    assert.equal(f.value.split(FENCE).length - 1, 2, 'exactly the two fences');
    assert.ok(!f.value.includes('://'), 'names are clipped before any URL');
    assert.ok(f.name.length > 0 && f.name.length <= 256);
  }
  assert.ok(em.fields.slice(1).every((f) => f.name === '​'));
  const rows = em.fields.flatMap((f) => f.value.split('\n').slice(1, -1));
  assert.equal(rows.length, 32);
  assert.ok(embedSize(em) <= 6000, `total ${embedSize(em)}`);
});

let calls = [];
const mock = (res = () => new Response('{}', { status: 200 })) => {
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return res(init); };
};
const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz1234';
const EM = { title: 't', description: 'd', color: 1, fields: [], footer: { text: 'f' }, timestamp: NOW.toISOString() };

test('post body has nonce, enforce_nonce, no flags, mentions off', async () => {
  mock();
  await rest.postEmbedMessage(TOKEN, '523456789012345678', EM, 'n123', 1000);
  const c = calls[0];
  assert.equal(c.init.method, 'POST');
  assert.equal(c.url, 'https://discord.com/api/v10/channels/523456789012345678/messages');
  const body = JSON.parse(c.init.body);
  assert.deepEqual(body, { embeds: [EM], allowed_mentions: { parse: [] }, nonce: 'n123', enforce_nonce: true });
});

test('edit uses PATCH on the message path', async () => {
  mock();
  await rest.editEmbedMessage(TOKEN, '523456789012345678', '623456789012345678', EM, 1000);
  const c = calls[0];
  assert.equal(c.init.method, 'PATCH');
  assert.equal(c.url, 'https://discord.com/api/v10/channels/523456789012345678/messages/623456789012345678');
  assert.deepEqual(JSON.parse(c.init.body), { embeds: [EM], allowed_mentions: { parse: [] } });
  assert.equal(c.init.headers.Authorization, `Bot ${TOKEN}`);
});

test('signal abort cancels the request', async () => {
  mock((init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  const ac = new AbortController();
  const p = rest.editEmbedMessage(TOKEN, '523456789012345678', '623456789012345678', EM, 60_000, ac.signal);
  setTimeout(() => ac.abort(), 20);
  const t0 = Date.now();
  await assert.rejects(p);
  assert.ok(Date.now() - t0 < 1000);
});

test('timeout still applies with a signal given', async () => {
  mock((init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  const t0 = Date.now();
  await assert.rejects(rest.postEmbedMessage(TOKEN, '523456789012345678', EM, 'n', 50, new AbortController().signal));
  assert.ok(Date.now() - t0 < 1000);
});

// Final-review fixes
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('a long waiting reason is clipped', () => {
  const em = e.buildStatusEmbed(snap([game()], { state: 'waiting', waitingReason: 'x'.repeat(10_000) }), NOW, NEXT, '0.1.0');
  assert.ok(em.description.length <= 300, `description ${em.description.length}`);
  assert.match(em.description, /…/);
});

test('clipping never splits a surrogate pair', () => {
  for (let pad = 18; pad <= 24; pad++) {
    const em = e.buildStatusEmbed(snap([game({ name: 'a'.repeat(pad) + '😀😀😀😀😀😀' })]), NOW, NEXT, '0.1.0');
    assert.ok(!loneSurrogate.test(em.fields[0].value), `pad ${pad}`);
  }
});

test('a long reason with emoji is clipped without a lone surrogate', () => {
  const em = e.buildStatusEmbed(snap([game()], { state: 'waiting', waitingReason: '😀'.repeat(500) }), NOW, NEXT, '0.1.0');
  assert.ok(!loneSurrogate.test(em.description));
});
