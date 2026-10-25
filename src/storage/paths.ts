import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The one folder in the user's home where steamidler keeps its state: the Steam
// login, the Discord settings and the saved selection.
export const DATA_DIR = join(homedir(), '.steam-idler');

// Full path of a file kept in DATA_DIR
export function dataPath(fileName: string): string {
  return join(DATA_DIR, fileName);
}

// Called before every write: creates DATA_DIR readable by the owner only
// (0700). recursive makes it a no-op when the folder is already there.
export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}
