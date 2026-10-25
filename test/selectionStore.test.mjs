// Task 8: the validated selection file, with the favorites file as a read-only fallback
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dist, tempHome } from './helpers.mjs';

const home = tempHome();
const sel = await import(dist('storage/selection.js'));
const DIR = path.join(home, '.steam-idler');
const ACC = 'alice';
const FILE = path.join(DIR, `selection-${ACC}.json`);
const FAV = path.join(DIR, `favorites-${ACC}.json`);

function clean() {
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { force: true });
}
function load() {
  const lines = [];
  const result = sel.loadSelection(ACC, (l) => lines.push(l));
  return { result, lines };
}
function writeSel(games, extra = {}) {
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), games, ...extra }));
}

test('round trip keeps order and names', () => {
  clean();
  const games = [{ appid: 730, name: 'Counter-Strike 2' }, { appid: 10, name: 'Half-Life' }, { appid: 440, name: 'TF2' }];
  assert.equal(sel.saveSelection(ACC, games), true);
  assert.equal(sel.selectionPath(ACC), FILE);
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(raw.version, sel.SELECTION_VERSION);
  assert.equal(typeof raw.savedAt, 'string');
  const { result, lines } = load();
  assert.deepEqual(result, { games, source: 'saved' });
  assert.deepEqual(lines, []);
});

test('missing file falls back to favorites', () => {
  clean();
  fs.writeFileSync(FAV, JSON.stringify({ favorites: [730, 10], exemptAppId: 99 }));
  const { result } = load();
  assert.deepEqual(result, { games: [{ appid: 730, name: 'App 730' }, { appid: 10, name: 'App 10' }], source: 'favorites' });
  assert.equal(fs.existsSync(FAV), true);
});

test('no files -> null', () => {
  clean();
  assert.equal(load().result, null);
});

test('unparsable JSON is renamed to .invalid and falls back', () => {
  clean();
  fs.writeFileSync(`${FILE}.invalid`, 'older');
  fs.writeFileSync(FILE, '{ not json');
  fs.writeFileSync(FAV, JSON.stringify({ favorites: [5] }));
  const { result, lines } = load();
  assert.deepEqual(result, { games: [{ appid: 5, name: 'App 5' }], source: 'favorites' });
  assert.equal(fs.existsSync(FILE), false);
  assert.equal(fs.readFileSync(`${FILE}.invalid`, 'utf8'), '{ not json');
  assert.equal(lines.length, 1);
  // Only the file name, never the full path, on any OS
  assert.equal(lines[0], 'selection-alice.json: unreadable or not JSON; renamed to selection-alice.json.invalid');
});

test('unparsable JSON with no favorites gives null', () => {
  clean();
  fs.writeFileSync(FILE, '[1,2]');
  assert.equal(load().result, null);
  assert.equal(fs.existsSync(`${FILE}.invalid`), true);
});

test('unknown version is renamed to .invalid', () => {
  clean();
  fs.writeFileSync(FILE, JSON.stringify({ version: 2, games: [{ appid: 1, name: 'x' }] }));
  const { result, lines } = load();
  assert.equal(result, null);
  assert.equal(fs.existsSync(FILE), false);
  assert.equal(fs.existsSync(`${FILE}.invalid`), true);
  assert.equal(lines.length, 1);
});

test('bad entries dropped with a line each, rest kept', () => {
  clean();
  writeSel([
    { appid: 0, name: 'zero' },
    { appid: -1, name: 'neg' },
    { appid: 1.5, name: 'frac' },
    { appid: '730', name: 'str' },
    { appid: 10, name: 'Ten' },
    { appid: 10, name: 'Ten again' },
    { appid: 20, name: 'Twenty' },
  ]);
  const { result, lines } = load();
  assert.deepEqual(result, { games: [{ appid: 10, name: 'Ten' }, { appid: 20, name: 'Twenty' }], source: 'saved' });
  assert.equal(lines.length, 5);
});

test('more than 32 keeps the first 32', () => {
  clean();
  writeSel(Array.from({ length: 40 }, (_, i) => ({ appid: i + 1, name: `G${i + 1}` })));
  const { result } = load();
  assert.equal(result.games.length, 32);
  assert.equal(result.games[31].appid, 32);
});

test('empty games list loads as saved with no games', () => {
  clean();
  fs.writeFileSync(FAV, JSON.stringify({ favorites: [730] }));
  assert.equal(sel.saveSelection(ACC, []), true);
  assert.deepEqual(load().result, { games: [], source: 'saved' });
});

test('save into a read-only folder returns false and logs the path', () => {
  // Portable stand-in for a read-only dir: the config dir path is a file, so the write fails
  clean();
  fs.rmdirSync(DIR);
  fs.writeFileSync(DIR, 'a file, not a folder');
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    assert.equal(sel.saveSelection(ACC, [{ appid: 1, name: 'x' }]), false);
  } finally {
    console.error = orig;
    fs.rmSync(DIR, { force: true });
    fs.mkdirSync(DIR);
  }
  assert.equal(errs.length, 1);
  assert.ok(errs[0].includes(`selection-${ACC}.json`));
});
