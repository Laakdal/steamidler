# Development: steamidler

How to build, test, add a dependency, and branch and release. The quality gates and review every change goes through are in [CLAUDE.md](../CLAUDE.md); the hard rules are in [AGENTS.md](../AGENTS.md).

## Commands

| Task | How |
|---|---|
| Install dependencies | `npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts` |
| Build and type-check | `npx pnpm@10.34.6 build` (strict `tsc`; there is no linter) |
| See the CLI | `node dist/index.js --help` |
| Resolve a new package | `npx pnpm@10.34.6 add <pkg>@<exact> --save-exact --lockfile-only --ignore-scripts --config.minimum-release-age=20160`, then the review in `AGENTS.md` §6 and an addendum in `SECURITY-AUDIT.md` |
| Find what's left of a plan | compare `git log` with the plan's tasks; plan checkboxes are not ticked as work lands |

## Offline test harness

How much testing a change needs is in `CLAUDE.md` §5. This is how to write and run those tests.

- Test files are throwaway `node:test` files in your scratchpad, kept out of the repo unless the user asks for a suite.
- Each one imports compiled modules from `dist/` by absolute file URL, after `npx pnpm@10.34.6 build`.
- Config paths are computed at import time: create a temp home, set `HOME` and `USERPROFILE` to it, and create `.steam-idler/` inside it **before** the dynamic import.
- Mock the network by assigning `globalThis.fetch`. A mock that simulates a hang rejects when `init.signal` aborts.
- Replace discord.js with a fake module through a Node resolve hook (`module.register`, loaded with `node --import`), so no test opens a Gateway connection.
- Run with `node --test --test-concurrency=1`: the notifier's timeout tests assert tight wall-clock bounds and can fail when files run in parallel.

Earlier sessions' test files may still be in their scratchpads under `C:\Users\Nightingale\AppData\Local\Temp\claude\C--Mudrock-s-Headquarters-Project-Steam-Idle\*\scratchpad\tests`; copy them into your own scratchpad and run them as the regression baseline.

## Branches and releases

- Work happens on feature branches off `main`.
- Releases are `vX.Y.Z` tags on `main`, matching `package.json`, with notes in [CHANGELOG.md](../CHANGELOG.md) and on the GitHub Releases page.
- Pushing is covered by `AGENTS.md` §7: only when asked, one named branch at a time.
