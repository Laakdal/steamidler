# steamidler

steamidler tells Steam you are playing up to 32 of your games at once, so they collect playtime and trading card drops while none of them runs. Use it in a terminal, or leave it running as a background service on a server.

Inspired by [steamidled](https://github.com/louisraetz/steamidled) by louisraetz.

## Quick start

You need Node.js 20.12 or later (22 recommended) and a Steam account.

```bash
git clone --branch dev https://github.com/Laakdal/steamidler.git
cd steamidler
npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts
npx pnpm@10.34.6 build
node dist/index.js
```

Log in (the QR code needs the Steam mobile app), tick games with `Space`, press `Enter`. From then on it remembers both your login and your games. Releases are on the [Releases page](https://github.com/Laakdal/steamidler/releases) and [CHANGELOG.md](CHANGELOG.md) lists what changed; `main` and `dev` can be ahead of them, and this README describes `dev`.

## Features

- Up to 32 games at once (Steam's limit), free and family-shared ones included
- Login by QR code, or by username, password and Steam Guard; the login is saved and renewed so it keeps working
- Your game list is saved on every change and comes back after a restart or an update
- Stops counting while you play on another device, and picks up again when you stop
- Reconnects by itself after network drops, Steam outages and session takeovers
- Optional Discord bot: notifications, a daily report, a live status message, and `/add`, `/remove` and `/status` to change what idles from your phone
- Runs headless under systemd

## Using it

```bash
node dist/index.js                   # Interactive: log in, pick games, idle
node dist/index.js --headless        # Background: saved login, saved games, no prompts
node dist/index.js --setup-discord   # Set up or change the Discord bot and backup webhook
node dist/index.js --logout          # Forget the saved Steam login
node dist/index.js --version         # Print the version
node dist/index.js --help            # List the options
```

### Interactive mode

Pick a login method, choose games in the picker, and press `Enter`. The picker opens with your saved games ticked at the top, under SELECTED.

| Where | Key | What it does |
|---|---|---|
| Picker | `↑` `↓` `PgUp` `PgDn` `Home` `End` | Move |
| Picker | `Space` | Tick or untick a game |
| Picker | `T` | Show all, owned, free or family-shared games |
| Picker | `/` | Search by name; `Esc` clears the search |
| Picker | `Enter` | Start idling (or apply the change, while editing) |
| Picker | `Esc` | While editing: go back without changes |
| Idling | `E` | Open the picker to change the games |
| Idling | `Q` or `Ctrl+C` | Quit |

A saved game that is not in your library right now (a family-shared game that was taken back, say) shows as "(not in library)". It stays in your list and is tried again at the next start, or you can untick it. The picker refuses a 33rd game, and `Enter` needs at least one game that is in your library.

### Headless mode

`--headless` logs in with the saved token and idles your saved games without asking anything. Run steamidler interactively once first, to log in and pick the games.

A start that fails because of the network or a Steam rate limit keeps the saved login; only a token Steam no longer accepts has to be replaced by logging in again. The exit code says whether a restart can help:

| Code | Meaning |
|------|---------|
| `0` | Stopped normally |
| `1` | Something passing went wrong; a restart may help |
| `2` | Needs you: no saved login, no games picked, a dead token, an account problem, or a Steam version mismatch |

## How it keeps your hours counting

- **Another device playing:** Steam ignores every idled game while someone plays on the account. steamidler stops its clocks and carries on when the other session ends.
- **Every 4 hours** it logs off and straight back on. Steam writes the playtime of a session when it ends cleanly, so a session that went bad can never lose more than those 4 hours.
- **Every 90 minutes** it checks that Steam's count for one of the games has grown, and logs on afresh if it has not.
- **Disconnects:** it retries with growing pauses. It gives up after 30 failed tries, after 10 rate-limited ones, or at once on an error that retrying cannot fix.

The research behind this is in [docs/steam-playtime-research.md](docs/steam-playtime-research.md).

## Running 24/7 on a Linux server

steamidler only connects out, to Steam and Discord, so the firewall can stay closed except for SSH.

1. Install Node.js 22 and git.
2. Get and build it as your admin user:

   ```bash
   sudo git clone --branch dev https://github.com/Laakdal/steamidler.git /opt/steamidler
   cd /opt/steamidler
   sudo npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts
   sudo npx pnpm@10.34.6 build
   ```

3. Add a user without admin rights for it:

   ```bash
   sudo useradd --system --create-home steamidler
   ```

4. Run it once as that user over SSH: scan the QR code in the terminal, say yes to the Discord setup if you want it, tick your games with `Space`, press `Enter`, then quit with `Q`. This also creates `~/.steam-idler`, which the service needs.

   ```bash
   sudo -u steamidler -H node /opt/steamidler/dist/index.js
   ```

5. Save this as `/etc/systemd/system/steamidler.service`, with your time zone in place of `Region/City` (for example `Asia/Jakarta`; the daily report goes out at local midnight) and the path from `which node`:

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
   Environment=TZ=Region/City
   Restart=on-failure
   RestartSec=10
   # Exit code 2 means a restart cannot fix the problem
   RestartPreventExitStatus=2
   # Read-only system; writable only where steamidler and steam-user keep their files
   NoNewPrivileges=yes
   PrivateTmp=yes
   ProtectSystem=strict
   ReadWritePaths=/home/steamidler/.steam-idler
   ReadWritePaths=-/home/steamidler/.local/share/node-steamuser

   [Install]
   WantedBy=multi-user.target
   ```

6. Start it, now and at every boot:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now steamidler
   ```

The [runbook](docs/runbook.md) covers the everyday commands, updating, and what to do when it stops or a secret leaks. This unit has not been tested on a live server yet.

## Discord (optional)

Your own Discord bot posts what steamidler is doing to a channel and takes commands from you. A webhook can stand by as a backup that keeps the notifications coming when the bot is down.

### Setting it up

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application, open **Bot**, click **Reset Token** and copy the token. No privileged intents are needed.
2. Optional, and worth it: in your server, **Server Settings → Integrations → Webhooks**, create a webhook and copy its URL. This is the backup.
3. Run `node dist/index.js --setup-discord` and paste the token (what you type is masked).
4. Open the invite link it prints to add the bot to your server. It asks only for View Channel, Send Messages and Embed Links. If the bot was in no server yet, run `--setup-discord` again afterwards.
5. Choose the server, the channel for notifications, and optionally a channel for the [live status box](#live-status-box). Paste the webhook URL, or press Enter to skip it.

Setup sends a test message through the bot (and the webhook), registers the commands and places the status box, and saves the settings only when all of that worked. The first interactive run offers the setup too; saying no is remembered (`{ "disabled": true }`), so it does not ask again. Settings with only a webhook keep working, as notifications without commands.

### Commands

| Command | What it does |
|---|---|
| `/add game:` | Starts idling a game from your library: type part of the name and pick it |
| `/remove game:` | Stops idling one of your games |
| `/status` | Shows what is idling, what is paused, and a Steam disconnect if there is one |

- Only you can use them: the application's owner (on a team application, the member chosen at setup), in the chosen server. Anyone else is told they are not allowed, and Discord hides the commands from members who are not admins.
- Replies are visible only to you.
- Changes are saved, so they survive a restart.
- At most 32 games, and at least one stays. A change is refused while the picker is open on the computer, while Steam is disconnected, and before idling has started.
- The bot goes online when idling starts. Use one bot token for one running steamidler: two would both answer every command.

### Live status box

One message in its own channel, edited in place, that shows what steamidler is doing:

- a coloured status: 🟢 idling, 🟡 waiting after a disconnect or paused for another device, 🛑 stopped;
- "Next update in …", counted down on your device. If updates stop (the server is down, the token was reset) it turns into "… ago", so a stale box is easy to spot;
- 🎮 the idling games, with total hours and the time gained this run, and ⏸️ the paused ones.

It updates every minute, and within about 5 seconds of `/add`, `/remove`, a disconnect or a resume. A restart keeps using the same message, a deleted one comes back within a minute, and the box turns red when steamidler stops.

To switch it on, run `--setup-discord`, pick an empty channel at **Live status channel** (so notifications don't push the box away), and restart steamidler. The bot needs **Embed Links** in that channel. Setup says how to fix it if that is missing, and a running steamidler logs it once. A bot invited before the status box existed needs Embed Links added to its role, or the new invite link opened.

### Messages

| Message | Sent when |
|---|---|
| ▶️ Idling started | Idling begins, with the number of games |
| ⏸️ Idling paused | A disconnect or takeover has lasted 30 seconds |
| ▶️ Idling resumed | The connection has been back for 90 seconds |
| 🔄 flush | The 4-hourly relog has committed the playtime |
| ⚠️ Zombie session | Steam stopped counting the playtime, and a fresh logon is forced |
| 📊 Daily idling report | Local midnight: what each game gained that day |
| 🛑 Idling stopped | You quit, it crashed, an error cannot be fixed by retrying, or a headless start failed |
| ⚠️ Discord bot offline | Through the backup webhook: the bot's token was rejected, it lost access to the channel, or it has been cut off from Discord for 2 minutes. Notifications carry on through the webhook. |
| ✅ Discord bot back online | The bot is connected again; commands work again |
| ⚠️ Could not save the game selection | A change could not be written to `~/.steam-idler/`. Idling carries on, but a restart would lose the change. Sent once until a save works; the [runbook](docs/runbook.md#when-it-stops) has the fix. |

Messages are plain text, never ping anyone, and long ones are split at Discord's 2000-character limit. Without a webhook, a message the bot cannot deliver goes to the console (the systemd journal, for the service). If the bot's token was rejected: reset it in the Developer Portal, run `--setup-discord` with the new one, and restart steamidler.

### Keep the token and the webhook secret

- The **bot token** is the bot's password: with it, anyone can read and post wherever the bot can. It still cannot change your idling, because steamidler checks your Discord user ID itself. **Reset Token** in the Developer Portal makes the old one useless.
- The **webhook URL** lets anyone post to its channel. Keep it in a private channel; deleting the webhook revokes it.
- Never paste either into a chat, an issue or a screenshot.

## Files it keeps

Everything lives in `~/.steam-idler/`:

```
~/.steam-idler/
├── credentials.json          # The saved Steam login token
├── selection-<account>.json  # Your games, saved on every change
├── discord.json              # Bot token, IDs and the optional webhook
└── discord-status.json       # Which message is the status box (no secrets)
```

`credentials.json` and `discord.json` hold secrets in plain text and are readable only by their owner on Linux. Don't share or commit them. A `selection-<account>.json` that cannot be read is renamed to `selection-<account>.json.invalid`, and steamidler starts as if no games were saved.

## Development

```bash
npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts
npx pnpm@10.34.6 build    # Type-check and compile to dist/
npx pnpm@10.34.6 test     # Build, then run the offline tests in test/
npx pnpm@10.34.6 dev      # Build, then start interactive mode
```

TypeScript in strict mode, ES modules. GitHub runs the tests on every push to `main` and `dev`. Where to look next:

- [docs/architecture.md](docs/architecture.md): how the code is laid out
- [docs/development.md](docs/development.md): building, testing, releasing
- [AGENTS.md](AGENTS.md): the project's rules
- [docs/status.md](docs/status.md) and [docs/roadmap.md](docs/roadmap.md): where it stands and what may come next
- [SECURITY.md](SECURITY.md) and [SECURITY-AUDIT.md](SECURITY-AUDIT.md): the security model, reporting, and the audit

## Disclaimer

steamidler speaks Steam's own client protocol, but idling may break Valve's terms of service. Use it at your own risk.

## License

MIT. See [LICENSE](LICENSE).
