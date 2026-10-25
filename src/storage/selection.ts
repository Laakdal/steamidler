import { readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';
import { CONFIG_DIR, ensureConfigDir, loadFavorites } from './favorites.js';
import { MAX_IDLE_GAMES } from '../constants.js';
import type { GameSelection } from '../types/index.js';

export const SELECTION_VERSION = 1;

export interface LoadedSelection {
  games: GameSelection[];
  source: 'saved' | 'favorites';
}

// Path of the account's selection file, keyed like the old favorites file
export function selectionPath(accountName: string): string {
  return join(CONFIG_DIR, `selection-${accountName}.json`);
}

// Keeps the first MAX_IDLE_GAMES valid, unique entries; each dropped one logs a line.
// `toGame` pulls the raw appid and the name out of one entry.
function cleanEntries(
  entries: unknown[],
  fileName: string,
  log: (line: string) => void,
  toGame: (entry: unknown) => { appid: unknown; name: string }
): GameSelection[] {
  const games: GameSelection[] = [];
  const seen = new Set<number>();
  entries.forEach((entry, i) => {
    const { appid, name } = toGame(entry);
    if (typeof appid !== 'number' || !Number.isSafeInteger(appid) || appid <= 0) {
      log(`${fileName}: entry ${i + 1} dropped (appid is not a positive integer)`);
    } else if (seen.has(appid)) {
      log(`${fileName}: entry ${i + 1} dropped (appid ${appid} repeated; the first one wins)`);
    } else {
      seen.add(appid);
      games.push({ appid, name });
    }
  });
  if (games.length > MAX_IDLE_GAMES) {
    log(`${fileName}: ${games.length} games saved, keeping the first ${MAX_IDLE_GAMES}`);
    games.length = MAX_IDLE_GAMES;
  }
  return games;
}

// Sets an unusable file aside as .invalid (replacing an older one) so it is never
// overwritten silently; a rename failure is logged and loading carries on.
function setAside(filePath: string, reason: string, log: (line: string) => void): void {
  const fileName = filePath.split(/[\/]/).pop();
  try {
    renameSync(filePath, `${filePath}.invalid`);
    log(`${fileName}: ${reason}; renamed to ${fileName}.invalid`);
  } catch (err) {
    log(`${fileName}: ${reason}; could not rename it: ${(err as Error).message}`);
  }
}

// Reads and validates the save file: null when absent or unusable, else the salvaged games
function loadSaved(accountName: string, log: (line: string) => void): GameSelection[] | null {
  const filePath = selectionPath(accountName);
  if (!existsSync(filePath)) return null;
  const fileName = `selection-${accountName}.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    setAside(filePath, 'unreadable or not JSON', log);
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    setAside(filePath, 'not a JSON object', log);
    return null;
  }
  const obj = parsed as { version?: unknown; games?: unknown };
  if (obj.version !== SELECTION_VERSION) {
    setAside(filePath, 'unknown version', log);
    return null;
  }
  if (!Array.isArray(obj.games)) {
    setAside(filePath, 'no games list', log);
    return null;
  }
  return cleanEntries(obj.games, fileName, log, (entry) => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as { appid?: unknown; name?: unknown };
    const name = typeof e.name === 'string' && e.name.length > 0 ? e.name : `App ${String(e.appid)}`;
    return { appid: e.appid, name };
  });
}

// Loads the saved selection, falling back to the old favorites file (read-only
// migration). null means neither file is usable.
export function loadSelection(accountName: string, log: (line: string) => void = console.log): LoadedSelection | null {
  const saved = loadSaved(accountName, log);
  if (saved) return { games: saved, source: 'saved' };

  const favFile = `favorites-${accountName}.json`;
  if (!existsSync(join(CONFIG_DIR, favFile))) return null;
  const favorites = loadFavorites(accountName) as unknown;
  if (!Array.isArray(favorites)) return null;
  const games = cleanEntries(favorites, favFile, log, (appid) => ({ appid, name: `App ${String(appid)}` }));
  return { games, source: 'favorites' };
}

// Saves the selection atomically; false (after logging the path and reason) if it could not be written
export function saveSelection(accountName: string, games: GameSelection[]): boolean {
  const filePath = selectionPath(accountName);
  try {
    ensureConfigDir();
    const data = { version: SELECTION_VERSION, savedAt: new Date().toISOString(), games };
    writeFileAtomic(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`Could not save ${filePath}: ${(err as Error).message}`);
    return false;
  }
}
