import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const c = await import(dist('discord/config.js'));
const f = await import(dist('discord/format.js'));

const FILE = path.join(home, '.steam-idler', 'discord.json');
const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz1234';
const bot = { botToken: TOKEN, applicationId: '123456789012345678', ownerId: '223456789012345678', guildId: '323456789012345678', channelId: '423456789012345678' };
const W = 'https://discord.com/api/webhooks/123/abc-DEF_9';

function load(obj) {
  fs.writeFileSync(FILE, typeof obj === 'string' ? obj : JSON.stringify(obj));
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try { return { result: c.loadDiscordConfig(), errors }; } finally { console.error = orig; }
}

test('valid full file loads with bot and disabled false', () => {
  const { result } = load({ ...bot, webhookUrl: W });
  assert.deepEqual(result, { bot: { token: TOKEN, applicationId: bot.applicationId, ownerId: bot.ownerId, guildId: bot.guildId, channelId: bot.channelId, statusChannelId: null }, webhookUrl: W, disabled: false });
});
test('webhook-only file loads with bot null', () => {
  const { result } = load({ webhookUrl: W });
  assert.deepEqual(result, { bot: null, webhookUrl: W, disabled: false });
});
test('disabled file loads disabled true', () => {
  const { result } = load({ disabled: true });
  assert.deepEqual(result, { bot: null, webhookUrl: null, disabled: true });
});
test('missing file returns null', () => {
  fs.rmSync(FILE, { force: true });
  assert.equal(c.loadDiscordConfig(), null);
});
test('webhook is normalized on load', () => {
  assert.equal(load({ webhookUrl: `${W}/?wait=true` }).result.webhookUrl, W);
});
const { channelId, ...noChannel } = bot;
for (const [name, obj] of [
  ['missing channelId', noChannel],
  ['ownerId abc', { ...bot, ownerId: 'abc' }],
  ['guildId number', { ...bot, guildId: 123 }],
  ['short botToken', { ...bot, botToken: 'short' }],
  ['evil webhook', { webhookUrl: 'https://evil.example/api/webhooks/1/x' }],
  ['unparseable JSON', '{nope'],
]) {
  test(`rejects ${name}`, () => {
    const { result, errors } = load(obj);
    assert.equal(result, null);
    assert.ok(errors.length >= 1 && errors.every((e) => e.includes('discord.json')), errors.join('|'));
    assert.ok(errors.every((e) => !e.includes(TOKEN) && !e.includes('evil.example')));
  });
}

test('save then load round-trips with flat keys only', () => {
  const cfg = { bot: { token: TOKEN, applicationId: bot.applicationId, ownerId: bot.ownerId, guildId: bot.guildId, channelId: bot.channelId, statusChannelId: null }, webhookUrl: W };
  assert.equal(c.saveDiscordConfig(cfg), true);
  assert.deepEqual(c.loadDiscordConfig(), { ...cfg, disabled: false });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8'))).sort(), ['applicationId', 'botToken', 'channelId', 'guildId', 'ownerId', 'webhookUrl']);
});
test('save with nulls writes no bot keys; saveDiscordDisabled writes disabled', () => {
  assert.equal(c.saveDiscordConfig({ bot: null, webhookUrl: W }), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8'))), ['webhookUrl']);
  assert.equal(c.saveDiscordDisabled(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), { disabled: true });
});
test('save never throws when dir is unwritable', () => {
  fs.rmSync(path.join(home, '.steam-idler'), { recursive: true, force: true });
  fs.writeFileSync(path.join(home, '.steam-idler'), 'a file, not a dir');
  const orig = console.error; console.error = () => {};
  try { assert.equal(c.saveDiscordDisabled(), false); } finally { console.error = orig; }
  fs.rmSync(path.join(home, '.steam-idler'));
  fs.mkdirSync(path.join(home, '.steam-idler'));
});
test('snowflake and token shape guards', () => {
  assert.equal(c.isSnowflake('123456789012345678'), true);
  assert.equal(c.isSnowflake('1234'), false);
  assert.equal(c.isSnowflake(123456789012345678), false);
  assert.equal(c.isBotTokenShape(TOKEN), true);
  assert.equal(c.isBotTokenShape('short'), false);
  assert.equal(c.isBotTokenShape(undefined), false);
});

// ported checks
test('parseWebhookUrl accepts/normalizes', () => {
  assert.equal(c.parseWebhookUrl(W), W);
  assert.equal(c.parseWebhookUrl(`  ${W}/ `), W);
  for (const h of ['discordapp.com', 'canary.discord.com', 'ptb.discord.com'])
    assert.equal(c.parseWebhookUrl(`https://${h}/api/webhooks/1/x`), `https://${h}/api/webhooks/1/x`);
  assert.ok(c.parseWebhookUrl('https://discord.com/api/v10/webhooks/1/x'));
  assert.equal(c.parseWebhookUrl(`${W}?wait=true&thread_id=456&x=1#frag`), `${W}?thread_id=456`);
  assert.equal(c.parseWebhookUrl(`${W}?wait=true`), W);
});
test('parseWebhookUrl rejects', () => {
  for (const bad of [
    'http://discord.com/api/webhooks/1/x', 'https://discord.com.evil.com/api/webhooks/1/x', 'https://evil.com/discord.com/api/webhooks/1/x',
    'https://evildiscord.com/api/webhooks/1/x', 'https://user:pw@discord.com/api/webhooks/1/x', 'https://discord.com:8443/api/webhooks/1/x',
    'https://discord.com/api/webhooks/1', 'https://discord.com/api/webhooks/1/x/extra', 'https://discord.com/api/webhooks/abc/x',
    'discord.com/api/webhooks/1/x', '', 'not a url', `${W}?thread_id=abc`, 'https://discord.gg/api/webhooks/1/x'])
    assert.equal(c.parseWebhookUrl(bad), null, bad);
});
const R = String.raw;
test('escapeMarkdown', () => {
  assert.equal(f.escapeMarkdown('[click](http://x)'), R`\[click\](http://x)`);
  assert.equal(f.escapeMarkdown('**b** _i_ ~~s~~ `c` ||sp||'), R`\*\*b\*\* \_i\_ \~\~s\~\~ ` + '\\`c\\`' + R` \|\|sp\|\|`);
  assert.equal(f.escapeMarkdown('# h\n- l\n  > q'), R`\# h` + '\n' + R`\- l` + '\n' + R`  \> q`);
  assert.equal(f.escapeMarkdown('7-30 days, a > b, C# rocks'), '7-30 days, a > b, C# rocks');
  const B = String.fromCharCode(92);
  assert.equal(f.escapeMarkdown('C:' + B + 'x'), 'C:' + B + B + 'x');
});
test('splitMessage', () => {
  assert.equal(f.MAX_CONTENT_LENGTH, 2000);
  assert.deepEqual(f.splitMessage('hello\nworld'), ['hello\nworld']);
  assert.deepEqual(f.splitMessage(''), []);
  assert.deepEqual(f.splitMessage(' \n \n'), []);
  assert.deepEqual(f.splitMessage('x'.repeat(4500)).map((x) => x.length), [2000, 2000, 500]);
  const text = Array.from({ length: 60 }, (_, i) => `line ${i} ${'z'.repeat(80)}`).join('\n');
  const chunks = f.splitMessage(text);
  assert.ok(chunks.length >= 2 && chunks.every((x) => x.length <= 2000));
  assert.equal(chunks.join('\n'), text);
});
