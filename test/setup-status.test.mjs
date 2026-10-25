// Task 4: --setup-discord with a live status channel
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const s = await import(dist('discord/setup.js'));
const cfg = await import(dist('discord/config.js'));
const store = await import(dist('discord/statusStore.js'));

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz1234';
const APP = '111111111111111111';
const GUILD = '333333333333333333';
const CHAN = '444444444444444444';
const SC = '555555555555555555';
const M1 = '666666666666666666';
const M2 = '777777777777777777';
const base = { token: TOKEN, applicationId: APP, ownerId: '222222222222222222', guildId: GUILD, channelId: CHAN };

const logs = [];
for (const k of ['log', 'error', 'warn']) console[k] = (...a) => logs.push(a.join(' '));

let calls;
let routes;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  calls = [];
  logs.length = 0;
  for (const p of [cfg.CONFIG_PATH, store.STATUS_PATH]) { try { fs.rmSync(p); } catch {} }
  routes = {
    [`POST /channels/${CHAN}/messages`]: () => new Response(null, { status: 200 }),
    [`PUT /applications/${APP}/guilds/${GUILD}/commands`]: () => new Response(null, { status: 200 }),
    [`POST /channels/${SC}/messages`]: () => json({ id: M1, embeds: [{}] }),
    [`PATCH /channels/${SC}/messages/${M1}`]: () => json({ id: M1, embeds: [{}] }),
  };
  globalThis.fetch = async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${String(url).replace('https://discord.com/api/v10', '')}`;
    calls.push({ key, body: init?.body ? JSON.parse(init.body) : null });
    const h = routes[key];
    return h ? h() : json({}, 404);
  };
});

test('invite asks for 19456', () => {
  assert.equal(s.inviteUrl(APP), `https://discord.com/oauth2/authorize?client_id=${APP}&scope=bot%20applications.commands&permissions=19456`);
});

test('no status channel: no embed request', async () => {
  await s.finishSetup({ ...base, statusChannelId: null }, null, '0.1.0');
  assert.ok(!calls.some((c) => c.key.includes(SC)));
  assert.equal(fs.existsSync(store.STATUS_PATH), false);
  assert.equal(cfg.loadDiscordConfig().bot.statusChannelId, null);
});

test('status channel: placeholder posted and id saved', async () => {
  await s.finishSetup({ ...base, statusChannelId: SC }, null, '0.1.0');
  const post = calls.find((c) => c.key === `POST /channels/${SC}/messages`);
  assert.ok(post, 'placeholder posted');
  assert.equal(post.body.embeds[0].description, '⏳ Waiting for idling to start');
  assert.equal(post.body.embeds[0].footer.text, 'steamidler v0.1.0');
  assert.deepEqual(store.loadStatusMessage(), { channelId: SC, messageId: M1 });
  assert.equal(cfg.loadDiscordConfig().bot.statusChannelId, SC);
  // registration happens before the placeholder, saving after it
  const order = calls.map((c) => c.key);
  assert.ok(order.indexOf(`PUT /applications/${APP}/guilds/${GUILD}/commands`) < order.indexOf(`POST /channels/${SC}/messages`));
});

test('rerun edits the stored placeholder instead of posting', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  await s.finishSetup({ ...base, statusChannelId: SC }, null, '0.1.0');
  assert.ok(calls.some((c) => c.key === `PATCH /channels/${SC}/messages/${M1}`));
  assert.ok(!calls.some((c) => c.key === `POST /channels/${SC}/messages`));
});

test('rerun posts anew when the stored placeholder was deleted', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  routes[`PATCH /channels/${SC}/messages/${M1}`] = () => json({ code: 10008 }, 404);
  routes[`POST /channels/${SC}/messages`] = () => json({ id: M2, embeds: [{}] });
  await s.finishSetup({ ...base, statusChannelId: SC }, null, '0.1.0');
  assert.deepEqual(store.loadStatusMessage(), { channelId: SC, messageId: M2 });
});

test('empty embeds aborts setup and saves nothing', async () => {
  routes[`POST /channels/${SC}/messages`] = () => json({ id: M1, embeds: [] });
  await assert.rejects(s.finishSetup({ ...base, statusChannelId: SC }, null, '0.1.0'), /Embed Links/);
  assert.equal(fs.existsSync(cfg.CONFIG_PATH), false);
  assert.equal(fs.existsSync(store.STATUS_PATH), false);
});

test('403 on placeholder aborts setup and saves nothing', async () => {
  routes[`POST /channels/${SC}/messages`] = () => json({ message: `Missing Access ${TOKEN}` }, 403);
  await assert.rejects(s.finishSetup({ ...base, statusChannelId: SC }, null, '0.1.0'), (e) => e.status === 403 && !e.message.includes(TOKEN));
  assert.equal(fs.existsSync(cfg.CONFIG_PATH), false);
  assert.equal(fs.existsSync(store.STATUS_PATH), false);
});

test('a network failure on the placeholder aborts setup', async () => {
  routes[`POST /channels/${SC}/messages`] = () => { throw new Error(`down ${TOKEN}`); };
  await assert.rejects(s.finishSetup({ ...base, statusChannelId: SC }, null, '0.1.0'), (e) => e.status === 0 && !e.message.includes(TOKEN));
  assert.equal(fs.existsSync(cfg.CONFIG_PATH), false);
});

// Final-review fixes
test('403 at setup names the permissions fix', async () => {
  routes[`POST /channels/${SC}/messages`] = () => json({ code: 50013 }, 403);
  await assert.rejects(s.finishSetup({ ...base, statusChannelId: SC }, null, '0.1.0'), (e) => e.status === 403 && /Embed Links/.test(e.message));
});

test('code 50006 at setup names Embed Links', async () => {
  routes[`POST /channels/${SC}/messages`] = () => json({ code: 50006 }, 400);
  await assert.rejects(s.finishSetup({ ...base, statusChannelId: SC }, null, '0.1.0'), /Embed Links/);
  assert.equal(fs.existsSync(cfg.CONFIG_PATH), false);
});

test('a stored message from another bot falls back to a post at setup', async () => {
  store.saveStatusMessage({ channelId: SC, messageId: M1 });
  routes[`PATCH /channels/${SC}/messages/${M1}`] = () => json({ code: 50005 }, 403);
  routes[`POST /channels/${SC}/messages`] = () => json({ id: M2, embeds: [{}] });
  await s.finishSetup({ ...base, statusChannelId: SC }, null, '0.1.0');
  assert.deepEqual(store.loadStatusMessage(), { channelId: SC, messageId: M2 });
});
