# How Steam counts playtime, and what steamidler does about it

What is known about how Steam records playtime, the `steam-user` calls steamidler relies on, and the guards in `src/steam/flush.ts` and `src/shutdown.ts` that follow from it.

Valve does not document how playtime is committed. Points marked *(reported)* come from community reports and observation, not from Valve.

## What Steam counts

- Steam does not check that a game is actually being played. The client tells Steam which appids it is playing, and Steam's servers credit the time while that holds. A game sitting in a menu, minimised or idle counts the same.
- No game has to run at all, which is why idling works: `gamesPlayed([appids])` from `steam-user` sends that message (`CMsgClientGamesPlayed`) and nothing else.
- Steam accepts up to 32 appids in one call, the source of `MAX_IDLE_GAMES`.

## When the time is written

- The server does not write the counter continuously. It commits about every 30 minutes during play, and once more when the session ends cleanly *(reported)*. That is why profile hours lag behind.
- Hours are kept reliably only when the client is online at both ends. A session that drops without a clean end keeps what was last committed, and the rest at most shows up as a local-only difference *(reported)*. Steam has no queue that sends lost time later.
- `playtime_forever` only ever grows: nothing resets it, and hiding a game does not either. `playtime_2weeks` is meant to be a rolling 14 days, but is known to misbehave; steamidler does not use it.
- Steam shows two figures: the server's (the profile, Steam Deck) and the server's plus unsynced local time (the library). A gap between them is the "playtime discrepancy" users report.

## The incident behind the guards

A report from the original steamidled: about five days of idling without a break, until another login on the account took the session. The idler then crashed, and about five days of playtime never appeared.

Lifetime hours never go down, so nothing was reset: the time was simply never committed. A loss that size means the 30-minute commits had not been landing for days. Either the session had gone stale on Steam's side while still looking connected (a "zombie"), or an idle-only session commits mostly at a clean end, which the takeover and the crash never gave it. Reconnecting after the takeover could not help, because the time was lost at the moment of the kick.

## What steamidler does

Each guard caps the loss when a session dies unnoticed:

- **A relog every 4 hours** (`Flush.armFlush`). `client.relog()` logs off cleanly, which commits the running session, then logs on again, which also replaces a stale session. It runs through the usual disconnect and logon handlers; `rt.selfInitiatedRelog` turns the paused/resumed pair into a single "🔄 flush" line. A dead session therefore costs at most about 4 hours, not days.
- **A check that the hours grow** (`Flush.runZombieCheck`, every 90 minutes, longer than the ~30-minute commit cycle to avoid false alarms). It reads one idling game's `playtime_forever` through `getUserOwnedApps` with `filterAppids`. If a whole window passes with no growth, it relogs. If the next window is flat as well, it alerts Discord and relogs again. A failed read is skipped. A game Steam leaves out of the answer (some family-shared ones) is swapped for another. A block (another device playing) resets the baseline, because the hours stand still then by design.
- **A clean logoff on every exit** (`src/shutdown.ts`). Quitting, a signal or a crash first clears the games and logs off, then exits after a short grace so the logoff reaches Steam.
- **A report after a takeover** (`Flush.reportDrift`). After the session is back, it reads the last good playtime again and posts how much Steam kept, so a loss is visible instead of silent.

## steam-user details these rely on

- `relog()` (`components/09-logon.js`) needs a live connection and a token in steam-user's stored logon details (`_logOnDetails.access_token`), which a refresh-token logon sets. It logs off, emits `disconnected`, and reconnects with backoff from about 1 s. When it cannot run, `SteamClient.relog()` falls back to a plain `logOff()`, and the resume path logs on with the saved token.
- `getUserOwnedApps(steamID, options)` matches the Web API's `IPlayerService/GetOwnedGames`. steamidler passes `includePlayedFreeGames` and `includeFreeSub` for the library, plus `filterAppids` and `includeAppInfo: false` for the cheap single-game check.
- A refresh token is renewed over the CM connection after each logon (`SteamClient.renewToken`). steam-user's own `renewRefreshTokens` option is not used, because it has no catch.

## Still unconfirmed

1. That a clean logoff commits the running idle session. Everything above points that way, but Valve does not say so.
2. That `playtime_forever` moves within 90 minutes whenever commits are healthy. The two-strike rule exists so that one slow commit does not set off the alarm.
3. That the hours still count now that steamidler no longer sets the Steam status to Online (`docs/live-tests.md`, saved selection item 4).

## Sources

- [node-steam-user on GitHub](https://github.com/DoctorMcKay/node-steam-user) and [on npm](https://www.npmjs.com/package/steam-user)
- [McKay Dev forum: kickPlayingSession](https://dev.doctormckay.com/topic/1931-kickplayingsession/)
- [Steam Community: how the hours timer works](https://steamcommunity.com/discussions/forum/1/412446890563789440/)
- [Steam Navigator: playtime statistics](https://www.steamnavigator.com/blog/steam-playtime-statistics)
- [SteamOS issue #2145: offline playtime discrepancy](https://github.com/ValveSoftware/SteamOS/issues/2145)
- Steam Community threads on the two-week figure: [Client Beta group](https://steamcommunity.com/groups/SteamClientBeta/discussions/0/3546050190331497294/), [forum](https://steamcommunity.com/discussions/forum/7/3135045355762033877/)
