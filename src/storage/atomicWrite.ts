import { renameSync, rmSync, writeFileSync } from 'node:fs';

// Replaces a file in one step. The data goes to a sibling temp file that is
// then renamed over the target, so a crash or kill part-way leaves the old
// file or the new one, never a truncated one that would break the next start.
// `mode` sets the permissions on Linux (0600 for files holding a secret).
export function writeFileAtomic(target: string, data: string, mode?: number): void {
  const temp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, data, { encoding: 'utf-8', mode });
    renameSync(temp, target);
  } catch (err) {
    // The temp copy may hold a token: remove it before passing the error on.
    // A failed removal must not hide the error that matters, the write's.
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing more to do; the write error below is the one reported
    }
    throw err;
  }
}
