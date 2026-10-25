# steamidler

A command-line Steam game idler. It logs in to your Steam account and reports up to 32 games as being played, so they accumulate playtime and trading card drops without the games running. It can be used interactively or as a headless background service.

Based on [steamidled](https://github.com/louisraetz/steamidled) by louisraetz (MIT).

## Features

- Log in with a QR code from the Steam mobile app, or with username, password and Steam Guard
- Idle up to 32 games at once (the Steam limit), including free and family-shared games
- Pauses automatically while you play on another device and resumes afterwards
- Reconnects on its own after connection drops, Steam outages and session takeovers
- Renews the saved login token so a long-running session keeps working
- Optional Discord bot: notifications for start, pause, resume and stop events plus a daily report, and `/add`, `/remove` and `/status` commands to change what is idling from your phone
- A backup Discord webhook that takes over the notifications if the bot goes down
- Headless mode for running as a systemd service

## Requirements

- Node.js 18.17 or later (22 recommended)
- A Steam account
- The Steam mobile app, for QR login (optional)

## Installation

This project is not published to npm. Build a release from source:

```bash
git clone --branch v0.1.0 https://github.com/Laakdal/steamidler.git
cd steamidler
npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts
npx pnpm@10.34.6 build
```

The compiled CLI is `dist/index.js`. Releases are listed on the [Releases page](https://github.com/Laakdal/steamidler/releases), and [CHANGELOG.md](CHANGELOG.md) says what changed in each. `main` may hold unreleased work.

## Usage

```bash
node dist/index.js                   # Interactive mode: log in, pick games, idle
node dist/index.js --headless        # Log in with the saved token and idle your saved games
node dist/index.js --setup-discord   # (Re)configure the Discord bot and backup webhook
node dist/index.js --logout          # Forget the saved Steam login
node dist/index.js --version         # Print the version
node dist/index.js --help            # Show all options
```

### Interactive mode

Choose a login method, select games in the selector, and press `Enter` to start idling. The login is saved, so later runs can reuse it. So is your selection: it is saved whenever it changes, and the selector opens with it ticked and listed first under "Selected".

Game selector:

| Key | Action |
|-----|--------|
| `↑` `↓`, `PgUp` `PgDn`, `Home` `End` | Move through the list |
| `Space` | Select or deselect a game |
| `T` | Filter by source: all, owned, free, family-shared |
| `/` | Search by name (`Esc` clears) |
| `Enter` | Start idling |
| `Esc` | In edit mode, return to idling without changes |

While idling:

| Key | Action |
|-----|--------|
| `E` | Edit the selection |
| `Q` | Quit |
| `Ctrl+C` | Quit immediately |

### Headless mode

`--headless` logs in with the saved token and idles the saved selection (at most 32 games). Run the program interactively once first to log in and pick games with `Space`. After that, restarts and updates need no interactive run. A saved game that is missing from your library at start (a family-shared game, for example) is kept and checked again at the next start.

A network error or Steam rate limit at startup keeps the saved login; only an expired or revoked token requires logging in again. Exit codes:

| Code | Meaning |
|------|---------|
| `0` | Stopped cleanly |
| `1` | Transient failure; restarting may help |
| `2` | Configuration or account problem (no saved login, no games selected, expired or revoked token, banned account, protocol mismatch); restarting will not help |

## How idling works

While another device plays a game on the same account, Steam blocks idling for the whole session; steamidler pauses the clocks and resumes when the other session ends. Every 4 hours it briefly logs off and on again so Steam commits the accumulated playtime, and it periodically checks that server-side playtime is actually increasing.

After a disconnect it keeps retrying with exponential backoff. It stops after 30 failed reconnects, 10 rate-limited attempts, or an error that retrying cannot fix.

## Discord bot (optional)

A Discord bot of your own posts the notifications to a channel and lets you change what is idling with slash commands. An optional backup webhook keeps the notifications coming if the bot goes down.

### Set it up

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), click **New Application**, open its **Bot** page, click **Reset Token** and copy the token. No privileged intents are needed.
2. Optional, recommended: in your server, open **Server Settings → Integrations → Webhooks**, create a webhook, and copy its URL. This is the backup route.
3. Run `node dist/index.js --setup-discord` and paste the token. Typed secrets are masked.
4. Open the invite link it prints and add the bot to your server. The link asks only for View Channel, Send Messages and Embed Links. If the bot was not in a server yet, run `--setup-discord` again after inviting it.
5. Pick the server, the notification channel and, optionally, a channel for the [live status box](#live-status-box), then paste the backup webhook URL or press Enter to skip.

Setup posts a test message through the bot (and through the webhook, if given), registers the commands, and places the status box if you picked a channel for it. It saves the settings only if all of that works. The first interactive run also offers setup; declining stores `{ "disabled": true }` so the prompt does not come back. A config from an earlier version with only a webhook keeps working as notifications only.

### Commands

| Command | What it does |
|---------|--------------|
| `/add game:` | Starts idling a game from your library. Type part of its name and pick it from the list. |
| `/remove game:` | Stops idling one of the selected games. |
| `/status` | Lists what is idling, paused games, and a Steam disconnect if there is one. |

- **Only you.** Commands work only for the application's owner (for a team-owned application, the member picked at setup), and only in the chosen server. Anyone else gets "not allowed". Discord also hides the commands from members who are not server admins.
- **Replies are private.** Only you see them.
- **Changes are saved.** `/add` and `/remove` change the saved selection, so the games are still idling after a restart.
- **Limits:** at most 32 games, and at least one stays selected. A change is refused while the game selector is open on the computer, while steamidler is disconnected from Steam, and before idling has started.
- The bot comes online when idling starts. Run one steamidler per bot token at a time: two copies would both answer every command.

### Live status box

One message in a channel of its own that shows what steamidler is doing right now, edited in place instead of posted again:

- A coloured bar and a status line:
  - 🟢 idling;
  - 🟡 waiting to resume after a disconnect, or paused while a game is played on this account elsewhere;
  - 🛑 stopped.
- "Next update in …", counting down on your device. If the box stops updating (the server is down, the token was reset), it reads "… ago" instead, so a stale box shows itself.
- Sections for 🎮 idling games (total hours and time gained this session) and ⏸️ paused games.

It updates every minute, and within about 5 seconds of `/add`, `/remove`, a disconnect or a resume. A restart keeps editing the same message; if you delete it, a new one appears within a minute. When steamidler stops, the box turns red.

To turn it on, run `--setup-discord` again, pick a channel at **Live status channel** (an empty one, so notifications don't push the box out of view), then restart steamidler. The bot needs **Embed Links** in that channel: the invite link asks for it, and setup stops with a message naming the fix if Discord refuses or hides the box. At runtime the same problem is logged once. A bot invited before this feature needs Embed Links added to its role, or the new invite link opened again.

### Messages

| Message | When |
|---------|------|
| ▶️ Idling started | Idling begins, with the game count |
| ⏸️ Idling paused | A disconnect or session takeover lasts longer than 30 seconds |
| ▶️ Idling resumed | The reconnection has held for 90 seconds |
| 🔄 flush | The 4-hourly relog that commits playtime |
| ⚠️ Zombie session | Steam stopped crediting playtime and a reconnect is forced |
| 📊 Daily idling report | Local midnight: playtime gained per game |
| 🛑 Idling stopped | Quit, crash, unrecoverable error, or a failed headless start |
| ⚠️ Discord bot offline | Sent through the backup webhook when the bot's token is rejected, it loses access to the channel, or it has been disconnected from Discord for 2 minutes. Notifications keep coming through the webhook. |
| ✅ Discord bot back online | The bot reconnected after an outage; commands work again |

Messages are plain text with mentions disabled; long reports are split to fit Discord's 2000-character limit. Without a backup webhook, notifications the bot cannot deliver go to the console (the systemd journal when running as a service).

If the offline notice says the token was rejected, reset the token in the Developer Portal, run `--setup-discord` with the new one, and restart steamidler.

### Keep the token and webhook secret

- The **bot token** controls the bot account: whoever has it can read and post wherever the bot is. It still cannot change your idling, because steamidler checks your user ID itself. To revoke it, click **Reset Token** in the Developer Portal.
- The **webhook URL** works like a password for posting to its channel. To revoke it, delete the webhook in Discord. Put it in a private channel.
- Never paste either one into a chat, an issue or a screenshot.

## Configuration

All state is stored in `~/.steam-idler/`:

```
~/.steam-idler/
├── credentials.json          # Saved Steam login token
├── selection-<account>.json  # The selected games, saved on every change
├── discord.json              # Discord bot token, IDs, optional backup webhook
└── discord-status.json       # Which message is the live status box (no secrets)
```

An older `favorites-<account>.json` is read once, only when there is no `selection-<account>.json` yet, and its games become the starting selection; the file is then left alone. A selection file that cannot be read is renamed to `selection-<account>.json.invalid` and steamidler starts as if nothing were saved.

`credentials.json` and `discord.json` contain secrets in plain text and are written with owner-only permissions on Linux. Do not share or commit them.

## Running 24/7 on a Linux VPS

steamidler only makes outgoing connections (to Steam and Discord), so the server's firewall can stay closed to everything except SSH.

1. Install Node.js 22 and git.
2. Clone and build as your admin user:

   ```bash
   sudo git clone --branch v0.1.0 https://github.com/Laakdal/steamidler.git /opt/steamidler
   cd /opt/steamidler
   sudo npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts
   sudo npx pnpm@10.34.6 build
   ```

3. Create a dedicated user without admin rights to run it:

   ```bash
   sudo useradd --system --create-home steamidler
   ```

4. Run it interactively once as that user, over SSH: log in with the QR code shown in the terminal, accept the offer to set up Discord, pick your games with `Space`, start idling with `Enter`, then quit with `Q`. The selection is saved, so the service resumes it on every start.

   ```bash
   sudo -u steamidler -H node /opt/steamidler/dist/index.js
   ```

   To set up or change Discord later, run the same command with `--setup-discord`.

5. Create `/etc/systemd/system/steamidler.service`:

   ```ini
   [Unit]
   Description=steamidler
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=steamidler
   WorkingDirectory=/opt/steamidler
   ExecStart=/usr/bin/node /opt/steamidler/dist/index.js --headless
   # Your time zone: the daily report is sent at local midnight
   Environment=TZ=Region/City
   Restart=on-failure
   RestartSec=10
   # Exit code 2 means a restart cannot fix the problem
   RestartPreventExitStatus=2
   # Hardening: read-only system, writable only where steamidler and steam-user keep their files
   NoNewPrivileges=yes
   PrivateTmp=yes
   ProtectSystem=strict
   ReadWritePaths=/home/steamidler/.steam-idler
   ReadWritePaths=-/home/steamidler/.local/share/node-steamuser

   [Install]
   WantedBy=multi-user.target
   ```

   Replace `Region/City` (for example `Asia/Jakarta`) and check the Node.js path with `which node`. `~/.steam-idler` must exist before the service starts; step 4 creates it.

6. Enable and start it:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now steamidler
   ```

Everyday commands, updating, rolling back, and what to do when it stops or a secret leaks are in the [runbook](docs/runbook.md).

This unit file has not yet been tested on a live server.

## Development

```bash
npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts
npx pnpm@10.34.6 build    # Type-check and compile to dist/
npm run dev               # Build, then start interactive mode
```

The project is TypeScript (ES modules, strict mode) with no test suite; a successful build is the only automated check. How the code is laid out is in [docs/architecture.md](docs/architecture.md), how to build, test and release in [docs/development.md](docs/development.md), and project rules in [AGENTS.md](AGENTS.md). [docs/status.md](docs/status.md) and [docs/roadmap.md](docs/roadmap.md) say where the project stands and what may come next. Security: [SECURITY.md](SECURITY.md) for the overview and reporting, [SECURITY-AUDIT.md](SECURITY-AUDIT.md) for the full audit. Background notes on Steam behavior are in [docs/](docs/).

## Disclaimer

steamidler uses Steam's official client protocol, but idling may conflict with Valve's terms of service. Use it at your own risk.

## License

MIT. See [LICENSE](LICENSE).
