// Task 10: the terminal game picker, driven by keypresses on a fake TTY stdin
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { dist, tempHome } from './helpers.mjs';
import { installFakeStdin, restoreStdin } from './fake/stdin.mjs';

// The picker no longer writes any config file; the empty home proves it
const home = tempHome();
const configDir = path.join(home, '.steam-idler');

const { selectGames } = await import(dist('ui/gameSelector.js'));

const lib = (appid, name, source = 'owned') => ({ appid, name, playtime_forever: 0, source });
const sel = (appid, name) => ({ appid, name });

const ALPHA = lib(1, 'Alpha');
const BETA = lib(2, 'Beta');
const CHARLIE = lib(3, 'Charlie');
const DELTA = lib(4, 'Delta');
const LIBRARY = [CHARLIE, ALPHA, DELTA, BETA];

let stdin;
let frames;

beforeEach(() => {
  stdin = installFakeStdin();
  // Each console.clear starts a new screen; console.log lines go to the current one
  frames = [[]];
  mock.method(console, 'clear', () => frames.push([]));
  mock.method(console, 'log', (...args) => {
    for (const line of stripVTControlCharacters(args.join(' ')).split('\n')) frames.at(-1).push(line);
  });
});

afterEach(() => {
  // Every picker resolved: no keypress listener and no raw mode left behind
  assert.equal(stdin.listenerCount('keypress'), 0);
  if (stdin.rawModes.length > 0) assert.equal(stdin.rawModes.at(-1), false);
  mock.restoreAll();
  restoreStdin();
});

// The last screen drawn
const screen = () => frames.at(-1);

// The game rows of the last screen: tick state, name and the bracketed suffix
function rows() {
  return screen()
    .map((line) => line.match(/^\s*\[(✓| )\] .{2}(.+) \((.+)\)$/))
    .filter(Boolean)
    .map((m) => ({ ticked: m[1] === '✓', name: m[2], suffix: m[3] }));
}

// Lets a resolved picker's promise callbacks run
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Opens the picker and tracks whether it has resolved
function open(games, selected, isEditMode = false) {
  const state = { done: false, result: undefined };
  state.promise = selectGames(games, selected, isEditMode).then((r) => {
    state.done = true;
    state.result = r;
    return r;
  });
  return state;
}

test('opens with the saved selection ticked and first', async () => {
  const picker = open(LIBRARY, [sel(4, 'Delta'), sel(2, 'Beta')]);
  assert.deepEqual(rows(), [
    { ticked: true, name: 'Beta', suffix: 'never played' },
    { ticked: true, name: 'Delta', suffix: 'never played' },
    { ticked: false, name: 'Alpha', suffix: 'never played' },
    { ticked: false, name: 'Charlie', suffix: 'never played' },
  ]);
  const lines = screen().map((l) => l.trim());
  assert.ok(lines.indexOf('SELECTED') < lines.indexOf('ALL GAMES'));
  assert.ok(lines.indexOf('SELECTED') >= 0);
  assert.ok(screen().some((l) => l.includes('Selected: 2/32')));
  assert.ok(!screen().some((l) => /favorite/i.test(l)));

  stdin.press('return');
  assert.deepEqual((await picker.promise).selectedGames, [sel(2, 'Beta'), sel(4, 'Delta')]);
});

test('ticking does not reorder', async () => {
  const picker = open(LIBRARY, [sel(2, 'Beta')]);
  const order = rows().map((r) => r.name);
  assert.deepEqual(order, ['Beta', 'Alpha', 'Charlie', 'Delta']);

  stdin.press('down');
  stdin.press('down');
  stdin.press('space'); // tick Charlie
  stdin.press('home');
  stdin.press('space'); // untick Beta
  assert.deepEqual(rows().map((r) => r.name), order);
  assert.deepEqual(rows().map((r) => r.ticked), [false, false, true, false]);
  // The Selected header stays on the games it opened with
  assert.equal(screen().map((l) => l.trim()).indexOf('SELECTED') >= 0, true);

  stdin.press('return');
  assert.deepEqual((await picker.promise).selectedGames, [sel(3, 'Charlie')]);
});

test('F, S and X do nothing', async () => {
  const picker = open(LIBRARY, [sel(1, 'Alpha')]);
  const before = rows();
  for (const k of ['f', 'F', 's', 'S', 'x', 'X']) stdin.press(k.toLowerCase(), k, { shift: k !== k.toLowerCase() });
  await settle();
  assert.equal(picker.done, false);
  assert.deepEqual(rows(), before);
  // No hint line, and no help text naming the removed keys
  assert.ok(!screen().some((l) => /favorite|exempt/i.test(l) || /\b[FSX]: /.test(l)));
  assert.deepEqual(fs.readdirSync(configDir), []);

  stdin.press('return');
  assert.deepEqual((await picker.promise).selectedGames, [sel(1, 'Alpha')]);
  assert.deepEqual(fs.readdirSync(configDir), []);
});

test('Enter with nothing ticked shows the hint', async () => {
  const picker = open(LIBRARY, []);
  assert.ok(rows().every((r) => !r.ticked));
  assert.ok(!screen().map((l) => l.trim()).includes('SELECTED'));
  stdin.press('return');
  await settle();
  assert.equal(picker.done, false);
  assert.ok(screen().some((l) => l.trim() === 'Nothing selected — Space toggles a game'));
  assert.ok(screen().some((l) => l.trim() === 'Enter: Start'));

  stdin.press('c', '\x03', { ctrl: true });
  assert.deepEqual(await picker.promise, { selectedGames: [], aborted: true });
});

test('Esc in edit mode returns the selection it opened with', async () => {
  const opened = [sel(4, 'Delta'), sel(99, 'Gone'), sel(2, 'Beta')];
  const picker = open(LIBRARY, opened, true);
  assert.ok(screen().some((l) => l.trim() === 'Enter: Apply | Esc: Back (keep selection)'));
  stdin.press('end');
  stdin.press('space'); // tick Charlie
  stdin.press('home');
  stdin.press('space'); // untick Beta
  stdin.press('escape');
  assert.deepEqual((await picker.promise).selectedGames, opened);

  // Outside edit mode Esc does nothing
  const start = open(LIBRARY, [sel(1, 'Alpha')]);
  stdin.press('escape');
  await settle();
  assert.equal(start.done, false);
  stdin.press('return');
  assert.deepEqual((await start.promise).selectedGames, [sel(1, 'Alpha')]);
});

test('a missing game can be unticked and is not returned', async () => {
  for (const isEditMode of [false, true]) {
    const picker = open(LIBRARY, [sel(99, 'Gone Game'), sel(1, 'Alpha')], isEditMode);
    // Listed ticked in the Selected group, after the library games, marked
    assert.deepEqual(rows().slice(0, 3), [
      { ticked: true, name: 'Alpha', suffix: 'never played' },
      { ticked: true, name: 'Gone Game', suffix: 'not in library' },
      { ticked: false, name: 'Beta', suffix: 'never played' },
    ]);
    assert.ok(screen().some((l) => l.includes('Selected: 2/32')));
    stdin.press('down');
    stdin.press('space');
    assert.equal(rows()[1].ticked, false);
    stdin.press('return');
    assert.deepEqual((await picker.promise).selectedGames, [sel(1, 'Alpha')]);
  }
});

test('a ticked missing game is returned with its saved name', async () => {
  const picker = open(LIBRARY, [sel(1, 'Alpha'), sel(99, 'Gone Game')]);
  // A source filter hides it, but it stays selected
  stdin.press('t', 't');
  assert.ok(!rows().some((r) => r.name === 'Gone Game'));
  stdin.press('return');
  assert.deepEqual((await picker.promise).selectedGames, [sel(1, 'Alpha'), sel(99, 'Gone Game')]);
});

test('a selection of only missing games is refused', async () => {
  for (const isEditMode of [false, true]) {
    const picker = open(LIBRARY, [sel(99, 'Gone')], isEditMode);
    stdin.press('return');
    await settle();
    assert.equal(picker.done, false);
    assert.ok(screen().some((l) => l.trim() === 'Pick at least one game from your library'));
    // Ticking a library game makes it acceptable
    stdin.press('down');
    stdin.press('space');
    stdin.press('return');
    // Returned in screen order: the Selected group first
    assert.deepEqual((await picker.promise).selectedGames, [sel(99, 'Gone'), sel(1, 'Alpha')]);
  }
});

test('the 33rd tick is refused, counting missing games', async () => {
  const name = (i) => `Game ${String(i).padStart(2, '0')}`;
  const games = Array.from({ length: 33 }, (_, i) => lib(i + 1, name(i + 1)));
  // 30 library games and 2 missing ones: 32 ticked, Games 31-33 unticked
  const selected = [...games.slice(0, 30).map((g) => sel(g.appid, g.name)), sel(901, 'Lost A'), sel(902, 'Lost B')];
  const picker = open(games, selected);
  assert.ok(screen().some((l) => l.includes('Selected: 32/32')));

  stdin.press('end'); // Game 33
  stdin.press('space');
  assert.ok(screen().some((l) => l.trim() === 'Steam allows at most 32 games at once'));
  assert.ok(screen().some((l) => l.includes('Selected: 32/32')));

  // Unticking a missing game frees a slot
  stdin.press('up');
  stdin.press('up');
  stdin.press('up'); // Lost B
  stdin.press('space');
  stdin.press('end');
  stdin.press('space');
  assert.ok(screen().some((l) => l.includes('Selected: 32/32')));

  stdin.press('return');
  const result = (await picker.promise).selectedGames;
  assert.equal(result.length, 32);
  assert.ok(result.some((g) => g.appid === 33));
  assert.ok(result.some((g) => g.appid === 901));
  assert.ok(!result.some((g) => g.appid === 902));
});
