import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';
import { dataPath, ensureDataDir } from './paths.js';
import type { StoredCredentials } from '../types/index.js';

// Holds the Steam refresh token in plaintext, so it is written owner-only (0600)
const LOGIN_FILE = dataPath('credentials.json');

// Steam refresh tokens are JWTs issued by "steam" for the "client" audience.
// steam-user decodes the token inside process.nextTick, where a throw cannot
// be caught, and an undefined token makes it log on anonymously. So anything
// that would fail its checks counts as no saved login at all.
function looksLikeRefreshToken(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  let claims: { iss?: unknown; aud?: unknown; sub?: unknown };
  try {
    claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf-8')) as typeof claims;
  } catch {
    return false;
  }
  return (
    claims?.iss === 'steam' &&
    Array.isArray(claims.aud) &&
    claims.aud.includes('client') &&
    typeof claims.sub === 'string'
  );
}

// The saved login, checked field by field; null when any part is unusable
function parseLogin(text: string): StoredCredentials | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const { accountName, refreshToken } = data as Record<string, unknown>;
  if (typeof accountName !== 'string' || accountName === '') return null;
  if (!looksLikeRefreshToken(refreshToken)) return null;
  return { accountName, refreshToken };
}

// Saves the login for the next start. A config folder that cannot be written
// is reported and returns false, so the login still works for this run.
export function saveCredentials(login: StoredCredentials): boolean {
  try {
    ensureDataDir();
    writeFileAtomic(LOGIN_FILE, JSON.stringify(login, null, 2), 0o600);
    return true;
  } catch (err) {
    console.error(`Could not save credentials to ${LOGIN_FILE}: ${(err as Error).message}`);
    return false;
  }
}

// The saved login, or null. A file that cannot be read right now (permissions,
// I/O) is left in place; one that reads but makes no sense is deleted, so the
// next start asks for a login instead of failing on it again.
export function loadCredentials(): StoredCredentials | null {
  let text: string;
  try {
    // Tightens a file an older version wrote world-readable; no-op on Windows
    chmodSync(LOGIN_FILE, 0o600);
  } catch {
    // Missing file or no POSIX permissions: the read below decides
  }
  try {
    text = readFileSync(LOGIN_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error(`Could not read ${LOGIN_FILE}: ${(err as Error).message}`);
    return null;
  }
  const login = parseLogin(text);
  if (!login) {
    console.error(`Ignoring unreadable credentials file ${LOGIN_FILE} — log in again.`);
    clearCredentials();
  }
  return login;
}

// Removes the saved login (logout, or a token Steam rejected for good)
export function clearCredentials(): void {
  try {
    rmSync(LOGIN_FILE, { force: true });
  } catch (err) {
    console.error(`Could not remove ${LOGIN_FILE}: ${(err as Error).message}`);
  }
}

// True when a usable login is saved
export function hasStoredCredentials(): boolean {
  return loadCredentials() !== null;
}
