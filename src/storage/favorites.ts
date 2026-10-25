import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.steam-idler');

interface FavoritesData {
  favorites: number[];
}

// Constructs the path to an account-specific favorites JSON file
function getFavoritesPath(accountName: string): string {
  return join(CONFIG_DIR, `favorites-${accountName}.json`);
}

// Ensures the config directory exists, creating it if necessary
export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

// Reads the favorites file; an exemptAppId left by an older version is ignored
function readData(accountName: string): FavoritesData {
  const filePath = getFavoritesPath(accountName);
  if (!existsSync(filePath)) {
    return { favorites: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as FavoritesData;
    return {
      favorites: parsed.favorites || [],
    };
  } catch {
    return { favorites: [] };
  }
}

// Loads favorite game IDs from the JSON file, returning empty array if not found.
// Read only: the old file feeds the one-time migration to the selection file.
export function loadFavorites(accountName: string): number[] {
  return readData(accountName).favorites;
}
