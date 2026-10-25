# Roadmap: steamidler

What might come next. Every item below was collected from open items in the repo's own docs and is **unconfirmed** until the owner keeps it; delete what isn't wanted.

Update this file when an item is confirmed, done or dropped. Finished work moves to [status.md](status.md).

## Next (unconfirmed)

- **Release v0.2.0** with the live status box: a CHANGELOG entry, the `package.json` version, and the tag.
- **Live-test** the bot, the status box and the systemd unit on the VPS (see [status.md](status.md)).
- **Validate the playtime assumptions** in [docs/steam-playtime-research.md](steam-playtime-research.md) §10, "Open assumptions": that a relog commits the in-flight playtime, that `relog()` works after a refresh-token logon, and that `playtime_forever` moves visibly within a 90-minute window.

## Not planned

Each design lists what it deliberately leaves out, under **Non-goals**: [the bot](superpowers/specs/2026-10-19-discord-control-panel-design.md#non-goals) and [the status box](superpowers/specs/2026-10-22-discord-status-panel-design.md#non-goals). Reopening one starts with a new design.
