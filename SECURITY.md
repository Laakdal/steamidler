# Security: steamidler

steamidler holds a Steam login and, optionally, a Discord bot token, so it is built to be audited. This page is the overview; the rules contributors follow are in [AGENTS.md](AGENTS.md) §6, and the full audit with a dated addendum for every security-relevant change is [SECURITY-AUDIT.md](SECURITY-AUDIT.md).

## Supported versions

Only the latest release tag gets fixes. Check [CHANGELOG.md](CHANGELOG.md) for the current one.

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Please don't open a public issue, and leave tokens, webhook URLs and `~/.steam-idler/` file contents out of the report.

## Security model in brief

- **Secrets** live in plain text in `~/.steam-idler/`: the Steam refresh token in `credentials.json`, and the Discord bot token and backup webhook URL in `discord.json`. On Linux they are written owner-only (`0600`); on Windows that has no effect. If one leaks: for the Steam token see [SECURITY-AUDIT.md](SECURITY-AUDIT.md) §6.2, for the bot token and webhook see the README's [Keep the token and webhook secret](README.md#keep-the-token-and-webhook-secret).
- **Who can control it:** only the Discord user configured as owner, in the configured server. `/add` and `/remove` change the running session only, never your favorites.
- **Where it connects:** only Steam and Discord. No server or open port on your machine.
- **Discord is optional:** a Discord failure never stops idling or delays shutdown.
- **Dependencies** are reviewed, at least 14 days old, and installed from the lockfile with install scripts disabled.
