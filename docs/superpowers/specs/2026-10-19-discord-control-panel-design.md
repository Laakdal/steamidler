# Discord control panel: design

Status: **draft, awaiting the user's approval.** Nothing here is built yet.

## Intent

The user runs steamidled unattended (often headless) and wants to change which games are idling without being at the PC: from Discord, through a bot, add a game from their library or remove one. Today Discord is one-way: a webhook posts notifications and cannot receive anything.

Success: from the Discord app on a phone, the user types a command, picks a game, and within seconds the idler on the PC is idling the new set, with a confirmation reply. Notifications keep arriving even when the bot itself breaks.

## Target environment

The user plans to run steamidled **headless on a Linux VPS** (stated 2026-10-19). Development and builds happen on their Windows PC. Consequences for this design:

- `0o600` on `discord.json` and `credentials.json` (and `0o700` on `~/.steam-idler`) is enforced on Linux, so file permissions are a real protection there.
- The bot needs **no inbound ports**: the Gateway and webhook are outbound connections. The VPS firewall can stay closed except SSH.
- Discord is the user's main window into the daemon, so the fallback webhook and clear offline notices matter more than on a desktop.
- The VPS clock is likely UTC; the daily report follows `TZ`, so deployment docs must set it.

## Goals

- `/add <game>` and `/remove <game>` change the running idle set, with autocomplete from the user's library.
- `/status` shows what is idling, what is in cooldown, and the exempt game.
- Only the user can control the bot. Nobody else in the server, and no other server, can change anything.
- Existing notifications (started, paused, resumed, flush, zombie, daily report, stopped) keep working, delivered by the bot.
- If the bot dies, notifications automatically switch to a backup webhook, and the user is told the bot is down. When the bot comes back, notifications switch back and the user is told.
- Works in both interactive and headless modes, including under systemd.

## Non-goals

- Starting steamidled remotely. When the process is not running, the bot is offline; that is accepted.
- Changing favorites (stars) from Discord. `/add` and `/remove` only change what is idling now.
- Remote quit/stop, exempt-game changes, login or Steam Guard over Discord.
- Multiple Discord users or multiple Steam accounts.
- Any web server or public endpoint on the user's machine.

## Anti-goals (would make this a failure even if it works)

- Anyone other than the user being able to change the idle set, or see the user's library through the bot.
- The bot token, webhook URL, or Steam token appearing in logs, console output, or Discord messages.
- A Discord outage, bad token, or slow API noticeably delaying shutdown (`systemctl stop`), crashing the idler, or blocking idling. Discord stays optional: no config means the idler behaves exactly as today.
- A dead bot silently swallowing notifications when a working backup webhook is configured.
- A remote change corrupting the playtime bookkeeping or racing the local `E` selector.
- Pulling in dependencies that were not reviewed and recorded in `SECURITY-AUDIT.md`.

## Decided by the user

- Control happens through a **new, dedicated Discord bot** (not the user's old bot).
- Library: **`discord.js`**, reviewed and recorded in `SECURITY-AUDIT.md` before install.
- **`/add` and `/remove` change the current idling session only**, never favorites. Consequence, stated to the user: Discord changes last until steamidled restarts; a headless restart (reboot, crash, service restart) idles the favorites again.
- **Game picking from the library** via autocomplete.
- **Webhook fallback:** when the bot dies, notifications switch to a webhook automatically, with a notice.
- Docs (`AGENTS.md`, `CLAUDE.md`, this spec) come before code.

## My calls (not explicitly confirmed by the user)

- **Replies are ephemeral** (only the user sees them), so the library and status are not shown to other server members.
- **The backup webhook is optional but recommended** at setup. Without one, a dead bot means console-only errors, as today.
- **Guild commands in one server**, notifications posted by the bot into a channel picked at setup. The backup webhook can point at the same channel.

## How it works

### Discord side

- **Connection:** `discord.js` keeps one Gateway (WebSocket) connection open while steamidled runs. Commands arrive as interactions and are answered through the library (which uses HTTP callbacks under the hood).
- **Intents:** only `Guilds` (needed by `discord.js` to cache the guild and channel). Discord's gateway docs list which events need intents and say unlisted events are always sent; `INTERACTION_CREATE` is not listed. No privileged intents (Message Content, Members, Presences). The builder confirms this works during development.
- **Commands** are registered as **guild commands** in the chosen server (they appear immediately). Registration is an idempotent bulk overwrite on every startup, so renamed or removed commands do not linger. Commands set `default_member_permissions: "0"`, so Discord hides them from everyone except server admins, as a first layer.
- **Owner lock (the real control):** every interaction is checked against the owner's Discord user ID before anything else; any other user gets a short ephemeral "not allowed" reply and nothing changes. Interactions from any guild other than the configured one, or from DMs, are refused the same way. The owner ID comes from the application's owner at setup (`GET /oauth2/applications/@me`; for a team-owned application, setup asks which member).
- **Response timing:** Discord invalidates an interaction that is not answered within 3 seconds. Autocomplete is answered from the in-memory library (`allGames`), so it is always fast. Commands reply directly with the result, ephemeral (flag 64).
- **Message hygiene** (same as the current webhook code): markdown escaped, `allowed_mentions: { parse: [] }`, embeds suppressed, 2000-character split for notifications. Autocomplete returns at most 25 choices with names truncated to 100 characters (Discord's limits).

### Commands

| Command | Autocomplete source | Effect | Refused when |
|---|---|---|---|
| `/add game:<name>` | the library (`allGames`: owned, free, family-shared) minus games already selected, filtered by what the user typed | Adds the game as a new idling game for this session | already selected; 32 games already selected; any guard below |
| `/remove game:<name>` | the current selection (idling, cooldown, paused) | Removes it from the session | it is the last selected game; any guard below |
| `/status` | — | Idling games, cooldowns with time left, paused games, exempt game, the waiting reason if disconnected, and a note that Discord changes are not saved to favorites | never |

The autocomplete value is the appid (as a string); the command handler re-validates it against `allGames` / the selection, since a client can send any value. The `/add` and `/remove` replies say "until steamidled restarts" so the session-only behavior is never a surprise.

### Steamidled side

**Refactor first.** `enterEditMode()` in `src/index.ts` mixes the TTY selector with the selection diff (the block that builds `keptIdlingGames` / `keptPausedGames` / `keptPausingGames`, applies exempt changes, and adds new games). Extract that diff into one function, e.g. `applySelection(newSelection, newExemptAppId)`, which both the `E` key and the Discord commands call. Behavior of `E` must not change.

**Guards for Discord changes** (`/add`, `/remove`), checked in this order, each with a clear ephemeral reply:

- `isShuttingDown` → "steamidled is shutting down"
- `startTime === null` → "idling hasn't started yet" (headless before login, interactive before the first selection)
- `isInEditMode` → "the game selector is open on the PC"; the selector would overwrite the change when it closes
- `isWaitingForResume` → "disconnected from Steam (reason), try again after it reconnects", matching `E`'s existing refusal

**Applying a change:** `bankElapsed(idlingGames)` unless `playingBlocked`, build the new selection, call `applySelection`, re-send `client.setGamesPlaying(...)`, `renderStatus()`. Favorites are never written.

Because Node runs this on one thread and the handler is synchronous between the guard check and the re-send, a Discord change cannot interleave with the randomizer tick or the playing-state handler.

**Exempt game:** removing the exempt game clears `exemptAppId` for the session. Adding never makes a game exempt.

**Lifecycle:**

- The bot connects after login and after the library is loaded, so autocomplete has data; before that, commands get the "not started" reply.
- `handleShutdown` and `handleCrash` destroy the `discord.js` client after the final notification has been attempted.
- A Discord failure is logged (never with a secret) and never affects idling or exit codes.

### Notifications and webhook fallback

One `send(text)` entry point, as today. It never rejects and is time-bounded.

**Routing:**

- **Bot healthy:** post to the configured channel through the bot. If that post fails (timeout, 401/403/404, network), immediately retry the same message through the webhook, so no notification is lost.
- **Bot down:** post through the webhook directly.
- **No webhook configured:** bot only; failures go to the console, as today.
- **Both failing:** console only.

**When the bot counts as "down":**

- immediately on a fatal Gateway error that will not recover on its own: invalid token (close code 4004) or disallowed/invalid intents (4013/4014); and on a 401 from a bot REST call (token reset);
- on a 403/404 when posting to the channel (bot kicked, channel deleted, permission removed);
- after the Gateway has been disconnected and failing to reconnect for **2 minutes** (short blips and normal reconnects stay silent, like the existing pause grace).

**On the switch to the webhook**, one message through the webhook:

> ⚠️ Discord bot offline (reason, e.g. "token rejected" or "can't reach Discord for 2 min"). Notifications are coming through the backup webhook. /add, /remove and /status won't work until the bot is back.

The reason never includes the token or URL. If the cause is a token or permission problem, the message says what to do (reset the token and run `--setup-discord`, or re-invite the bot).

**On recovery** (the Gateway is ready again and a bot post succeeds), switch back and post through the bot:

> ✅ Discord bot back online. Commands work again.

Flapping is collapsed: at most one offline/online pair per outage, using the same debounce idea as the Steam paused/resumed notifications. After a fatal token error the bot does not retry for the rest of the run (Discord will keep rejecting it); the offline notice says a restart after fixing the token is needed.

**Time budget:** `send()` stays bounded so `systemctl stop` returns within seconds (far inside systemd's default 90 s stop timeout): the bot attempt and the webhook retry share a total budget of at most **8 s** per message, and when the bot is already known to be down only the webhook is tried. Multi-part messages (daily report) are still sent in order.

### Setup (`--setup-discord`)

1. Print the steps: create an application in the Discord Developer Portal, add a bot, copy the token. Print the invite URL (scopes `bot applications.commands`, permissions View Channel + Send Messages only) once the application ID is known.
2. Prompt for the token with a masked prompt. Validate it (must be a bot token; fetch the application ID and owner).
3. List the servers the bot is in; the user picks one (or is told to invite it first and re-run). Warn if the owner is not an admin there (the commands would be hidden). List that server's text channels; the user picks the notification channel.
4. Ask for the optional backup webhook URL (masked; validated with the existing `parseWebhookUrl`; Enter skips, with a one-line warning that a dead bot would then be silent).
5. Post a test message through the bot, and through the webhook if given; register the commands. Save only if all of those succeed.
6. Config file `~/.steam-idler/discord.json`:

```json
{ "botToken": "…", "applicationId": "…", "ownerId": "…", "guildId": "…", "channelId": "…", "webhookUrl": "…" }
```

`webhookUrl` is optional; `{ "disabled": true }` still means "skipped". Written with `writeFileAtomic(..., 0o600)`; every field is validated on every load (token shape, IDs numeric snowflakes, webhook via `parseWebhookUrl`). An invalid field makes the whole file count as not configured, with a console message. A webhook-only file from the current fork (only `webhookUrl`) keeps working as notifications-only (no commands), and the first-run prompt offers the bot setup; nothing is lost.

The first-run prompt in interactive mode stays as it is today ("Configure Discord now?").

## Dependency

**`discord.js` 14.27.0** (published 2026-07-15, `engines: node >=18`), chosen by the user. 13 direct dependencies (`@discordjs/ws`, `@discordjs/rest`, `undici`, `discord-api-types`, …). Before install: review registry metadata, maintainers, install scripts and the full transitive tree; add it to `package.json` and `pnpm-lock.yaml`; verify every new tarball's integrity hash; record all of it in `SECURITY-AUDIT.md`. Install with the pinned pnpm, `--frozen-lockfile --ignore-scripts`. If the review finds a problem (install scripts, unmaintained or suspicious packages, known exploitable advisories), stop and report to the user before going further.

## Security notes

- The bot token is a stronger secret than the webhook URL: whoever holds it controls the bot account and can read and post wherever the bot has access. Mitigations: minimal invite permissions, one server, no privileged intents, owner lock in code, never logged, `0o600` file. Revocation: "Reset Token" in the Developer Portal.
- Even with the token, an attacker cannot change the idle set without being the owner, because the owner check is in steamidled, not in Discord.
- The backup webhook URL is a second secret with the same handling as today (validated on every load, never logged). Revocation: delete the webhook.
- New outbound destinations: Discord's Gateway (`gateway.discord.gg`) and REST API (`discord.com/api`). `SECURITY-AUDIT.md` gets a new section for the bot, the fallback, and the dependency review.

## Builder's calls (settled during review)

- Two processes with the same token (e.g. running `steamidled --setup-discord` or an interactive session over SSH while the systemd service runs) would both receive every command. Only a process that has started idling answers commands; others ignore interactions. Documented in the README.
- A changed `discord.json` takes effect on the next start; the running process does not reload it.

## Testing

No test suite exists. The builder:

- keeps `tsc` passing;
- writes throwaway scripts (outside the repo) that import compiled modules from `dist/` with the network mocked, covering: owner lock (other user, other guild, DM), each guard, 32-game cap, last-game removal, autocomplete filtering and 25-choice/100-char limits, appid re-validation, config validation on load, secrets never logged, `send()` never rejecting, and the fallback: bot post fails → webhook gets the same message; fatal token error → one offline notice and webhook-only routing; recovery → one online notice; no webhook → console only; time budget under 8 s;
- checks that the `E` selector behaves the same after the `applySelection` refactor;
- gives the user a short live checklist (setup, `/add`, `/remove`, `/status`, someone else trying a command, resetting the token to see the fallback).

## Docs to update when built

`README.md` (setup, commands, session-only behavior, fallback), `SECURITY-AUDIT.md` (new section), `AGENTS.md` (bot module, new invariants), and the README's systemd section (`TZ`, running from the built clone).

## Left to the builder

Module layout (e.g. split `src/notifications/discord.ts` into notifier, bot, and setup files), exact reply wording, `/status` formatting, backoff constants, how the 8 s budget is split between bot and webhook.
