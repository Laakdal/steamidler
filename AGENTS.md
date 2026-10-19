# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## What this is

`steamidled` is a Node.js CLI and daemon that idles up to 32 Steam games at once to accumulate playtime. It runs interactively (keyboard UI with a game selector) or headless (`--headless`, auto-starts favorites; run as a systemd service). The intended deployment is headless on a Linux VPS; development happens on Windows.

This tree is a **local fork** of upstream `louisraetz/steamidled` v1.2.0 (commit `9f2b1ab`), with uncommitted changes:

- Telegram notifications replaced by Discord webhooks (`src/notifications/discord.ts`, flag `--setup-discord`).
- Docker support removed (`Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `.dockerignore`); systemd is the only documented way to run it as a service.
- `SECURITY-AUDIT.md` documents the security review of v1.2.0 and the Discord change (§13).

Do not `git pull`, reset, or otherwise overwrite these local changes without asking. Do not commit unless asked.

## Build and verify

```bash
npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts
npx pnpm@10.34.6 build        # tsc, strict mode
node dist/index.js --help
```

- Use the pinned pnpm with `--frozen-lockfile --ignore-scripts`. Never `npm install` (ignores `pnpm-lock.yaml`) and never let install scripts run.
- **There is no test suite and no linter.** `tsc` passing is the only automated gate. For new logic, write a throwaway script outside the repo that imports the compiled module from `dist/` with network calls (`fetch`) mocked, and say in your report what was and was not exercised.
- Do not run the app against a real Steam account to "test" a change unless the user asks; it logs in and changes the account's playing state.

## Project layout

```
src/
  index.ts                  entry point and orchestrator: CLI flags, login, idling state machine, timers, shutdown
  constants.ts              MAX_IDLE_GAMES (32), IS_HEADLESS
  steam/client.ts           SteamClient wrapper around steam-user (gamesPlayed, events, reconnect tracking)
  steam/auth.ts             QR / credentials / stored-token login (steam-session)
  storage/                  ~/.steam-idler files: credentials, favorites, atomic writes
  notifications/discord.ts  Discord webhook notifier and --setup-discord
  notifications/dailyReport.ts  midnight report text
  ui/                       selector, status table, prompts, spinner
  types/                    shared types and hand-written module declarations (modules.d.ts)
docs/                       research notes (Steam playtime commit behavior, error codes) and specs
```

## Code conventions

- TypeScript, ESM, `module: NodeNext`: relative imports **must** end in `.js` (`import { x } from './storage/favorites.js'`).
- Every function has a short `//` comment above it explaining *why* it exists or what it guards against, not restating the code. Non-obvious branches get a comment too. Match this density.
- Config writes never throw: they catch, `console.error` the path and message, and return `false` or carry on. A full disk or read-only config dir must never take the idler down.
- No new runtime dependencies without the dependency rule below.
- Conventional-commit messages (`fix:`, `feat:`, `docs:`, `chore:`), matching the existing history.

### Line endings

`core.autocrlf=true` and the working tree is **CRLF**. Edit with tools that preserve line endings. Do not use `sed -i` from Git Bash on tracked files; it rewrites them as LF. If a file's endings change by accident, convert it back before finishing.

## Runtime invariants (do not break)

- **Exit codes:** `0` clean stop, `1` transient (restart is useful), `2` config or terminal error (no saved login, no favorites, expired/revoked token, ban, protocol mismatch). The systemd unit (`RestartPreventExitStatus=2`) depends on these.
- **Headless never touches stdin.** `setRawMode` in a backgrounded process triggers SIGTTOU and stops it. Guard keyboard code with `isHeadless` / `IS_HEADLESS`.
- **`DiscordNotifier.send()` never rejects** and has its own timeout. Shutdown and crash paths `await Promise.all([grace, send(...)])`; a rejection or hang there would skip `process.exit`.
- **32-game cap** (`MAX_IDLE_GAMES`): Steam's limit per `gamesPlayed` call. Anything that builds a selection must respect it.
- **Never hammer Steam logons.** Rate-limit EResults back off for at least ~30 min; terminal EResults stop instead of retrying.

## Idling state model (`src/index.ts`)

Each selected game is an `IdlingGame` in exactly one of three arrays:

- `idlingGames`: currently sent to Steam via `client.setGamesPlaying(...)`.
- `pausingGames`: in randomizer cooldown (`pauseUntil` set).
- `pausedGames`: frozen because another device is playing that game (`playingBlocked`).

Playtime bookkeeping: `accumulatedMs` plus the live delta since `startTime`. `bankElapsed()` folds the delta in and is idempotent, so overlapping freeze paths cannot double-count. `nextPauseAtMs === null` means the game is the exempt one (no cooldowns).

Guards that every code path changing the selection must respect:

- `isWaitingForResume`: disconnected or kicked; clocks frozen, `restoreIdling()` will re-send the list.
- `isInEditMode`: the TTY selector is open and will overwrite the selection when it closes.
- `playingBlocked`: Steam ignores `gamesPlayed` while another session plays; re-send after unblock.
- `isShuttingDown`: nothing may repaint or change state.
- `startTime === null`: idling has not started yet.

After changing the arrays: re-send `client.setGamesPlaying(idlingGames.map((g) => g.appid))` unless waiting for resume, then `renderStatus()`. Steam does not restore a list on its own after a block or reconnect.

## Security rules

The project was audited before first use; keep it auditable.

- **Secrets:** the Steam refresh token (`credentials.json`) and the Discord webhook URL (`discord.json`, the URL embeds its token) live in plaintext under `~/.steam-idler/`. Write them with `writeFileAtomic(path, data, 0o600)` (a no-op on Windows, enforced on Linux, the deployment target). **Never log, print, or include them in error messages**, including full URLs and HTTP response bodies that echo them.
- **Validate stored config on every load,** not only at setup. A hand-edited file must not redirect traffic (see `parseWebhookUrl` and `loadDiscordConfig`).
- **Outbound network** is limited to Steam (via steam-user/steam-session) and Discord's API hosts. Do not add other destinations.
- **Text sent to Discord** is user-controlled (game names, error strings): escape markdown, disable mentions (`allowed_mentions: { parse: [] }`), suppress embeds, and split at 2000 characters.
- **Dependency rule:** adding or upgrading a package requires reviewing it first (registry metadata, maintainers, install scripts, transitive tree, tarball hashes against the lockfile) and recording the result in `SECURITY-AUDIT.md`. Install only with `--frozen-lockfile --ignore-scripts` after the lockfile change is reviewed.
- When behavior relevant to the audit changes, update `SECURITY-AUDIT.md` in the same change.

## Docs

- `README.md` describes shipped behavior only; don't document unbuilt features there.
- Design specs go in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- `docs/steam-playtime-research.md` explains why the flush relog and zombie watchdog exist; read it before touching those timers.
