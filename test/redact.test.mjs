// redactSecrets and its use in the notifier's error logging (fetch mocked, no network).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const CFG = path.join(home, '.steam-idler', 'discord.json');
const { redactSecrets } = await import(dist('discord/format.js'));
const n = await import(dist('discord/notifier.js'));

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz1234';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_-123';
const BOT = { botToken: TOKEN, applicationId: '123456789012345678', ownerId: '223456789012345678', guildId: '323456789012345678', channelId: '423456789012345678' };
const keepalive = setInterval(() => {}, 1000);
after(() => clearInterval(keepalive));

let logs;
console.error = (...a) => logs.push(a.join(' '));
console.log = (...a) => logs.push(a.join(' '));
beforeEach(() => { logs = []; });
const clean = () => {
  for (const l of logs) {
    assert.ok(!l.includes(TOKEN), `token in log: ${l}`);
    assert.ok(!l.includes('abcDEF_-123'), `webhook token in log: ${l}`);
  }
};

test('redactSecrets cuts known secrets and every URL, and leaves plain text alone', () => {
  assert.equal(redactSecrets('fetch failed'), 'fetch failed');
  assert.equal(redactSecrets(`Failed to parse URL from ${HOOK}`), 'Failed to parse URL from <url>');
  assert.equal(redactSecrets(`bad ${TOKEN} here`, [TOKEN]), 'bad <token> here');
  assert.equal(redactSecrets('a http://x/y?z=1 b https://discord.com/api/v10/interactions/1/SECRET/callback c'), 'a <url> b <url> c');
  assert.equal(redactSecrets('nothing', ['']), 'nothing', 'an empty secret is ignored');
  assert.equal(redactSecrets(`${TOKEN}${TOKEN}`, [TOKEN]), '<token><token>');
});

test('notifier: a bot post that throws with the token and a URL logs neither', async () => {
  fs.writeFileSync(CFG, JSON.stringify({ ...BOT, webhookUrl: HOOK }));
  globalThis.fetch = async (url) => {
    if (String(url).includes('/channels/')) throw new TypeError(`Failed to parse URL from https://discord.com/api/v10/channels/x?${TOKEN}`);
    return new Response(null, { status: 204 });
  };
  const d = new n.DiscordNotifier({ botTimeoutMs: 50, webhookTimeoutMs: 50 });
  await d.send('hello');
  assert.ok(logs.some((l) => l.includes('bot post failed') && l.includes('<url>')), logs.join('\n'));
  clean();
});

test('notifier: a webhook post that throws quoting the webhook URL logs only <url>', async () => {
  fs.writeFileSync(CFG, JSON.stringify({ webhookUrl: HOOK }));
  globalThis.fetch = async () => { throw new TypeError(`Failed to parse URL from ${HOOK}`); };
  const d = new n.DiscordNotifier({ botTimeoutMs: 50, webhookTimeoutMs: 50 });
  await d.send('hello');
  assert.ok(logs.some((l) => l.includes('send failed') && l.includes('<url>')), logs.join('\n'));
  clean();
});
