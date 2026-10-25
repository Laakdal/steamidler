// Task 1: statusChannelId in discord.json, and the discord-status.json store
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const c = await import(dist('discord/config.js'));
const st = await import(dist('discord/statusStore.js'));

const FILE = path.join(home, '.steam-idler', 'discord.json');
const STATUS = path.join(home, '.steam-idler', 'discord-status.json');
const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz1234';
const flat = { botToken: TOKEN, applicationId: '123456789012345678', ownerId: '223456789012345678', guildId: '323456789012345678', channelId: '423456789012345678' };
const botObj = { token: TOKEN, applicationId: flat.applicationId, ownerId: flat.ownerId, guildId: flat.guildId, channelId: flat.channelId };
const SC = '523456789012345678';

const logs = [];
console.error = (...a) => logs.push(a.join(' '));

test('statusChannelId round-trips through save/load', () => {
  assert.equal(c.saveDiscordConfig({ bot: { ...botObj, statusChannelId: SC }, webhookUrl: null }), true);
  assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8')).statusChannelId, SC);
  assert.equal(c.loadDiscordConfig().bot.statusChannelId, SC);
});

test('missing statusChannelId loads as null and is not written', () => {
  fs.writeFileSync(FILE, JSON.stringify(flat));
  assert.equal(c.loadDiscordConfig().bot.statusChannelId, null);
  assert.equal(c.saveDiscordConfig({ bot: { ...botObj, statusChannelId: null }, webhookUrl: null }), true);
  assert.equal('statusChannelId' in JSON.parse(fs.readFileSync(FILE, 'utf8')), false);
});

test('malformed statusChannelId invalidates the file', () => {
  for (const bad of ['../1', 12345678901234567, '', 'abc', null]) {
    fs.writeFileSync(FILE, JSON.stringify({ ...flat, statusChannelId: bad }));
    assert.equal(c.loadDiscordConfig(), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('status file round-trips', () => {
  const ref = { channelId: SC, messageId: '623456789012345678' };
  assert.equal(st.saveStatusMessage(ref), true);
  assert.equal(st.STATUS_PATH, STATUS);
  assert.deepEqual(st.loadStatusMessage(), ref);
});

test('tampered status file is ignored', () => {
  const cases = [
    JSON.stringify({ channelId: '../x', messageId: '1' }),
    JSON.stringify({ channelId: 523456789012345678, messageId: 623456789012345678 }),
    JSON.stringify({ channelId: SC }),
    '[]',
    'not json',
  ];
  for (const raw of cases) {
    fs.writeFileSync(STATUS, raw);
    assert.equal(st.loadStatusMessage(), null, `accepted ${raw}`);
  }
  fs.rmSync(STATUS);
  logs.length = 0;
  assert.equal(st.loadStatusMessage(), null);
  assert.equal(logs.length, 0, 'missing file must not log');
});

test('save never throws when the dir is unwritable', () => {
  const dir = path.join(home, '.steam-idler');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'blocker');
  try {
    assert.equal(st.saveStatusMessage({ channelId: SC, messageId: '623456789012345678' }), false);
    assert.ok(logs.some((l) => l.includes('discord-status.json')));
  } finally {
    fs.rmSync(dir);
    fs.mkdirSync(dir);
  }
});
