// Offline tests for src/steam/client.ts: steam-user and steam-session are replaced by fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './helpers.mjs';

const { SteamClient } = await import(dist('steam/client.js'));

test('logon does not change the Steam status', () => {
  const client = new SteamClient();
  client.steamUser.emit('loggedOn');
  assert.equal(client.steamUser.personaCalls.length, 0);
});
