# Development: steamidler

How to build, test, add a dependency, and branch and release. The quality gates and review every change goes through are in [CLAUDE.md](../CLAUDE.md); the hard rules are in [AGENTS.md](../AGENTS.md).

## Commands

| Task | How |
|---|---|
| Install dependencies | `npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts` |
| Build and type-check | `npx pnpm@10.34.6 build` (strict `tsc`; there is no linter) |
| Run tests | `npx pnpm@10.34.6 test` (builds, then runs the offline suite in `test/`) |
| See the CLI | `node dist/index.js --help` |
| Resolve a new package | `npx pnpm@10.34.6 add <pkg>@<exact> --save-exact --lockfile-only --ignore-scripts --config.minimum-release-age=20160`, then the review in `AGENTS.md` §6 and an addendum in `SECURITY-AUDIT.md` |
| Find what's left of a plan | compare `git log` with the plan's tasks; plan checkboxes are not ticked as work lands |

## Offline test harness

How much testing a change needs is in `CLAUDE.md` §5. This is how to write and run those tests.

- The suite is in `test/`: one `node:test` file per module (`test/*.test.mjs`). Run it with `npx pnpm@10.34.6 test`, which builds first and then runs every file. It needs Node 22+.
- `test/helpers.mjs` has `dist(relPath)`, the file URL of `dist/<relPath>` for a dynamic import, and `tempHome()`, which makes a temp home with `.steam-idler/` inside and points `HOME` and `USERPROFILE` at it.
- Config paths are computed at import time: call `tempHome()` **before** the dynamic imports.
- Mock the network by assigning `globalThis.fetch`. A mock that simulates a hang rejects when `init.signal` aborts.
- `test/fake/` replaces discord.js, steam-user and steam-session with fake modules through a Node resolve hook (`module.register`, loaded with `node --import ./test/fake/register.mjs`), so no test opens a Gateway or Steam connection.
- For modules that take the shared `Runtime`, `test/fake/steamClient.mjs` (`createFakeClient()`) and `test/fake/notifier.mjs` (`createFakeNotifier()`) stand in for our own `SteamClient` and `DiscordNotifier`: settable flags, recorded calls and handlers the test fires. Drive their timers with `mock.timers` (`setTimeout`, `setInterval`, `Date`), and let an awaited login or probe settle with a real `setImmediate` after each tick.
- The script runs with `--test-concurrency=1`: the notifier's timeout tests assert tight wall-clock bounds and can fail when files run in parallel.
- `.github/workflows/ci.yml` runs the same `test` script on Ubuntu with Node 22 for every push to `main` or `dev` and every pull request. Its action versions are pinned by commit SHA.

## Branches and releases

- Work happens on feature branches off `main`.
- Releases are `vX.Y.Z` tags on `main`, matching `package.json`, with notes in [CHANGELOG.md](../CHANGELOG.md) and on the GitHub Releases page.
- Pushing is covered by `AGENTS.md` §7: only when asked, one named branch at a time.
