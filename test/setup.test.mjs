import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const s = await import(dist('discord/setup.js'));
const cfg = await import(dist('discord/config.js'));
const rest = await import(dist('discord/rest.js'));

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz1234';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL123';
const APP = '111111111111111111';
const OWNER = '222222222222222222';
const GUILD = '333333333333333333';
const CHAN = '444444444444444444';
const bot = { token: TOKEN, applicationId: APP, ownerId: OWNER, guildId: GUILD, channelId: CHAN, statusChannelId: null };

const logs = [];
for (const k of ['log', 'error', 'warn']) console[k] = (...a) => logs.push(a.join(' '));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
let routes = {};
let calls = [];
function mock(r) {
  routes = r;
  calls = [];
  globalThis.fetch = async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${String(url).replace('https://discord.com/api/v10', '')}`;
    calls.push(key);
    const h = routes[key] ?? routes[String(url)];
    if (!h) return json({}, 404);
    return typeof h === 'function' ? h(init) : h.clone();
  };
}
function reset() { try { fs.rmSync(cfg.CONFIG_PATH); } catch {} }

test('fetchBotIdentity returns app id, bot name and owner', async () => {
  mock({
    'GET /users/@me': json({ id: '555555555555555555', username: 'idlebot', bot: true }),
    'GET /oauth2/applications/@me': json({ id: APP, name: 'app', owner: { id: OWNER, username: 'alice' } }),
  });
  assert.deepEqual(await s.fetchBotIdentity(TOKEN), {
    applicationId: APP, botName: 'idlebot', owners: [{ id: OWNER, name: 'alice' }],
  });
});
test('fetchBotIdentity lists team members when team-owned', async () => {
  mock({
    'GET /users/@me': json({ id: '555555555555555555', username: 'idlebot', bot: true }),
    'GET /oauth2/applications/@me': json({ id: APP, name: 'app', team: { members: [
      { user: { id: OWNER, username: 'alice' } }, { user: { id: '666666666666666666', username: 'bob' } }] } }),
  });
  const id = await s.fetchBotIdentity(TOKEN);
  assert.deepEqual(id.owners, [{ id: OWNER, name: 'alice' }, { id: '666666666666666666', name: 'bob' }]);
});
test('fetchBotIdentity rejects a non-bot token without leaking it', async () => {
  mock({ 'GET /users/@me': json({ id: '555555555555555555', username: 'human' }) });
  await assert.rejects(s.fetchBotIdentity(TOKEN), (e) => !e.message.includes(TOKEN) && /bot/i.test(e.message));
});
test('fetchBotIdentity throws DiscordApiError(401)', async () => {
  mock({ 'GET /users/@me': json({ message: 'secret body' }, 401) });
  await assert.rejects(s.fetchBotIdentity(TOKEN), (e) =>
    e instanceof rest.DiscordApiError && e.status === 401 && !e.message.includes(TOKEN) && !e.message.includes('secret body'));
});
test('listGuilds and guildOwnerId', async () => {
  mock({
    'GET /users/@me/guilds': json([{ id: GUILD, name: 'g', icon: 'x' }]),
    [`GET /guilds/${GUILD}`]: json({ id: GUILD, name: 'g', owner_id: OWNER }),
  });
  assert.deepEqual(await s.listGuilds(TOKEN), [{ id: GUILD, name: 'g' }]);
  assert.equal(await s.guildOwnerId(TOKEN, GUILD), OWNER);
});
test('listTextChannels keeps only type 0, sorted by position', async () => {
  mock({ [`GET /guilds/${GUILD}/channels`]: json([
    { id: '1', name: 'voice', type: 2, position: 0 },
    { id: '2', name: 'b', type: 0, position: 3 },
    { id: '3', name: 'a', type: 0, position: 1 },
  ]) });
  assert.deepEqual(await s.listTextChannels(TOKEN, GUILD), [{ id: '3', name: 'a' }, { id: '2', name: 'b' }]);
});
test('inviteUrl exact string', () => {
  assert.equal(s.inviteUrl(APP),
    'https://discord.com/oauth2/authorize?client_id=111111111111111111&scope=bot%20applications.commands&permissions=19456');
});

const okRoutes = () => ({
  [`POST /channels/${CHAN}/messages`]: new Response(null, { status: 200 }),
  [`PUT /applications/${APP}/guilds/${GUILD}/commands`]: new Response(null, { status: 200 }),
  [HOOK]: new Response(null, { status: 204 }),
});

test('finishSetup saves after bot post, webhook post and registration succeed', async () => {
  reset();
  mock(okRoutes());
  await s.finishSetup(bot, HOOK);
  const c = cfg.loadDiscordConfig();
  assert.deepEqual(c.bot, bot);
  assert.equal(c.webhookUrl, HOOK);
});
test('finishSetup sends the exact test messages', async () => {
  reset();
  const sent = [];
  const r = okRoutes();
  for (const k of [`POST /channels/${CHAN}/messages`, HOOK]) {
    r[k] = (init) => { sent.push(JSON.parse(init.body).content); return new Response(null, { status: 200 }); };
  }
  mock(r);
  await s.finishSetup(bot, HOOK);
  assert.deepEqual(sent, ['✅ steamidler bot connected.', '✅ steamidler backup webhook connected.']);
});
test('finishSetup saves nothing when registration fails', async () => {
  reset();
  const r = okRoutes();
  r[`PUT /applications/${APP}/guilds/${GUILD}/commands`] = new Response('body', { status: 403 });
  mock(r);
  await assert.rejects(s.finishSetup(bot, HOOK), (e) => e instanceof rest.DiscordApiError && e.status === 403
    && !e.message.includes(TOKEN) && !e.message.includes(HOOK));
  assert.equal(fs.existsSync(cfg.CONFIG_PATH), false);
});
test('finishSetup saves nothing when the bot post fails', async () => {
  reset();
  const r = okRoutes();
  r[`POST /channels/${CHAN}/messages`] = new Response(null, { status: 403 });
  mock(r);
  await assert.rejects(s.finishSetup(bot, null), (e) => e.status === 403);
  assert.equal(fs.existsSync(cfg.CONFIG_PATH), false);
});
test('finishSetup saves nothing when the webhook test fails', async () => {
  reset();
  const r = okRoutes();
  r[HOOK] = new Response('x', { status: 404 });
  mock(r);
  await assert.rejects(s.finishSetup(bot, HOOK), (e) => e instanceof rest.DiscordApiError && e.status === 404 && !e.message.includes(HOOK));
  assert.equal(fs.existsSync(cfg.CONFIG_PATH), false);
});
test('finishSetup without a webhook skips the webhook post', async () => {
  reset();
  mock(okRoutes());
  await s.finishSetup(bot, null);
  assert.ok(!calls.some((c) => c.includes('webhooks')));
  const c = cfg.loadDiscordConfig();
  assert.deepEqual(c.bot, bot);
  assert.equal(c.webhookUrl, null);
});
test('no console output contains the token or webhook URL', () => {
  assert.ok(!logs.some((l) => l.includes(TOKEN) || l.includes(HOOK)));
});
