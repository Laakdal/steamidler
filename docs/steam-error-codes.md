# Steam errors and how steamidler handles them

Which Steam failures can stop steamidler, how `steam-user` (v5.3.0) reports each one, and what the code does about it. The code is the reference: `src/steam/eresults.ts` holds the EResult groups, `src/steam/resume.ts` the reconnect logic, `src/start.ts` the start-up and the Steam event handlers, `src/steam/client.ts` the guards around `steam-user`.

## How steam-user reports a failure

Three routes, and only two of them can be caught.

**The `disconnected` event.** steam-user sends it when it means to reconnect by itself (`autoRelogin`, on by default). In `components/09-logon.js`, `_handleLogOff` treats a logoff as recoverable only when its EResult is one of five: 0 (a socket closed with no logoff message), Fail (2), NoConnection (3), ServiceUnavailable (20) and TryAnotherCM (48). There are two exceptions where nothing follows the event: a logoff we asked for, and steam-user's 4 s fallback when Steam never answers a logoff, which emits `(0, 'Logged off')` straight away. `SteamClient` tracks both, so the app knows when the reconnect is its own job.

**The `error` event.** Every other logoff EResult counts as fatal and arrives here, with the code on `err.eresult` and its name as the message. An `error` event with no listener throws and kills the process, so `SteamClient` attaches one in its constructor, before anything else can happen.

**Throws nothing can catch.** Calling `logOn()` while steam-user already holds a session, or while a logon of its own is still running, throws ("Already logged on", "Already attempting to log on") from inside `process.nextTick`. No try/catch reaches that; the process dies (node-steam-user issue #481). So `SteamClient.loginWithRefreshToken` refuses while `isConnected` or `isConnecting` (steam-user's private `_connecting` flag) is true, and the resume path also waits while `isReconnecting` says steam-user is retrying by itself. The original steamidled hit this crash in practice after long idling, and fixed it in its commit "fix: random steam logon error after long continious idling".

## What steamidler does

| Group | EResults | At a headless start | While idling |
|---|---|---|---|
| Recoverable drop | 0, 2, 3, 20, 48 | (not seen at logon) | steam-user reconnects; the app waits up to 5 min for it, then cancels a stuck attempt and logs on itself |
| Takeover | LoggedInElsewhere (6), LogonSessionReplaced (34), or either name in the message | (not seen at logon) | Wait, first retry after 5 min instead of 1, and report afterwards how much playtime Steam kept |
| Rate limit | RateLimitExceeded (84), AccountLoginDeniedThrottle (87) | Waited out in the process, at least 10 min between tries, up to 10 tries, then exit 1 | Same waits; after 10 tries, stop with exit 1 |
| Dead token | InvalidPassword (5), AccessDenied (15), Revoked (26), Expired (27), CachedCredentialInvalid (126) | Delete `credentials.json`, exit 2 | Delete it, stop with exit 0 and "Manual re-login required" |
| Account problem | Banned (17), AccountDisabled (43), Suspended (51), ParentalControlRestricted (69), AccountLockedDown (73), AccountLimitExceeded (95), AccountDeleted (114) | Exit 2 | Stop with exit 0 |
| Client too old | InvalidProtocolVer (7), LauncherMigrated (119), SteamRealmMismatch (120) | Exit 2 | Stop with exit 0 |
| Anything else | e.g. Busy (10), Timeout (16), ConnectFailed (35), network errors with no EResult | Exit 1 (systemd retries); the token is kept | Retry with backoff from 1 to 15 min, up to 30 times, then stop with exit 1 |

The exit codes are the contract in `AGENTS.md` §4. Exit 2 and the clean exit 0 after a permanent failure keep systemd from restarting into the same error.

### Why rate limits get their own waits

Steam answers too many logons with a lockout of about 30 minutes, and every attempt during it makes the lockout longer, up to a day. A fast retry loop therefore makes the problem worse and can also keep the owner's own Steam client out. So a rate-limited logon never retries in under 10 minutes, the backoff goes up to 30 minutes with random spread, and a headless start waits in the process instead of exiting (systemd would restart it within seconds).

### Only some codes delete the token

A logon can fail at boot for reasons that pass: no network yet, a Steam outage, a rate limit. Deleting `credentials.json` then would leave a headless service needing an interactive login for no reason. Only the five dead-token codes delete it.

## Codes that only appear at a password login

AccountLogonDenied (63, email Steam Guard), InvalidLoginAuthCode (65), AccountLoginDeniedNeedTwoFactor (85) and TwoFactorCodeMismatch (88) come up only during the interactive password login, where steam-session handles them and `auth.ts` shows the prompt or the error. A logon with a refresh token never meets them.

## Other ways the process could end

- **An exception or rejection nobody catches** goes to `handleCrash` (`src/shutdown.ts`), which still stops the games and logs off, so Steam commits the playtime, then exits 1. A rejection raised inside the Discord libraries is logged and ignored instead (`handleRejection`).
- **`setGamesPlaying` while logged out** quietly does nothing; the resume path sends the list again once the session is back.

## Sources

- `node_modules/steam-user/enums/EResult.js`: the EResult names and numbers (0 to 129)
- `node_modules/steam-user/components/09-logon.js`: `_handleLogOff`, `logOn`, `relog`
- [node-steam-user on GitHub](https://github.com/DoctorMcKay/node-steam-user), and [issue #481](https://github.com/DoctorMcKay/node-steam-user/issues/481) on the uncatchable "Already logged on"
- [McKay Dev forum: fatal and non-fatal errors](https://dev.doctormckay.com/topic/3902-fatal-error-clarification/)
- Reports of Steam's login cooldown: [MakeUseOf](https://www.makeuseof.com/how-to-fix-too-many-login-or-signin-failures-error-steam/), [SteamDesktopAuthenticator #897](https://github.com/Jessecar96/SteamDesktopAuthenticator/issues/897)
