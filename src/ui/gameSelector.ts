import * as readline from 'node:readline';
import chalk from 'chalk';
import type { SteamGame, GameSelection, GameSource, GameSelectorResult } from '../types/index.js';
import { MAX_IDLE_GAMES } from '../constants.js';

interface SelectableGame {
  appid: number;
  name: string;
  playtime: number;
  selected: boolean;
  // Selected when the picker opened: listed first, under the Selected header.
  // Fixed while the picker is open, so ticking never moves a row.
  inSelectedGroup: boolean;
  // Saved but not in the library (null source): shown so it can be unticked,
  // otherwise an edit-mode apply would drop it from the saved selection.
  source: GameSource | null;
}

type SourceFilter = 'all' | 'owned' | 'free' | 'shared';

const FILTER_CYCLE: SourceFilter[] = ['all', 'owned', 'free', 'shared'];

const SOURCE_BADGE: Record<GameSource, string> = {
  owned: '  ',
  free: chalk.green('$ '),
  shared: chalk.magenta('↪ '),
};

const FILTER_LABEL: Record<SourceFilter, string> = {
  all: 'all',
  owned: 'owned',
  free: 'free-to-play',
  shared: 'family shared',
};

// Interactive game selection with keyboard navigation. `selected` is the saved
// selection at start, or what is idling in edit mode; its games open ticked
// and listed first, including saved games missing from the library.
export async function selectGames(
  games: SteamGame[],
  selected: GameSelection[],
  isEditMode: boolean
): Promise<GameSelectorResult> {
  // A hand-edited file could repeat a game or exceed the cap; keep the first
  // MAX_IDLE_GAMES unique ones so Enter never trips the gamesPlayed cap.
  const preselected = new Set<number>();
  for (const game of selected) {
    if (preselected.size >= MAX_IDLE_GAMES) break;
    preselected.add(game.appid);
  }

  const libraryIds = new Set(games.map((g) => g.appid));
  const byName = (a: SelectableGame, b: SelectableGame): number => a.name.localeCompare(b.name);

  const libraryRows: SelectableGame[] = games.map((game) => ({
    appid: game.appid,
    name: game.name,
    playtime: game.playtime_forever,
    selected: preselected.has(game.appid),
    inSelectedGroup: preselected.has(game.appid),
    source: game.source,
  }));
  const seenMissing = new Set<number>();
  const missingRows: SelectableGame[] = [];
  for (const game of selected) {
    if (!preselected.has(game.appid) || libraryIds.has(game.appid) || seenMissing.has(game.appid)) continue;
    seenMissing.add(game.appid);
    missingRows.push({ appid: game.appid, name: game.name, playtime: 0, selected: true, inSelectedGroup: true, source: null });
  }

  // Order fixed at open: the Selected group (library games, then the missing
  // ones), then the rest of the library, each alphabetically.
  const selectableGames: SelectableGame[] = [
    ...libraryRows.filter((g) => g.inSelectedGroup).sort(byName),
    ...missingRows.sort(byName),
    ...libraryRows.filter((g) => !g.inSelectedGroup).sort(byName),
  ];

  return new Promise((resolve) => {
    let cursorIndex = 0;
    let scrollOffset = 0;
    let sourceFilter: SourceFilter = 'all';
    let searchQuery = '';
    let isSearchMode = false;
    let hint = ''; // one-shot feedback line, cleared on the next key
    // Title, counters, section headers, scroll line, hint and key help take up
    // to ~20 rows; size the list so a default 24-row terminal keeps the
    // counters on screen.
    const pageSize = Math.min(30, Math.max(5, (process.stdout.rows || 24) - 20));

    const matchesQuery = (g: SelectableGame): boolean =>
      searchQuery.length === 0 ||
      g.name.toLowerCase().includes(searchQuery.toLowerCase());

    // A missing game has no source, so only the "all" filter shows it
    const matchesFilter = (g: SelectableGame): boolean =>
      (sourceFilter === 'all' || g.source === sourceFilter) && matchesQuery(g);

    // The rows on screen, in the fixed order
    const getVisibleGames = (): SelectableGame[] => selectableGames.filter(matchesFilter);

    const sourceCounts = (): Record<GameSource, number> => {
      const counts: Record<GameSource, number> = { owned: 0, free: 0, shared: 0 };
      for (const g of selectableGames) if (g.source) counts[g.source]++;
      return counts;
    };

    const render = () => {
      console.clear();

      const filteredGames = getVisibleGames();
      const groupCount = filteredGames.filter((g) => g.inSelectedGroup).length;

      console.log(chalk.cyan.bold('\n  Select Games to Idle\n'));

      // Count selections (missing games included: they hold a slot) + source breakdown
      const selectedCount = selectableGames.filter((g) => g.selected).length;
      const counts = sourceCounts();
      console.log(
        chalk.gray(
          `  Selected: ${selectedCount}/${MAX_IDLE_GAMES} | ` +
            `Owned: ${counts.owned} ${chalk.green('$')} ${counts.free} ${chalk.magenta('↪')} ${counts.shared}`
        )
      );
      console.log(chalk.gray(`  Filter: ${chalk.cyan(FILTER_LABEL[sourceFilter])} (T to cycle)`));
      if (isSearchMode) {
        console.log(chalk.cyan(`  Search: ${searchQuery}_`));
      } else if (searchQuery.length > 0) {
        console.log(chalk.gray(`  Search: ${chalk.cyan(searchQuery)} (/ to edit, Esc to clear)`));
      }
      if (hint) console.log(chalk.yellow(`  ${hint}`));
      console.log('');

      const visibleStart = scrollOffset;
      const visibleEnd = Math.min(scrollOffset + pageSize, filteredGames.length);
      const visibleGames = filteredGames.slice(visibleStart, visibleEnd);

      // Render the Selected header if the group has rows and some are on screen
      if (groupCount > 0 && scrollOffset < groupCount) {
        console.log(chalk.green.bold('  SELECTED\n'));
      }

      let displayIndex = visibleStart;
      for (const game of visibleGames) {
        if (displayIndex === groupCount && groupCount > 0) {
          console.log('');
          console.log(chalk.gray.bold('  ALL GAMES\n'));
        }

        const isCurrent = displayIndex === cursorIndex;
        const checkbox = game.selected ? chalk.green('[✓]') : chalk.gray('[ ]');
        const badge = game.source ? SOURCE_BADGE[game.source] : '  ';
        const detail = game.source ? chalk.gray(`(${formatPlaytime(game.playtime)})`) : chalk.yellow('(not in library)');
        const name =
          game.name.length > 40 ? game.name.substring(0, 37) + '...' : game.name;

        const line = `  ${checkbox} ${badge}${name} ${detail}`;

        if (isCurrent) {
          console.log(chalk.bgGray.white(line));
        } else {
          console.log(line);
        }

        displayIndex++;
      }

      if (filteredGames.length === 0) {
        console.log(chalk.gray('  No games match the current filter.'));
      }

      // Scroll indicator
      if (filteredGames.length > pageSize) {
        const scrollInfo = `  ${visibleStart + 1}-${visibleEnd} of ${filteredGames.length}`;
        console.log(chalk.gray(`\n${scrollInfo}`));
      }

      // Instructions
      console.log('');
      if (isSearchMode) {
        console.log(chalk.gray('  Type to filter | Backspace: delete | Esc: cancel | Enter: confirm'));
      } else {
        console.log(chalk.gray('  ↑/↓ PgUp/PgDn Home/End: Navigate | Space: Toggle | T: Filter | /: Search'));
        console.log(chalk.gray(isEditMode ? '  Enter: Apply | Esc: Back (keep selection)' : '  Enter: Start'));
      }
      console.log('');
    };

    const handleKey = (str: string | undefined, key: readline.Key) => {
      const allGames = getVisibleGames();
      hint = '';

      // Hand the abort back to the caller so it can log off cleanly instead of
      // exiting mid-session.
      if (key.ctrl && key.name === 'c') {
        cleanup();
        resolve({ selectedGames: [], aborted: true });
        return;
      }

      if (key.name === 'up') {
        if (cursorIndex > 0) {
          cursorIndex--;
          if (cursorIndex < scrollOffset) {
            scrollOffset = cursorIndex;
          }
        }
        render();
        return;
      }

      if (key.name === 'down') {
        if (cursorIndex < allGames.length - 1) {
          cursorIndex++;
          if (cursorIndex >= scrollOffset + pageSize) {
            scrollOffset = cursorIndex - pageSize + 1;
          }
        }
        render();
        return;
      }

      if (key.name === 'pageup' || key.name === 'pagedown' || key.name === 'home' || key.name === 'end') {
        const last = Math.max(0, allGames.length - 1);
        if (key.name === 'home') cursorIndex = 0;
        else if (key.name === 'end') cursorIndex = last;
        else if (key.name === 'pageup') cursorIndex = Math.max(0, cursorIndex - pageSize);
        else cursorIndex = Math.min(last, cursorIndex + pageSize);
        if (cursorIndex < scrollOffset) scrollOffset = cursorIndex;
        else if (cursorIndex >= scrollOffset + pageSize) scrollOffset = cursorIndex - pageSize + 1;
        render();
        return;
      }

      if (isSearchMode) {
        if (key.name === 'return') {
          isSearchMode = false;
          render();
          return;
        }
        if (key.name === 'escape') {
          isSearchMode = false;
          searchQuery = '';
          cursorIndex = 0;
          scrollOffset = 0;
          render();
          return;
        }
        if (key.name === 'backspace') {
          if (searchQuery.length > 0) {
            searchQuery = searchQuery.slice(0, -1);
            cursorIndex = 0;
            scrollOffset = 0;
          }
          render();
          return;
        }
        if (str && str.length === 1 && !key.ctrl && !key.meta && str.charCodeAt(0) >= 32) {
          searchQuery += str;
          cursorIndex = 0;
          scrollOffset = 0;
          render();
          return;
        }
        return;
      }

      if (str === '/') {
        isSearchMode = true;
        render();
        return;
      }

      if (key.name === 'escape') {
        if (searchQuery.length > 0) {
          searchQuery = '';
          cursorIndex = 0;
          scrollOffset = 0;
          render();
          return;
        }
        // Edit mode: leave the selection exactly as it is idling now
        if (isEditMode) {
          cleanup();
          resolve({ selectedGames: selected });
        }
        return;
      }

      if (key.name === 'space') {
        const game = allGames[cursorIndex];
        if (game) {
          const selectedCount = selectableGames.filter((g) => g.selected).length;
          if (!game.selected && selectedCount >= MAX_IDLE_GAMES) {
            hint = `Steam allows at most ${MAX_IDLE_GAMES} games at once`;
            render();
            return;
          }
          game.selected = !game.selected;
        }
        render();
        return;
      }

      if (str === 't' || str === 'T') {
        const focusedAppId = allGames[cursorIndex]?.appid;
        const idx = FILTER_CYCLE.indexOf(sourceFilter);
        sourceFilter = FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length] ?? 'all';

        const visible = getVisibleGames();
        const refoundIndex =
          focusedAppId !== undefined ? visible.findIndex((g) => g.appid === focusedAppId) : -1;
        cursorIndex = refoundIndex >= 0 ? refoundIndex : 0;
        scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, visible.length - pageSize)));
        if (cursorIndex < scrollOffset) {
          scrollOffset = cursorIndex;
        } else if (cursorIndex >= scrollOffset + pageSize) {
          scrollOffset = cursorIndex - pageSize + 1;
        }
        render();
        return;
      }

      if (key.name === 'return') {
        const ticked = selectableGames.filter((g) => g.selected);
        if (ticked.length === 0) {
          hint = 'Nothing selected — Space toggles a game';
          render();
          return;
        }
        // Missing games are never sent to Steam, so they alone would idle nothing
        if (!ticked.some((g) => g.source !== null)) {
          hint = 'Pick at least one game from your library';
          render();
          return;
        }
        cleanup();
        resolve({ selectedGames: ticked.map((g) => ({ appid: g.appid, name: g.name })) });
        return;
      }
    };

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const keyHandler = (str: string | undefined, key: readline.Key) => {
      handleKey(str, key);
    };

    process.stdin.on('keypress', keyHandler);

    const cleanup = () => {
      process.stdin.removeListener('keypress', keyHandler);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    };

    render();
  });
}

// Formats playtime minutes into a human-readable string
function formatPlaytime(minutes: number): string {
  if (minutes === 0) {
    return 'never played';
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 1) {
    return `${minutes}m`;
  }

  return `${hours.toLocaleString()}h`;
}
