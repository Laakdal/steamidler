// Shared setup for the offline tests: where the compiled code lives and an isolated home directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Maps a path under dist/ to the file URL a dynamic import needs, on any OS.
export function dist(relPath) {
  return new URL(`../dist/${relPath}`, import.meta.url).href;
}

// Makes a temp home with an empty .steam-idler/ and points HOME and USERPROFILE at it.
// Call it before importing the code under test, which reads the home dir at load time.
export function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidl-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  fs.mkdirSync(path.join(home, '.steam-idler'));
  return home;
}
