# Changelog

What changed in each steamidler release. Versions are git tags (`v0.1.0`); install one with `git clone --branch <tag>` as the README shows.

## v0.1.0 (2026-10-22)

First release of steamidler, a fork of [steamidled](https://github.com/louisraetz/steamidled) v1.2.0 by louisraetz.

### Added

- Discord bot of your own: posts start, pause, resume, flush, zombie-session and stop notices plus a midnight daily report to a channel you pick.
- `/add`, `/remove` and `/status` slash commands to change what is idling from your phone. They answer only you, only in your server, privately, and change the running session without touching your favorites.
- Optional backup Discord webhook that takes over the notifications, and says so, when the bot's token is rejected, it loses the channel, or it is offline for 2 minutes.
- `--setup-discord` to configure the bot, channel and webhook; setup sends a test message and saves only if it works.

### Changed

- Telegram notifications replaced by Discord. The Discord settings in `~/.steam-idler/discord.json` are validated on every load, so a hand-edited file cannot redirect messages.
- Tokens and webhook URLs are kept out of logs, console output and Discord messages.
- Renamed from steamidled to steamidler; the version restarts at 0.1.0.

### Removed

- Docker support. Run it as a systemd service instead (see the README).
