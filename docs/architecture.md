# Architecture: steamidler

How the code is laid out and how the idling state model works. The rules every change must keep (exit codes, invariants, guards) are in [AGENTS.md](../AGENTS.md) §4 and §5; the files under `~/.steam-idler/` are listed in the README's [Configuration](../README.md#configuration) section.

## Source layout

```
src/
  index.ts                  entry point, wiring only: builds the Steam client, notifier, Runtime and every module, the process handlers
  cli.ts                    parseArgs and main: help, version, logout, --setup-discord, then headless or interactive start
  start.ts                  App; headless and interactive start, login, startIdling and the Steam event handlers
  runtime.ts                Runtime: the shared context (Steam client, notifier, session, timers, guard flags)
  session.ts                Session: the idling, paused and missing games, banking, applying a selection, block and unblock
  timers.ts                 Timers: every timer by name, so shutdown clears them all in one call
  selection.ts              installSelection: applies a selection for the E selector and Discord commands alike, then saves it;
                            saveCurrentSelection: the save with its once-per-failure-streak Discord warning
  shutdown.ts               createShutdown: the shutdown, crash and unhandled-rejection paths; shutdown and crash end in rt.exit
  constants.ts              MAX_IDLE_GAMES (32), IS_HEADLESS
  steam/client.ts           SteamClient wrapper around steam-user (gamesPlayed, events, reconnect tracking)
  steam/auth.ts             QR / credentials / stored-token login (steam-session)
  steam/resume.ts           Resume: waiting after a disconnect or kick, logging back on, the paused/resumed notices
  steam/flush.ts            Flush: the 4-hour flush relog, the zombie watchdog and the post-takeover drift check
  storage/                  ~/.steam-idler files: credentials, the saved selection (and the old favorites file, read once), atomic writes
  discord/config.ts         discord.json load (validated every time) and save
  discord/format.ts         markdown escaping and 2000-character splitting
  discord/rest.ts           REST calls through fetch: channel posts, webhook posts, status box post/edit, command registration
  discord/notifier.ts       DiscordNotifier: bot first, webhook fallback, offline/online notices
  discord/setup.ts          --setup-discord flow
  discord/commands.ts       pure /add /remove /status logic and the owner check
  discord/controlPanel.ts   createControlPanel: what the bot may see and do, through the guards; statusSnapshot for the status box
  discord/health.ts         GatewayHealth: 2 min offline grace, fatal close codes
  discord/bot.ts            discord.js Gateway client that answers the commands
  discord/statusEmbed.ts    pure builder for the live status box embed (layout, size limits)
  discord/statusPanel.ts    StatusPanel: keeps the status box current (60 s timer, nudges, final red edit)
  discord/statusStore.ts    discord-status.json: which message is the status box (validated on load)
  notifications/dailyReport.ts  DailyReport: the midnight report, its timer and day-start snapshot; the report text
  ui/statusView.ts          StatusView: the status table and its 60 s refresh tick
  ui/keyboard.ts            the E and Q keys, and edit mode (the selector while idling)
  ui/                       selector, status table rendering, prompts, spinner
  types/                    shared types and hand-written module declarations (modules.d.ts)
docs/                       project docs (this file, development, runbook, live-tests, status, roadmap), Steam research notes;
                            designs in docs/superpowers/specs, plans in docs/superpowers/plans
```

The Discord features each have a design that explains how their modules fit together: the bot and notifier in [docs/superpowers/specs/2026-10-19-discord-control-panel-design.md](superpowers/specs/2026-10-19-discord-control-panel-design.md), the live status box in [docs/superpowers/specs/2026-10-22-discord-status-panel-design.md](superpowers/specs/2026-10-22-discord-status-panel-design.md).

## Idling state model (`src/session.ts`, driven from `src/start.ts`)

Each selected game is in exactly one of three lists of `rt.session`:

- `idling`: currently sent to Steam via `client.setGamesPlaying(...)`.
- `paused`: frozen because another device is playing that game (`session.blocked`).
- `missing`: saved but not in the library right now (a late family-shared license, a withdrawn loan). Never sent to Steam, shown only in the picker and `/status`, counted in the 32-game cap, and kept in the saved selection until the owner removes it.

`session.selection()` and `session.toSaved()` cover all three. `installSelection` (`src/selection.ts`) saves the selection after every change.

Playtime bookkeeping: `accumulatedMs` plus the live delta since `startTime`. `session.bank()` folds the delta in and is idempotent, so overlapping freeze paths cannot double-count. The guard flags (`isWaitingForResume`, `isInEditMode`, `isShuttingDown`, `idlingStartedAt`) live on the shared `Runtime`.

The guards every selection change respects, and what to do after changing the arrays, are in [AGENTS.md](../AGENTS.md) §5.
