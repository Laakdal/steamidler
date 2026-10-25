import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const r = await import(dist('discord/rest.js'));

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz1234';
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(null, { status: 204 }); };
const BODY = { content: 'hi @everyone', allowed_mentions: { parse: [] }, flags: 4 };

test('postChannelMessage', async () => {
  calls.length = 0;
  await r.postChannelMessage(TOKEN, '123', 'hi @everyone', 5000);
  const { url, init } = calls[0];
  assert.equal(url, 'https://discord.com/api/v10/channels/123/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bot ${TOKEN}`);
  assert.deepEqual(JSON.parse(init.body), BODY);
  assert.ok(init.signal);
});
test('postWebhook has no Authorization header', async () => {
  calls.length = 0;
  const W = 'https://discord.com/api/webhooks/123/abc';
  await r.postWebhook(W, 'hi @everyone', 5000);
  const { url, init } = calls[0];
  assert.equal(url, W);
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), BODY);
  assert.ok(!Object.keys(init.headers).some((k) => k.toLowerCase() === 'authorization'));
});
test('registerCommands PUTs three commands', async () => {
  calls.length = 0;
  await r.registerCommands({ token: TOKEN, applicationId: '111111111111111111', guildId: '222222222222222222', ownerId: '333333333333333333', channelId: '444444444444444444' });
  const { url, init } = calls[0];
  assert.equal(url, 'https://discord.com/api/v10/applications/111111111111111111/guilds/222222222222222222/commands');
  assert.equal(init.method, 'PUT');
  assert.equal(init.headers.Authorization, `Bot ${TOKEN}`);
  const cmds = JSON.parse(init.body);
  assert.deepEqual(cmds.map((x) => x.name), ['add', 'remove', 'status']);
  for (const x of cmds) { assert.equal(x.default_member_permissions, '0'); assert.equal(x.type, 1); }
  for (const x of cmds.slice(0, 2)) {
    assert.equal(x.options.length, 1);
    assert.equal(x.options[0].name, 'game');
    assert.equal(x.options[0].type, 3);
    assert.equal(x.options[0].required, true);
    assert.equal(x.options[0].autocomplete, true);
  }
  assert.equal(cmds[2].options, undefined);
});
test('discordApi aborts on timeout', async () => {
  globalThis.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const keepAlive = setTimeout(() => {}, 2000); // AbortSignal.timeout is unref'd; keep the loop alive
  try {
    await assert.rejects(r.discordApi(TOKEN, 'GET', '/users/@me', undefined, 20), /abort/);
  } finally {
    clearTimeout(keepAlive);
  }
});
test('DiscordApiError carries status and message', () => {
  const e = new r.DiscordApiError(401, 'unauthorized');
  assert.ok(e instanceof Error);
  assert.equal(e.status, 401);
  assert.ok(!e.message.includes(TOKEN));
});
