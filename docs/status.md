# Status: steamidler

Where the project stands. Last updated 2026-10-25.

Update this file in the same change when a feature lands on `main`, a release is tagged, or a live test passes or fails.

## Released

- **v0.1.0** (2026-10-22): the Discord bot with `/add`, `/remove` and `/status`, the backup webhook, and `--setup-discord`. Notes in [CHANGELOG.md](../CHANGELOG.md).

## On `main`, not yet released

- **Live status box** in Discord: one message in a channel you pick, edited every minute and turned red on shutdown. Design: [docs/superpowers/specs/2026-10-22-discord-status-panel-design.md](superpowers/specs/2026-10-22-discord-status-panel-design.md).
- `package.json` still says 0.1.0, and `CHANGELOG.md` has no entry for it yet.

## Not yet live-tested

No live test result is recorded in the repo for:

- the systemd unit in the README (the README says so too);
- the live status box (live checklist in [docs/superpowers/plans/2026-10-23-discord-status-panel.md](superpowers/plans/2026-10-23-discord-status-panel.md), Step 8);
- the Discord bot on the VPS (live checklist in [docs/superpowers/plans/2026-10-19-discord-control-panel.md](superpowers/plans/2026-10-19-discord-control-panel.md), Task 9).
