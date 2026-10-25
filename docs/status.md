# Status: steamidler

Where the project stands. Last updated 2026-10-26.

Update this file in the same change when a feature lands on `main` or a release is tagged.

## Released

- **v0.1.0** (2026-10-22): the Discord bot with `/add`, `/remove` and `/status`, the backup webhook, and `--setup-discord`. Notes in [CHANGELOG.md](../CHANGELOG.md).

## On `main`, not yet released

- **Live status box** in Discord: one message in a channel you pick, edited every minute and turned red on shutdown. Design: [docs/superpowers/specs/2026-10-22-discord-status-panel-design.md](superpowers/specs/2026-10-22-discord-status-panel-design.md).
- **Saved selection:** the selected games are saved on every change (picker, `E`, `/add`, `/remove`) in `selection-<account>.json` and restored on every start, headless included. An old favorites file is read once as the starting selection. Design: [docs/superpowers/specs/2026-10-25-saved-selection-design.md](superpowers/specs/2026-10-25-saved-selection-design.md).
- **Removed:** favorites (`F`, `S`), the randomizer (idle phases, cooldowns, the exempt game, `X`) and the forced Online status (no `setPersona` call).
- **`src/index.ts` split into modules**, with offline tests in the repo (`test/`) and a GitHub Actions check (`.github/workflows/ci.yml`).
- **Own codebase:** every file taken from steamidled was rewritten with the same behavior, and `LICENSE` names only Laakdal. Design: [docs/superpowers/specs/2026-10-26-own-codebase-design.md](superpowers/specs/2026-10-26-own-codebase-design.md).
- `package.json` still says 0.1.0, and `CHANGELOG.md` has no entry for it yet.

## Live tests

When each feature last passed its live checklist is recorded in [live-tests.md](live-tests.md).
