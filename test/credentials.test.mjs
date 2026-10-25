// Offline tests for the saved Steam login (src/storage/credentials.ts) and the atomic writer under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const dir = path.join(home, '.steam-idler');
const file = path.join(dir, 'credentials.json');

const { saveCredentials, loadCredentials, clearCredentials, hasStoredCredentials } = await import(
  dist('storage/credentials.js')
);
const { writeFileAtomic } = await import(dist('storage/atomicWrite.js'));

// Builds a token shaped like a Steam refresh token at run time, so no token-looking literal sits in the repo
function steamToken(payload = { iss: 'steam', aud: ['client', 'web'], sub: '76561190000000000' }) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [part({ alg: 'EdDSA', typ: 'JWT' }), part(payload), 'c2ln'].join('.');
}

// Silences console.error for one call and returns what it printed
function quiet(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { value: fn(), lines };
  } finally {
    console.error = original;
  }
}

test('a saved login loads back unchanged', () => {
  const creds = { accountName: 'alice', refreshToken: steamToken() };
  assert.equal(saveCredentials(creds), true);
  assert.deepEqual(loadCredentials(), creds);
  assert.equal(hasStoredCredentials(), true);
});

test('no file means no saved login', () => {
  clearCredentials();
  assert.equal(loadCredentials(), null);
  assert.equal(hasStoredCredentials(), false);
});

test('clearing a missing file does not throw', () => {
  clearCredentials();
  const { lines } = quiet(() => clearCredentials());
  assert.deepEqual(lines, []);
});

for (const [label, contents] of [
  ['malformed JSON', '{not json'],
  ['a missing refresh token', JSON.stringify({ accountName: 'alice' })],
  ['an empty account name', JSON.stringify({ accountName: '', refreshToken: steamToken() })],
  ['a token that is not a JWT', JSON.stringify({ accountName: 'alice', refreshToken: 'abc' })],
  ['a token for another issuer', JSON.stringify({ accountName: 'alice', refreshToken: steamToken({ iss: 'x', aud: ['client'], sub: '1' }) })],
  ['a token without the client audience', JSON.stringify({ accountName: 'alice', refreshToken: steamToken({ iss: 'steam', aud: ['web'], sub: '1' }) })],
  ['a number for the token', JSON.stringify({ accountName: 'alice', refreshToken: 5 })],
]) {
  test(`${label} is treated as no saved login, and the file is removed`, () => {
    fs.writeFileSync(file, contents);
    const { value, lines } = quiet(() => loadCredentials());
    assert.equal(value, null);
    assert.equal(fs.existsSync(file), false);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes('eyJ'), 'no token text in the log');
  });
}

test('a save that cannot write returns false and logs the path, not the token', () => {
  const token = steamToken();
  fs.mkdirSync(file, { recursive: true }); // a directory where the file should go makes the rename fail
  try {
    const { value, lines } = quiet(() => saveCredentials({ accountName: 'alice', refreshToken: token }));
    assert.equal(value, false);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('credentials.json'));
    assert.ok(!lines[0].includes(token));
  } finally {
    fs.rmSync(file, { recursive: true, force: true });
  }
});

test('the atomic writer leaves only the target file behind', () => {
  const target = path.join(dir, 'atomic.json');
  writeFileAtomic(target, '{"a":1}', 0o600);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
});

test('the atomic writer cleans up its temp file when the rename fails', () => {
  const target = path.join(dir, 'blocked');
  fs.mkdirSync(path.join(target, 'inner'), { recursive: true });
  assert.throws(() => writeFileAtomic(target, 'x'));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  fs.rmSync(target, { recursive: true, force: true });
});
