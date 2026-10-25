import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const CFG = path.join(home, '.steam-idler', 'discord.json');
const n = await import(dist('discord/notifier.js'));

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz1234';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_-123';
const BOT = { botToken: TOKEN, applicationId: '123456789012345678', ownerId: '223456789012345678', guildId: '323456789012345678', channelId: '423456789012345678' };
const OPTS = { botTimeoutMs: 50, webhookTimeoutMs: 50 };
const keepalive = setInterval(() => {}, 1000);
after(() => clearInterval(keepalive));

let calls, handler, logs;
console.error = (...a) => logs.push(a.join(' '));
console.log = (...a) => logs.push(a.join(' '));
const write = (obj) => fs.writeFileSync(CFG, JSON.stringify(obj));
const isBot = (c) => c.url.includes('/channels/');
const body = (c) => JSON.parse(c.init.body).content;
beforeEach(() => {
  calls = []; logs = [];
  handler = () => new Response(null, { status: 204 });
  globalThis.fetch = async (url, init) => { const c = { url: String(url), init }; calls.push(c); return handler(c); };
});
const status = (s) => new Response(null, { status: s });
const hang = (c) => new Promise((_, rej) => c.init.signal.addEventListener('abort', () => rej(new Error('aborted'))));

test('bot healthy: posts once to the channel, webhook untouched', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  await d.send('hello');
  assert.equal(calls.length, 1);
  assert.ok(isBot(calls[0]));
  assert.equal(body(calls[0]), 'hello');
});
test('bot post 500: retried via webhook, bot stays up', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  let first = true;
  handler = (c) => { if (isBot(c) && first) { first = false; return status(500); } return status(204); };
  await d.send('hello');
  assert.equal(calls.length, 2);
  assert.ok(!isBot(calls[1]));
  assert.equal(body(calls[1]), 'hello');
  await d.send('again');
  assert.ok(isBot(calls[2]));
});
test('bot post 401: offline notice then message via webhook; later sends skip the bot', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  handler = (c) => (isBot(c) ? status(401) : status(204));
  await d.send('hello');
  assert.equal(calls.length, 3);
  assert.ok(!isBot(calls[1]) && !isBot(calls[2]));
  assert.match(body(calls[1]), /Discord bot offline \(token rejected/);
  assert.ok(!body(calls[1]).includes(TOKEN));
  assert.equal(body(calls[2]), 'hello');
  await d.send('later');
  assert.equal(calls.length, 4);
  assert.ok(!isBot(calls[3]));
  assert.ok(!logs.join('\n').includes(TOKEN));
  assert.ok(!logs.join('\n').includes(HOOK));
});
test('bot post 403 and 404 mark down with their reasons', async () => {
  for (const [s, re] of [[403, /no permission to post/], [404, /notification channel not found/]]) {
    calls.length = 0;
    write({ ...BOT, webhookUrl: HOOK });
    const d = new n.DiscordNotifier(OPTS);
    handler = (c) => (isBot(c) ? status(s) : status(204));
    await d.send('x');
    assert.match(body(calls[1]), re);
    await d.send('y');
    assert.ok(!isBot(calls[calls.length - 1]));
  }
});
test('botDown twice announces once; botUp after non-fatal posts online notice via bot', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  await d.botDown('r1', false);
  await d.botDown('r2', false);
  assert.equal(calls.length, 1);
  assert.ok(!isBot(calls[0]));
  assert.equal(body(calls[0]), "⚠️ Discord bot offline (r1). Notifications are coming through the backup webhook. /add, /remove and /status won't work until the bot is back.");
  await d.botUp();
  assert.ok(isBot(calls[1]));
  assert.equal(body(calls[1]), '✅ Discord bot back online. Commands work again.');
  await d.send('z');
  assert.ok(isBot(calls[2]));
});
test('botUp failure: the next sends try the bot first and switch back with the online notice on success', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  await d.botDown('r', false);
  handler = (c) => (isBot(c) ? status(500) : status(204));
  await d.botUp();
  calls.length = 0;
  await d.send('z');
  assert.ok(isBot(calls[0]) && !isBot(calls[1]), 'bot tried first, webhook carries the message');
  assert.equal(body(calls[1]), 'z');
  handler = () => status(204);
  calls.length = 0;
  await d.send('w');
  assert.deepEqual(calls.map((c) => [isBot(c), body(c)]), [[true, 'w'], [true, '✅ Discord bot back online. Commands work again.']]);
  calls.length = 0;
  await d.send('v');
  assert.ok(calls.length === 1 && isBot(calls[0]), 'route is up again');
});
const ONLINE = '✅ Discord bot back online. Commands work again.';
async function pendingRecovery(d) {
  await d.botDown('r', false);
  handler = (c) => (isBot(c) ? status(500) : status(204));
  await d.botUp(); // online notice fails: recovery pending
}
test('a new outage cancels a pending recovery: a working REST post does not announce "back online"', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  await pendingRecovery(d);
  await d.botDown(n.BOT_DOWN_REASONS.gatewayUnreachable, false);
  handler = () => status(204);
  calls.length = 0;
  await d.send('during outage');
  assert.ok(calls.every((c) => !isBot(c)), 'stays on the webhook');
  assert.ok(!calls.some((c) => body(c) === ONLINE));
  await d.botUp();
  assert.ok(calls.some((c) => isBot(c) && body(c) === ONLINE), 'the real recovery still announces');
});
test('two concurrent sends during recovery post the online notice once', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  await pendingRecovery(d);
  handler = () => new Promise((r) => setTimeout(() => r(status(204)), 10));
  calls.length = 0;
  await Promise.all([d.send('a'), d.send('b')]);
  assert.equal(calls.filter((c) => body(c) === ONLINE).length, 1);
});
test('a fatal close during a recovery post wins: no online notice, route stays fatal', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  await pendingRecovery(d);
  handler = (c) => (isBot(c) ? new Promise((r) => setTimeout(() => r(status(204)), 20)) : status(204));
  calls.length = 0;
  const sending = d.send('a');
  await new Promise((r) => setTimeout(r, 5));
  await d.botDown(n.BOT_DOWN_REASONS.gatewayRejected(4011), true);
  await sending;
  assert.ok(!calls.some((c) => body(c) === ONLINE));
  calls.length = 0;
  await d.send('b');
  assert.ok(calls.length === 1 && !isBot(calls[0]));
});
test('recovery attempt that gets a 403 stops retrying the bot', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  await d.botDown('r', false);
  handler = (c) => (isBot(c) ? status(500) : status(204));
  await d.botUp();
  handler = (c) => (isBot(c) ? status(403) : status(204));
  await d.send('a');
  calls.length = 0;
  await d.send('b');
  assert.ok(calls.length === 1 && !isBot(calls[0]));
});
test('no webhook: a non-fatal fault keeps the bot route', async () => {
  write(BOT);
  const d = new n.DiscordNotifier(OPTS);
  handler = (c) => status(403);
  await d.send('one');
  await d.botDown(n.BOT_DOWN_REASONS.gatewayUnreachable, false);
  handler = () => status(204);
  calls.length = 0;
  await d.send('two');
  assert.ok(calls.length === 1 && isBot(calls[0]) && body(calls[0]) === 'two');
  assert.ok(logs.some((l) => l.includes('no backup webhook')));
});
test('no webhook: a fatal notice goes to the console without promising a webhook', async () => {
  write(BOT);
  const d = new n.DiscordNotifier(OPTS);
  await d.botDown('token rejected', true);
  const out = logs.join('\n');
  assert.match(out, /Discord bot offline \(token rejected\)\. Notifications can't reach Discord until this is fixed\./);
  assert.ok(!out.includes('backup webhook.'));
});
test('an outage that turns fatal is announced a second time', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  await d.botDown(n.BOT_DOWN_REASONS.gatewayUnreachable, false);
  await d.botDown(n.BOT_DOWN_REASONS.tokenRejected, true);
  await d.botDown(n.BOT_DOWN_REASONS.tokenRejected, true);
  assert.equal(calls.length, 2);
  assert.match(body(calls[1]), /token rejected/);
});
test('a 403 notice does not claim the commands stopped working', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  handler = (c) => (isBot(c) ? status(403) : status(204));
  await d.send('x');
  assert.match(body(calls[1]), /no permission to post/);
  assert.ok(!body(calls[1]).includes("won't work"));
});
test('botUp after fatal does nothing', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  await d.botDown('r', true);
  calls.length = 0;
  await d.botUp();
  assert.equal(calls.length, 0);
  await d.send('z');
  assert.ok(!isBot(calls[0]));
});
test('no webhook: bot failure logs to console only and send resolves', async () => {
  write(BOT);
  const d = new n.DiscordNotifier(OPTS);
  handler = () => status(401);
  await d.send('hello');
  assert.equal(calls.length, 1);
  const out = logs.join('\n');
  assert.match(out, /\[discord\]/);
  assert.match(out, /token rejected/);
  assert.ok(!out.includes(TOKEN));
});
test('webhook-only config sends via webhook', async () => {
  write({ webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  assert.equal(d.botConfig(), null);
  assert.ok(d.isConfigured() && d.hasFile());
  await d.send('hi');
  assert.equal(calls.length, 1);
  assert.ok(!isBot(calls[0]));
});
test('disabled config sends nothing', async () => {
  write({ disabled: true });
  const d = new n.DiscordNotifier(OPTS);
  assert.ok(d.hasFile() && !d.isConfigured());
  await d.send('hi');
  await d.botDown('r', false);
  assert.equal(calls.length, 0);
  write({ ...BOT, webhookUrl: HOOK, disabled: true });
  d.reload();
  assert.equal(d.botConfig(), null);
  await d.send('hi');
  assert.equal(calls.length, 0);
});
test('no config file', async () => {
  fs.rmSync(CFG, { force: true });
  const d = new n.DiscordNotifier(OPTS);
  assert.ok(!d.hasFile() && !d.isConfigured());
  await d.send('hi');
  assert.equal(calls.length, 0);
});
test('send resolves within both timeouts when everything hangs', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  handler = hang;
  const t = Date.now();
  await d.send('hi');
  assert.ok(Date.now() - t < 500);
  assert.equal(calls.length, 2);
  assert.ok(!logs.join('\n').includes(HOOK));
});
test('send never rejects when fetch throws synchronously', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  globalThis.fetch = () => { throw new Error('boom'); };
  await d.send('hi');
});
test('multi-part messages keep order across a mid-message failover', async () => {
  write({ ...BOT, webhookUrl: HOOK });
  const d = new n.DiscordNotifier(OPTS);
  const lines = ['a'.repeat(1500), 'b'.repeat(1500), 'c'.repeat(1500)];
  let botCalls = 0;
  handler = (c) => { if (isBot(c)) { botCalls++; return botCalls === 2 ? status(500) : status(204); } return status(204); };
  await d.send(lines.join('\n'));
  const order = calls.map((c) => body(c)[0]);
  assert.deepEqual(order, ['a', 'b', 'b', 'c']);
  assert.ok(isBot(calls[0]) && isBot(calls[1]) && !isBot(calls[2]) && isBot(calls[3]));
});
test('reasons constants', () => {
  assert.match(n.BOT_DOWN_REASONS.gatewayRejected(4011), /code 4011/);
  assert.equal(n.BOT_DOWN_REASONS.gatewayUnreachable, "can't reach Discord for 2 min");
});
test('401/403/404 with hanging webhook stays within bot + webhook timeouts', async () => {
  for (const s of [401, 403, 404]) {
    write({ ...BOT, webhookUrl: HOOK });
    const d = new n.DiscordNotifier(OPTS);
    handler = (c) => (isBot(c) ? status(s) : hang(c));
    const t = Date.now();
    await d.send('hi');
    assert.ok(Date.now() - t < 90, `status ${s} took ${Date.now() - t}ms`);
  }
});
