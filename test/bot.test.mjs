// Offline tests for src/discord/bot.ts: discord.js is replaced by fake/discord.mjs
// (via --import fake/register.mjs) and fetch is mocked, so nothing leaves the machine.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dist } from './helpers.mjs';

const { startBot, isDiscordLibraryError } = await import(dist('discord/bot.js'));
const { BOT_DOWN_REASONS } = await import(dist('discord/notifier.js'));
const { NOT_ALLOWED_REPLY } = await import(dist('discord/commands.js'));
const { control } = await import('discord.js'); // the fake

const TOKEN = 'FAKE.BOT-TOKEN.SECRET123';
const BOT = { token: TOKEN, applicationId: '111', ownerId: '222', guildId: '333', channelId: '444' };
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const esc = (s) => s.replace(/[\\*_~`|[\]]/g, '\\$&');
const logins = () => control.clients.reduce((n, c) => n + c.logins, 0);

let logs, unhandled, notifier, fetchCalls, origError;
const onUnhandled = (e) => unhandled.push(e);
beforeEach(() => {
  logs = []; unhandled = []; fetchCalls = [];
  control.clients.length = 0;
  control.loginImpl = async () => 'ok';
  control.destroyImpl = async () => {};
  notifier = { downs: [], ups: 0, botDown: async (r, f) => { notifier.downs.push([r, f]); }, botUp: async () => { notifier.ups++; } };
  globalThis.fetch = async (url, init) => { fetchCalls.push({ url: String(url), init }); return { ok: true, status: 200 }; };
  origError = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  console.error = origError;
  process.off('unhandledRejection', onUnhandled);
  mock.timers.reset();
  assert.deepEqual(unhandled, [], 'no unhandled rejections');
  for (const l of logs) assert.ok(!l.includes(TOKEN), `token leaked in log: ${l}`);
});

function makePanel(libraryNames = ['Portal', 'Portal 2', 'Dota'], selectedIds = [1]) {
  const library = libraryNames.map((name, i) => ({ appid: i + 1, name }));
  let selected = [...selectedIds];
  return {
    added: [], removed: [],
    library: () => library,
    selection: () => selected.map((id) => ({ appid: id, name: library.find((g) => g.appid === id).name, state: 'idling' })),
    busyReason: () => null,
    waitingReason: () => null,
    add(id) { this.added.push(id); selected.push(id); },
    remove(id) { this.removed.push(id); selected = selected.filter((x) => x !== id); },
  };
}

function interaction({ kind = 'command', name, userId = BOT.ownerId, guildId = BOT.guildId, value = '', replyImpl } = {}) {
  const calls = { replies: [], followUps: [], responds: [] };
  return {
    calls,
    user: { id: userId }, guildId, commandName: name,
    isAutocomplete: () => kind === 'autocomplete',
    isChatInputCommand: () => kind === 'command',
    options: { getString: () => value, getFocused: () => value },
    reply: async (o) => { calls.replies.push(o); if (replyImpl) await replyImpl(o); },
    followUp: async (o) => { calls.followUps.push(o); },
    respond: async (c) => { calls.responds.push(c); },
  };
}

async function started(panel = makePanel()) {
  const handle = startBot(BOT, panel, notifier);
  await flush();
  return { handle, client: control.clients.at(-1), panel };
}

test('registers guild commands, then logs in with only the Guilds intent and no mentions', async () => {
  const { client, handle } = await started();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://discord.com/api/v10/applications/111/guilds/333/commands');
  assert.equal(fetchCalls[0].init.method, 'PUT');
  assert.equal(client.logins, 1);
  assert.equal(client.lastToken, TOKEN);
  assert.deepEqual(client.options.intents, [1]);
  assert.deepEqual(client.options.allowedMentions, { parse: [] });
  await handle.destroy();
});

test('registration 401 reports the token fatally and never opens the Gateway', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  await started();
  assert.deepEqual(notifier.downs, [[BOT_DOWN_REASONS.tokenRejected, true]]);
  assert.equal(logins(), 0);
  assert.equal(control.clients.length, 0);
});

test('registration HTTP 500 or network error is logged (redacted) and login still happens', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  let { client } = await started();
  assert.equal(client.logins, 1);
  assert.ok(logs.some((l) => l.includes('HTTP 500')));
  globalThis.fetch = async () => { throw new Error(`connect ECONNRESET https://discord.com/api/v10/x?t=${TOKEN} ${TOKEN}`); };
  ({ client } = await started());
  assert.equal(client.logins, 1);
  const line = logs.find((l) => l.includes('command registration failed'));
  assert.ok(line && line.includes('<url>') && line.includes('<token>'), line);
  assert.deepEqual(notifier.downs, []);
});

test('login with a rejected token reports fatally and does not retry', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  control.loginImpl = async () => { throw Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' }); };
  await started();
  assert.deepEqual(notifier.downs, [[BOT_DOWN_REASONS.tokenRejected, true]]);
  mock.timers.tick(20 * 60_000); await flush();
  assert.equal(logins(), 1);
});

test('login network failure retries at 30 s then 60 s, goes offline after 2 min, and destroy stops retries', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  control.loginImpl = async () => { throw new Error('getaddrinfo ENOTFOUND discord.com'); };
  const { handle } = await started();
  assert.equal(logins(), 1);
  mock.timers.tick(29_999); await flush(); assert.equal(logins(), 1);
  mock.timers.tick(1); await flush(); assert.equal(logins(), 2);
  mock.timers.tick(59_999); await flush(); assert.equal(logins(), 2);
  mock.timers.tick(1); await flush(); assert.equal(logins(), 3);
  assert.deepEqual(notifier.downs, []); // t = 90 s, still inside the grace
  mock.timers.tick(30_000); await flush(); // t = 120 s
  assert.deepEqual(notifier.downs, [[BOT_DOWN_REASONS.gatewayUnreachable, false]]);
  await handle.destroy();
  mock.timers.tick(60 * 60_000); await flush();
  assert.equal(logins(), 3);
  assert.equal(notifier.downs.length, 1);
});

test('each retry uses a fresh Client and a failed one can no longer answer commands', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let fail = true;
  control.loginImpl = async () => { if (fail) throw new Error('ETIMEDOUT'); return 'ok'; };
  const { panel, handle } = await started();
  const failed = control.clients[0];
  fail = false;
  mock.timers.tick(30_000); await flush();
  assert.equal(control.clients.length, 2);
  assert.ok(control.clients.every((c) => c.logins === 1));
  const ghost = interaction({ name: 'add', value: '2' });
  failed.emit('interactionCreate', ghost); await flush();
  assert.deepEqual(ghost.calls.replies, []);
  assert.deepEqual(panel.added, []);
  failed.emit('error', new Error('late')); // must not throw
  const live = interaction({ name: 'add', value: '2' });
  control.clients[1].emit('interactionCreate', live); await flush();
  assert.deepEqual(panel.added, [2]);
  await handle.destroy();
  assert.equal(control.clients[1].destroyed, 1);
});

test('a fatal close during a failing first login is not retried', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  control.loginImpl = async () => {
    control.clients.at(-1).emit('shardDisconnect', { code: 4004 }, 0);
    throw new Error('Authentication failed');
  };
  await started();
  assert.deepEqual(notifier.downs, [[BOT_DOWN_REASONS.tokenRejected, true]]);
  mock.timers.tick(60 * 60_000); await flush();
  assert.equal(logins(), 1);
  assert.equal(notifier.downs.length, 1);
});

test('backoff caps at 5 min', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  control.loginImpl = async () => { throw new Error('ETIMEDOUT'); };
  const { handle } = await started();
  for (const wait of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) { mock.timers.tick(wait); await flush(); }
  assert.equal(logins(), 7);
  mock.timers.tick(299_999); await flush(); assert.equal(logins(), 7);
  mock.timers.tick(1); await flush(); assert.equal(logins(), 8);
  await handle.destroy();
});

test('destroy while registration is still pending never logs in', async () => {
  let release;
  globalThis.fetch = () => new Promise((r) => { release = () => r({ ok: true, status: 200 }); });
  const handle = startBot(BOT, makePanel(), notifier);
  await handle.destroy();
  release(); await flush();
  assert.equal(logins(), 0);
  assert.equal(control.clients.length, 0);
});

test('gateway events: fatal close reports at once; reconnect over 2 min reports once; ready reports up', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let { client, handle } = await started();
  client.emit('shardDisconnect', { code: 4004 }, 0);
  await flush();
  assert.deepEqual(notifier.downs, [[BOT_DOWN_REASONS.tokenRejected, true]]);
  await handle.destroy();

  notifier.downs = [];
  ({ client, handle } = await started());
  client.emit('shardReconnecting', 0);
  mock.timers.tick(60_000); client.emit('shardReconnecting', 0);
  mock.timers.tick(60_000); await flush();
  assert.deepEqual(notifier.downs, [[BOT_DOWN_REASONS.gatewayUnreachable, false]]);
  client.emit('shardReady', 0, undefined); await flush();
  assert.equal(notifier.ups, 1);
  client.emit('shardReconnecting', 0); mock.timers.tick(10_000); client.emit('shardResume', 0, 3);
  mock.timers.tick(300_000); await flush();
  assert.equal(notifier.downs.length, 1, 'a short blip after recovery stays silent');
  await handle.destroy();
});

test('destroy stops health first, closes the client once, and survives a failing close', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  control.destroyImpl = async () => { throw new Error(`close failed ${TOKEN}`); };
  const { client, handle } = await started();
  await handle.destroy();
  assert.equal(client.destroyed, 1);
  client.emit('shardReconnecting', 0);
  mock.timers.tick(10 * 60_000); await flush();
  assert.deepEqual(notifier.downs, []);
  assert.ok(logs.some((l) => l.includes('disconnect failed') && l.includes('<token>')));
});

test('client and gateway error events are logged redacted and never throw', async () => {
  const { client, handle } = await started();
  client.emit('error', new Error(`boom ${TOKEN} https://discord.com/api/v10/interactions/9/SECRETX/callback`));
  client.emit('shardError', new Error('socket hang up'), 0);
  assert.ok(logs.some((l) => l.includes('client error') && l.includes('<token>') && l.includes('<url>') && !l.includes('SECRETX')));
  assert.ok(logs.some((l) => l.includes('gateway error: socket hang up')));
  await handle.destroy();
});

test('owner lock: other user, other server and DMs are refused for commands and autocomplete', async () => {
  const { client, panel, handle } = await started();
  for (const ctx of [{ userId: '999' }, { guildId: '777' }, { guildId: null }]) {
    const cmd = interaction({ name: 'add', value: '2', ...ctx });
    client.emit('interactionCreate', cmd); await flush();
    assert.deepEqual(cmd.calls.replies, [{ content: esc(NOT_ALLOWED_REPLY), flags: 68, allowedMentions: { parse: [] } }]);
    const ac = interaction({ kind: 'autocomplete', name: 'add', value: 'po', ...ctx });
    client.emit('interactionCreate', ac); await flush();
    assert.deepEqual(ac.calls.responds, [[]]);
  }
  assert.deepEqual(panel.added, []);
  await handle.destroy();
});

test('owner autocomplete, /add with a hostile name, /remove, spoofed value, unknown command, non-command interactions', async () => {
  const hostile = '**Bold** @everyone [x](http://y)';
  const { client, panel, handle } = await started(makePanel(['Portal', hostile, 'Dota'], [1]));
  const ac = interaction({ kind: 'autocomplete', name: 'add', value: '' });
  client.emit('interactionCreate', ac); await flush();
  assert.deepEqual(ac.calls.responds[0].map((c) => c.value).sort(), ['2', '3']);

  const add = interaction({ name: 'add', value: '2' });
  client.emit('interactionCreate', add); await flush();
  assert.deepEqual(panel.added, [2]);
  const reply = add.calls.replies[0];
  assert.equal(reply.flags, 68);
  assert.deepEqual(reply.allowedMentions, { parse: [] });
  assert.ok(reply.content.includes('\\*\\*Bold\\*\\*') && reply.content.includes('\\[x\\]'), reply.content);

  const rm = interaction({ name: 'remove', value: '2' });
  client.emit('interactionCreate', rm); await flush();
  assert.deepEqual(panel.removed, [2]);

  const spoof = interaction({ name: 'add', value: '1e3' });
  client.emit('interactionCreate', spoof); await flush();
  assert.equal(spoof.calls.replies[0].content, 'Unknown game.');

  const unknown = interaction({ name: 'quit' });
  client.emit('interactionCreate', unknown); await flush();
  assert.equal(unknown.calls.replies[0].content, 'Unknown command.');

  const button = interaction({ kind: 'button', name: 'add' });
  client.emit('interactionCreate', button); await flush();
  assert.deepEqual(button.calls, { replies: [], followUps: [], responds: [] });
  await handle.destroy();
});

test('/status with 32 long names is split into ephemeral parts of at most 2000 characters', async () => {
  const names = Array.from({ length: 32 }, (_, i) => `${'*'.repeat(150)} Game ${i}`);
  const { client, handle } = await started(makePanel(names, names.map((_, i) => i + 1)));
  const st = interaction({ name: 'status' });
  client.emit('interactionCreate', st); await flush();
  const parts = [st.calls.replies[0], ...st.calls.followUps];
  assert.ok(parts.length > 1, `expected a split, got ${parts.length}`);
  for (const p of parts) {
    assert.ok(p.content.length <= 2000, `part of ${p.content.length}`);
    assert.equal(p.flags, 68);
    assert.deepEqual(p.allowedMentions, { parse: [] });
  }
  assert.ok(parts.map((p) => p.content).join('\n').includes('Game 31'));
  await handle.destroy();
});

test('a failed reply (expired interaction) is logged without its callback URL and never rejects', async () => {
  const { client, handle } = await started();
  const st = interaction({ name: 'status', replyImpl: async () => { throw new Error('Unknown interaction https://discord.com/api/v10/interactions/1/SECRETINTERACTIONTOKEN/callback'); } });
  client.emit('interactionCreate', st); await flush();
  const line = logs.find((l) => l.includes('command reply failed'));
  assert.ok(line && line.includes('<url>') && !line.includes('SECRETINTERACTIONTOKEN'), line);
  await handle.destroy();
});

test('isDiscordLibraryError matches only rejections raised inside the Discord libraries', () => {
  const at = (path) => Object.assign(new Error('x'), { stack: `Error: x\n    at f (${path}:1:1)` });
  assert.ok(isDiscordLibraryError(at('/opt/steamidler/node_modules/.pnpm/@discordjs+ws@1.2.3/node_modules/@discordjs/ws/dist/index.js')));
  assert.ok(isDiscordLibraryError(at(String.raw`C:\app\node_modules\.pnpm\discord.js@14.27.0\node_modules\discord.js\src\client\Client.js`)));
  assert.ok(!isDiscordLibraryError(at(String.raw`C:\app\dist\discord\bot.js`)));
  assert.ok(!isDiscordLibraryError(at('/opt/steamidler/dist/discord/bot.js')), 'our own bot code is a real crash');
  assert.ok(!isDiscordLibraryError(at('/opt/steamidler/dist/index.js')));
  assert.ok(!isDiscordLibraryError(at('/opt/steamidler/node_modules/steam-user/index.js')));
  assert.ok(!isDiscordLibraryError('a string reason'));
  assert.ok(!isDiscordLibraryError(undefined));
});
