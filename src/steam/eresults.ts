import SteamUser from 'steam-user';

// How the idler treats the Steam EResult codes it can meet at logon or
// disconnect. docs/steam-error-codes.md has the reasoning for each group.

// The saved refresh token is dead: InvalidPassword (5), AccessDenied (15),
// Revoked (26), Expired (27), CachedCredentialInvalid (126). It is deleted, so
// the next interactive start asks for a fresh login.
export const DEAD_TOKEN_ERESULTS = new Set([5, 15, 26, 27, 126]);

// Nothing a retry can fix: a dead token, an account problem (Banned 17,
// AccountDisabled 43, Suspended 51, ParentalControlRestricted 69,
// AccountLockedDown 73, AccountLimitExceeded 95, AccountDeleted 114) or an
// incompatible client (InvalidProtocolVer 7, LauncherMigrated 119,
// SteamRealmMismatch 120). The idler stops and waits for the owner.
export const TERMINAL_ERESULTS = new Set([
  ...DEAD_TOKEN_ERESULTS,
  17, 43, 51, 69, 73, 95, 114,
  7, 119, 120,
]);

// Too many logons: RateLimitExceeded (84), AccountLoginDeniedThrottle (87).
// Every early retry makes Steam's lockout longer, so these wait a long time.
export const RATE_LIMIT_ERESULTS = new Set([84, 87]);

// Another device took the session: LoggedInElsewhere (6), LogonSessionReplaced (34)
export const TAKEOVER_ERESULTS = new Set([6, 34]);

// A Steam error as a short label for logs and Discord: the EResult's name when
// there is one, else the message
export function eresultLabel(err: Error & { eresult?: number }): string {
  if (err.eresult === undefined) return err.message || 'unknown';
  return SteamUser.EResult[err.eresult] ?? `eresult ${err.eresult}`;
}

// steam-user reports a takeover either as an EResult on the error or only in its message
export function isTakeoverError(err: Error & { eresult?: number }): boolean {
  if (err.eresult !== undefined && TAKEOVER_ERESULTS.has(err.eresult)) return true;
  return /loggedinelsewhere|logonsessionreplaced/i.test(err.message ?? '');
}
