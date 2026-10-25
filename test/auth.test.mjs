// Offline tests for logging in with the saved token (src/steam/auth.ts): which failures clear it and which keep it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const file = path.join(home, '.steam-idler', 'credentials.json');

const { loginWithStoredCredentials, loginWithQR, hasStoredLogin } = await import(dist('steam/auth.js'));
const { LoginSession } = await import('steam-session');
const { saveCredentials } = await import(dist('storage/credentials.js'));

// Builds a token shaped like a Steam refresh token at run time
function steamToken() {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [part({ alg: 'EdDSA' }), part({ iss: 'steam', aud: ['client'], sub: '76561190000000000' }), 'c2ln'].join('.');
}

// A SteamClient stand-in whose logon fails with the given error, or succeeds when none is given
function fakeClient(error) {
  const calls = [];
  return {
    calls,
    async loginWithRefreshToken(token, account) {
      calls.push({ token, account });
      if (error) throw error;
    },
  };
}

// Builds a steam-user style error carrying an EResult
function eresultError(eresult, message = `EResult ${eresult}`) {
  return Object.assign(new Error(message), { eresult });
}

test('no saved login gives a failure without calling Steam', async () => {
  const client = fakeClient();
  const result = await loginWithStoredCredentials(client);
  assert.equal(result.success, false);
  assert.equal(client.calls.length, 0);
  assert.equal(hasStoredLogin(), false);
});

test('a saved login logs on with its token and account', async () => {
  const token = steamToken();
  saveCredentials({ accountName: 'alice', refreshToken: token });
  const client = fakeClient();
  const result = await loginWithStoredCredentials(client);
  assert.deepEqual(result, { success: true, accountName: 'alice' });
  assert.deepEqual(client.calls, [{ token, account: 'alice' }]);
});

for (const eresult of [5, 15, 26, 27, 126]) {
  test(`EResult ${eresult} means the token is dead: it is cleared`, async () => {
    saveCredentials({ accountName: 'alice', refreshToken: steamToken() });
    const result = await loginWithStoredCredentials(fakeClient(eresultError(eresult)));
    assert.equal(result.success, false);
    assert.equal(result.eresult, eresult);
    assert.equal(fs.existsSync(file), false);
  });
}

for (const [label, error] of [
  ['a rate limit (EResult 84)', eresultError(84, 'RateLimitExceeded')],
  ['a network error with no EResult', new Error('connect ETIMEDOUT')],
]) {
  test(`${label} keeps the token for a later retry`, async () => {
    saveCredentials({ accountName: 'alice', refreshToken: steamToken() });
    const result = await loginWithStoredCredentials(fakeClient(error));
    assert.equal(result.success, false);
    assert.equal(result.eresult, error.eresult);
    assert.ok(result.error.includes(error.message));
    assert.equal(fs.existsSync(file), true);
  });
}

test('a throw while showing the QR code ends the login with a failure instead of escaping', async () => {
  LoginSession.qrStart = async () => ({
    get qrChallengeUrl() {
      throw new Error('terminal broke');
    },
  });
  try {
    const outcome = await Promise.race([
      loginWithQR(fakeClient()),
      new Promise((r) => setTimeout(() => r('never settled'), 2000)),
    ]);
    assert.deepEqual(outcome, { success: false, error: 'terminal broke' });
  } finally {
    LoginSession.qrStart = null;
  }
});
