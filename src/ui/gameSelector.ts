import * as readline from 'node:readline';
import chalk from 'chalk';
import type { SteamGame, GameSelection, GameSource, GameSelectorResult } from '../types/index.js';
import { MAX_IDLE_GAMES } from '../constants.js';

// One line of the picker
interface Row {
  appid: number;
  name: string;
  playtime: number;
  ticked: boolean;
  // Ticked when the picker opened. Decides the row's place (the SELECTED group
  // on top) and never changes while the picker is open, so ticking never moves a row.
  pinned: boolean;
  // null for a saved game the library does not have right now. It is listed
  // so it can be unticked; leaving it out would drop it on an edit-mode apply.
  source: GameSource | null;
}

type Filter = 'all' | GameSource;

// T steps through these, in this order
const FILTERS: Filter[] = ['all', 'owned', 'free', 'shared'];

const FILTER_NAMES: Record<Filter, string> = {
  all: 'all',
  owned: 'owned',
  free: 'free-to-play',
  shared: 'family shared',
};

// Two-character marker in front of a name
const BADGES: Record<GameSource, string> = {
  owned: '  ',
  free: chalk.green('$ '),
  shared: chalk.magenta('↪ '),
};

// What a key did: nothing visible, a new screen, or the end of the picker
type Outcome = 'ignore' | 'redraw' | { result: GameSelectorResult };

// Playtime as the picker shows it
function playtimeLabel(minutes: number): string {
  if (minutes === 0) return 'never played';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60).toLocaleString()}h`;
}

// The rows in their fixed order: games already chosen (from the library, then
// the missing ones), then the rest of the library, each part A to Z. The
// chosen list is cut to the first MAX_IDLE_GAMES distinct games, so a
// hand-edited file can never hand Enter a list Steam would refuse.
function buildRows(library: SteamGame[], chosen: GameSelection[]): Row[] {
  const chosenIds = new Set<number>();
  for (const g of chosen) {
    if (chosenIds.size === MAX_IDLE_GAMES) break;
    chosenIds.add(g.appid);
  }
  const inLibrary = new Set(library.map((g) => g.appid));
  const aToZ = (a: Row, b: Row): number => a.name.localeCompare(b.name);

  const libraryRows = library.map((g): Row => {
    const isChosen = chosenIds.has(g.appid);
    return { appid: g.appid, name: g.name, playtime: g.playtime_forever, ticked: isChosen, pinned: isChosen, source: g.source };
  });
  const missingRows = new Map<number, Row>();
  for (const g of chosen) {
    if (chosenIds.has(g.appid) && !inLibrary.has(g.appid) && !missingRows.has(g.appid)) {
      missingRows.set(g.appid, { appid: g.appid, name: g.name, playtime: 0, ticked: true, pinned: true, source: null });
    }
  }

  return [
    ...libraryRows.filter((r) => r.pinned).sort(aToZ),
    ...[...missingRows.values()].sort(aToZ),
    ...libraryRows.filter((r) => !r.pinned).sort(aToZ),
  ];
}

// Everything the picker remembers between keys
class Picker {
  cursor = 0; // index into shown()
  top = 0; // index of the first shown row on screen
  filter: Filter = 'all';
  query = '';
  typing = false; // the search line has the keyboard
  hint = ''; // one-off message, gone after the next key
  // Up to ~20 lines go to the title, counters, headers and key help; the list
  // gets the rest, so a plain 24-line terminal still shows the counters.
  readonly pageSize = Math.min(30, Math.max(5, (process.stdout.rows || 24) - 20));

  constructor(readonly rows: Row[], readonly isEditMode: boolean, readonly openedWith: GameSelection[]) {}

  // The rows passing the filter and the search. A missing game has no
  // source, so only the "all" filter shows it.
  shown(): Row[] {
    const needle = this.query.toLowerCase();
    return this.rows.filter(
      (r) => (this.filter === 'all' || r.source === this.filter) && r.name.toLowerCase().includes(needle)
    );
  }

  tickedCount(): number {
    return this.rows.filter((r) => r.ticked).length;
  }

  // Moves the cursor, clamped to the list, and scrolls just enough to keep it on screen
  moveTo(index: number): void {
    this.cursor = Math.max(0, Math.min(index, this.shown().length - 1));
    if (this.cursor < this.top) this.top = this.cursor;
    if (this.cursor >= this.top + this.pageSize) this.top = this.cursor - this.pageSize + 1;
  }

  // A new search or filter starts at the top of the list
  resetPosition(): void {
    this.cursor = 0;
    this.top = 0;
  }

  // Next filter, keeping the cursor on the same game when it stays visible
  cycleFilter(): void {
    const focused = this.shown()[this.cursor]?.appid;
    this.filter = FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length] ?? 'all';
    const list = this.shown();
    this.top = Math.min(this.top, Math.max(0, list.length - this.pageSize));
    this.moveTo(Math.max(0, list.findIndex((r) => r.appid === focused)));
  }

  // Space: flips the row under the cursor, refusing a tick past Steam's cap
  toggle(): void {
    const row = this.shown()[this.cursor];
    if (!row) return;
    if (!row.ticked && this.tickedCount() >= MAX_IDLE_GAMES) {
      this.hint = `Steam allows at most ${MAX_IDLE_GAMES} games at once`;
      return;
    }
    row.ticked = !row.ticked;
  }

  // Enter: the ticked games, or null with a hint when they cannot start
  confirm(): GameSelection[] | null {
    const ticked = this.rows.filter((r) => r.ticked);
    if (ticked.length === 0) {
      this.hint = 'Nothing selected — Space toggles a game';
      return null;
    }
    // Missing games are never sent to Steam: alone they would idle nothing
    if (ticked.every((r) => r.source === null)) {
      this.hint = 'Pick at least one game from your library';
      return null;
    }
    return ticked.map((r) => ({ appid: r.appid, name: r.name }));
  }

  // Keys while the search line is open
  searchKey(str: string | undefined, key: readline.Key): Outcome {
    if (key.name === 'return') {
      this.typing = false;
    } else if (key.name === 'escape') {
      this.typing = false;
      this.query = '';
      this.resetPosition();
    } else if (key.name === 'backspace') {
      if (this.query) {
        this.query = this.query.slice(0, -1);
        this.resetPosition();
      }
    } else if (str?.length === 1 && !key.ctrl && !key.meta && str.charCodeAt(0) >= 32) {
      this.query += str;
      this.resetPosition();
    } else {
      return 'ignore';
    }
    return 'redraw';
  }

  // Handles one keypress
  react(str: string | undefined, key: readline.Key): Outcome {
    this.hint = '';
    // Ctrl+C goes back to the caller, which logs off cleanly rather than
    // exiting in the middle of a session
    if (key.ctrl && key.name === 'c') return { result: { selectedGames: [], aborted: true } };

    const last = this.shown().length - 1;
    const jumps: Record<string, number> = {
      up: this.cursor - 1,
      down: this.cursor + 1,
      pageup: this.cursor - this.pageSize,
      pagedown: this.cursor + this.pageSize,
      home: 0,
      end: last,
    };
    const jump = key.name !== undefined && Object.hasOwn(jumps, key.name) ? jumps[key.name] : undefined;
    if (jump !== undefined) {
      this.moveTo(jump);
      return 'redraw';
    }

    if (this.typing) return this.searchKey(str, key);

    if (str === '/') {
      this.typing = true;
      return 'redraw';
    }
    if (str === 't' || str === 'T') {
      this.cycleFilter();
      return 'redraw';
    }
    if (key.name === 'space') {
      this.toggle();
      return 'redraw';
    }
    if (key.name === 'escape') {
      if (this.query) {
        this.query = '';
        this.resetPosition();
        return 'redraw';
      }
      // In edit mode Esc keeps exactly what is idling now
      return this.isEditMode ? { result: { selectedGames: this.openedWith } } : 'ignore';
    }
    if (key.name === 'return') {
      const games = this.confirm();
      return games ? { result: { selectedGames: games } } : 'redraw';
    }
    return 'ignore';
  }

  // Draws the whole screen
  draw(): void {
    const list = this.shown();
    const pinnedShown = list.filter((r) => r.pinned).length;
    const counts = { owned: 0, free: 0, shared: 0 };
    for (const r of this.rows) if (r.source) counts[r.source]++;

    console.clear();
    console.log(chalk.cyan.bold('\n  Select Games to Idle\n'));
    // Missing games count toward the cap: they hold a slot in the selection
    console.log(
      chalk.gray(
        `  Selected: ${this.tickedCount()}/${MAX_IDLE_GAMES} | ` +
          `Owned: ${counts.owned} ${chalk.green('$')} ${counts.free} ${chalk.magenta('↪')} ${counts.shared}`
      )
    );
    console.log(chalk.gray(`  Filter: ${chalk.cyan(FILTER_NAMES[this.filter])} (T to cycle)`));
    if (this.typing) {
      console.log(chalk.cyan(`  Search: ${this.query}_`));
    } else if (this.query) {
      console.log(chalk.gray(`  Search: ${chalk.cyan(this.query)} (/ to edit, Esc to clear)`));
    }
    if (this.hint) console.log(chalk.yellow(`  ${this.hint}`));
    console.log('');

    const end = Math.min(this.top + this.pageSize, list.length);
    if (pinnedShown > 0 && this.top < pinnedShown) console.log(chalk.green.bold('  SELECTED\n'));
    for (let i = this.top; i < end; i++) {
      const row = list[i];
      if (!row) continue;
      if (i === pinnedShown && pinnedShown > 0) {
        console.log('');
        console.log(chalk.gray.bold('  ALL GAMES\n'));
      }
      const box = row.ticked ? chalk.green('[✓]') : chalk.gray('[ ]');
      const name = row.name.length > 40 ? `${row.name.slice(0, 37)}...` : row.name;
      const after = row.source ? chalk.gray(`(${playtimeLabel(row.playtime)})`) : chalk.yellow('(not in library)');
      const line = `  ${box} ${row.source ? BADGES[row.source] : '  '}${name} ${after}`;
      console.log(i === this.cursor ? chalk.bgGray.white(line) : line);
    }
    if (list.length === 0) console.log(chalk.gray('  No games match the current filter.'));
    if (list.length > this.pageSize) console.log(chalk.gray(`\n  ${this.top + 1}-${end} of ${list.length}`));

    console.log('');
    if (this.typing) {
      console.log(chalk.gray('  Type to filter | Backspace: delete | Esc: cancel | Enter: confirm'));
    } else {
      console.log(chalk.gray('  ↑/↓ PgUp/PgDn Home/End: Navigate | Space: Toggle | T: Filter | /: Search'));
      console.log(chalk.gray(this.isEditMode ? '  Enter: Apply | Esc: Back (keep selection)' : '  Enter: Start'));
    }
    console.log('');
  }
}

// The keyboard game picker. `selected` is what opens ticked and on top: the
// saved selection at start, or what is idling in edit mode, saved games
// missing from the library included.
export function selectGames(
  games: SteamGame[],
  selected: GameSelection[],
  isEditMode: boolean
): Promise<GameSelectorResult> {
  const picker = new Picker(buildRows(games, selected), isEditMode, selected);
  const stdin = process.stdin;

  return new Promise((resolve) => {
    const onKey = (str: string | undefined, key: readline.Key): void => {
      const outcome = picker.react(str, key);
      if (outcome === 'redraw') {
        picker.draw();
      } else if (outcome !== 'ignore') {
        stdin.removeListener('keypress', onKey);
        if (stdin.isTTY) stdin.setRawMode(false);
        resolve(outcome.result);
      }
    };

    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    picker.draw();
  });
}
