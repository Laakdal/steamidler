# AGENTS.md: steamidler

This file applies to every AI agent and human contributor working in this repository. It holds the hard rules. **`CLAUDE.md`** indexes the other docs and covers how to work day to day (changing code safely, quality gates, review, testing). Every agent reads both; if they conflict, **AGENTS.md takes precedence**.

When a doc disagrees with the code, trust the code, and fix the doc in the same change.

## 1. What this is

`steamidler` is a Node.js CLI and daemon that idles up to 32 Steam games at once to accumulate playtime. It runs interactively (keyboard UI with a game selector) or headless (`--headless`, resumes the saved selection, runs under systemd). The deployment target is headless on a Linux VPS; development and builds happen on a Windows PC.

It started as a fork of `louisraetz/steamidled` v1.2.0 (commit `9f2b1ab`) and now lives at `github.com/Laakdal/steamidler` (version reset to 0.1.0). Every source file and doc taken from the fork has since been rewritten, so the code is this project's own and `LICENSE` names only Laakdal (`docs/superpowers/specs/2026-10-26-own-codebase-design.md`). Changes since the fork:

- Upstream's notifications replaced by a Discord bot with a backup webhook (`src/discord/`, flag `--setup-discord`). The bot also takes `/add`, `/remove` and `/status` from the owner, and they change the saved selection.
- The selected games are saved on every change and restored on every start; favorites, the randomizer and the forced Online status were removed; `src/index.ts` was split into modules; the tests live in `test/` with a GitHub Actions check.
- Docker support removed; systemd is the only documented way to run it as a service.
- `SECURITY-AUDIT.md` records the audit of v1.2.0 and every security-relevant change since (§13 onward).

Branches, releases and builds are in `docs/development.md`; what is released and what is not is in `docs/status.md`.

## 2. Project layout

The source layout, module by module, and how the idling state model works are in **`docs/architecture.md`**.

## 3. Code conventions

- TypeScript, ESM, `module: NodeNext`: relative imports end in `.js` (`import { x } from './storage/selection.js'`).
- Every function has a short `//` comment above it saying *why* it exists or what it guards against. Non-obvious branches get one too. Match this density.
- Config writes never throw: they catch, `console.error` the path and message, and return `false` or carry on, so a full disk or read-only config dir never takes the idler down.
- Conventional-commit messages (`fix:`, `feat:`, `docs:`, `chore:`, `refactor:`), matching the history.
- **Line endings:** `core.autocrlf=true` and the working tree is **CRLF**. Edit with tools that keep line endings (Edit/Write); `sed -i` from Git Bash rewrites a file as LF. pnpm also writes `package.json` and `pnpm-lock.yaml` as LF. Convert any file whose endings changed back to CRLF before finishing.

## 4. Runtime invariants

- **Exit codes:** `0` clean stop, `1` transient (a restart is useful), `2` config or terminal error (no saved login, no games selected, expired or revoked token, ban, protocol mismatch). The systemd unit's `RestartPreventExitStatus=2` depends on these.
- **Headless leaves stdin alone.** `setRawMode` in a backgrounded process triggers SIGTTOU and stops it; guard keyboard code with `isHeadless` / `IS_HEADLESS`.
- **32-game cap** (`MAX_IDLE_GAMES`): Steam's limit per `gamesPlayed` call. Everything that builds a selection respects it.
- **Steam logons back off.** Rate-limit EResults wait at least ~30 min; terminal EResults stop instead of retrying.
- **Shutdown always reaches `process.exit`.** Shutdown and crash paths (`src/shutdown.ts`) `await Promise.all([grace, discord.send(...), statusPanel.stop()])`, then `stopBot()` (capped at 1 s). So `DiscordNotifier.send()` never rejects and is time-bounded (4 s bot + 4 s webhook per part), `StatusPanel.stop()` never rejects and resolves within 4 s, and `BotHandle.destroy()` never rejects.
- **Discord stays optional.** A Discord failure is logged and never stops idling, changes an exit code, or delays shutdown. Every promise in our Discord code has a catch: `unhandledRejection` goes to `handleRejection`, which ignores only rejections raised inside the Discord libraries (`isDiscordLibraryError`) and sends everything else to `handleCrash`.
- **The bot acts only through `controlPanel`.** Its guards (`busyReason`) and `installSelection` (`Session.apply`) apply every remote change; `/add` and `/remove` change the saved selection. The bot is started only from `startIdling`, so a `--setup-discord` run or an unstarted session never answers commands.

## 5. Idling state model (`src/session.ts`)

Each selected game is in exactly one of three lists: `session.idling` or `session.paused` (an `IdlingGame`, with its playtime banked by `session.bank()`), or `session.missing` (saved but not in the library right now: never sent to Steam, but counted in the 32-game cap and kept in the saved selection). `installSelection` saves the selection after every apply. `docs/architecture.md` explains the model. The `rt.*` flags live on the shared `Runtime` (`src/runtime.ts`); each is set by one module.

Guards that every code path changing the selection respects:

- `rt.isWaitingForResume` (`src/steam/resume.ts`): disconnected or kicked; clocks frozen, `restoreIdling()` re-sends the list.
- `rt.isInEditMode` (`src/ui/keyboard.ts`): the TTY selector is open and overwrites the selection when it closes.
- `session.blocked` (`src/session.ts`, driven by `onPlayingState` in `src/start.ts`): Steam ignores `gamesPlayed` while another session plays; re-send after unblock.
- `rt.isShuttingDown` (`src/shutdown.ts`): nothing repaints or changes state.
- `rt.idlingStartedAt === null` (`startIdling` in `src/start.ts`): idling has not started yet.

After changing the arrays: re-send `rt.client.setGamesPlaying(rt.session.idling.map((g) => g.appid))` unless waiting for resume, then `rt.actions.render()`. Steam does not restore a list on its own after a block or reconnect.

## 6. Security rules

The project was audited before first use; keep it auditable.

- **Secrets:** the Steam refresh token (`credentials.json`), and the Discord bot token and backup webhook URL (`discord.json`; the URL embeds its own token) live in plaintext under `~/.steam-idler/`. Write them with `writeFileAtomic(path, data, 0o600)` (a no-op on Windows, enforced on Linux). Keep them out of logs, console output, error messages and Discord messages, including full URLs and HTTP response bodies that echo them. Log `err.message` with URLs and the token stripped, never a whole error object: discord.js errors carry request URLs that embed interaction tokens.
- **Validate stored config on every load,** not only at setup, so a hand-edited file cannot redirect traffic (`parseWebhookUrl`, `loadDiscordConfig`).
- **Outbound network** goes only to Steam (through steam-user/steam-session) and Discord (`discord.com/api`, the Gateway, webhooks). Adding a destination needs the user's agreement and a `SECURITY-AUDIT.md` entry.
- **Text sent to Discord** is user-controlled (game names, error strings): escape markdown, disable mentions (`allowed_mentions: { parse: [] }`), suppress embeds, split at 2000 characters. Command replies are ephemeral and answer only the configured owner in the configured server. The one exception is the status box, which *is* an embed: it is built only by `buildStatusEmbed`, carries no URL or icon, puts game names in code blocks with backticks and control characters neutralised, and stays within Discord's embed limits.
- **Dependency rule:** before adding or upgrading a package, review it (registry metadata, maintainers, install scripts, the full transitive tree, every lockfile hash against the registry, advisories), require every new package version to be at least 14 days old, record the result in `SECURITY-AUDIT.md`, and get the user's agreement. Install only with the pinned pnpm, `--frozen-lockfile --ignore-scripts`; `npm install` ignores the lockfile.
- When behavior relevant to the audit changes, update `SECURITY-AUDIT.md` in the same change.

## 7. Never destroy work

- Commit only when the user asks or an approved plan's step says to. Push only when the user asks, naming the branches (`git push origin <branch>`); `--all` would publish the local `backup/*` branches.
- The `backup/original-history-*` branches hold the upstream history. Keep them local, and delete no branch or tag without the user asking.
- `git pull`, `reset --hard`, rebase and force-push only on the user's explicit request for that action.
- Copy code or text from another project only under a license that allows it, and add its notice to `LICENSE` in the same change. Facts and ideas (how steam-user behaves, what an EResult means) need no notice; copied code and wording do.
- Run the app against the real Steam account, or contact Discord with real credentials, only when the user asks: it logs in and changes the account's playing state.

## 8. Everything else

`CLAUDE.md` covers:

- the docs index: which doc to read when, and which doc to update;
- the safe-change procedure;
- the quality gates and the review at four zooms;
- how much to test.
