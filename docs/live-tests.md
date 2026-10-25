# Live tests: steamidler

Checks that need the real Steam account and Discord, so only the owner runs them. Before a release, run the checklist of every feature that changed since the last tag. After a run, write the date and version next to **Last passed**, or note what failed.

Agents hand the owner the relevant checklist and never run these themselves (`AGENTS.md` §7).

## Saved selection

**Last passed:** not recorded.

1. Update the VPS to this build. With the old `favorites-<account>.json` present and no selection file, the service starts and idles those games, and `selection-<account>.json` appears. (A favorites game that was missing from your library at that moment keeps a placeholder name `App <id>` in the file until it is back in your library and the selection is saved again. If you never starred favorites, the first start stops with "No games selected": run it interactively once, pick games, quit, start the service.)
2. `/add` a game, then restart the service: the game is still idling.
3. Your Steam status, set in the Steam app, stays as you set it after a 4-hour relog.
4. Hours on the Steam profile keep rising for 3+ hours, across one relog. (steamidler no longer sets the status Online; this checks that hours still count without it.)
5. Edit the selection file to invalid JSON and restart: a `selection-<account>.json.invalid` file appears and the service falls back (to the favorites file, or exit 2 with "No games selected").
6. Ctrl+C in interactive mode exits within a few seconds, and the status box turns red.
7. On the idling screen, `E` opens the picker with the current selection ticked; Enter applies it and it is saved (restart to confirm). `Q` quits cleanly.
8. Ctrl+C inside the picker (at start and in edit mode) exits cleanly instead of leaving the terminal in raw mode.
9. The daily report arrives at local midnight and lists the games' playtime without any cooldown or exempt parts.
10. Takeover: play a game on another device, then stop. The games pause and then idle again, with the paused and resumed notices.
11. Quit (`Q` or Ctrl+C) while a reconnect login is in flight (cut the network, wait for the paused notice, restore it and quit straight away): the process exits within a few seconds.

## Discord bot

**Last passed:** not recorded.

1. `--setup-discord`: bot and webhook test messages arrive; commands appear in the server.
2. `/status` shows the idling games; the reply is visible only to you.
3. `/add` a game by typing part of its name; the PC/VPS status table shows it within seconds.
4. `/remove` it; `/remove` the last game is refused.
5. Another account in the server tries `/status` → "not allowed" (or doesn't see the commands).
6. Reset the bot token in the Developer Portal → within seconds to minutes the webhook posts the offline notice; restart after `--setup-discord` → bot works again.
7. Play a game on another device, `/add` during the block, stop playing → the added game idles.
8. `sudo systemctl stop steamidler` returns within a few seconds and "🛑 Idling stopped" arrives.

## Live status box

**Last passed:** not recorded.

1. Rerun setup and pick a status channel.
2. The box appears grey, then turns green with a countdown once idling starts.
3. `/add` changes it within ~5 s.
4. A `systemctl restart` reuses the same message.
5. Deleting the message brings a new one within a minute.
6. `systemctl stop` turns it red.

## systemd unit

**Last passed:** not recorded. This also tests the [runbook](runbook.md).

1. `sudo systemctl enable --now steamidler` → "▶️ Idling started" arrives, and `journalctl -u steamidler` shows no `EROFS` or `EACCES` errors (the unit's `ReadWritePaths` cover every file it writes).
2. `sudo systemctl stop steamidler` returns within a few seconds; `systemctl status` shows it stopped with status 0, and it stays stopped.
3. Kill it with `sudo systemctl kill -s KILL steamidler` → systemd starts it again about 10 s later.
4. Stop it, move `~/.steam-idler/credentials.json` aside, start it → "🛑 Headless start failed — No stored login found", exit status 2, and systemd does not restart it. Move the file back and start it.
5. Reboot the server → it starts on its own and idles.
6. The daily report arrives at local midnight in the time zone set in the unit.

## Core idling

**Last passed:** not recorded. Derived from the README's [How it keeps your hours counting](../README.md#how-it-keeps-your-hours-counting); unconfirmed until the owner keeps it.

1. Play one of the idled games on another device → the status table and the status box show it paused (🟡) with the clocks frozen; stop playing → the clocks run again.
2. Cut the server's network for a few minutes → "⏸️ Idling paused" after about 30 s; once it is back, "▶️ Idling resumed" after about 90 s.
3. After 4 hours → a "🔄 flush" message, and idling carries on.
