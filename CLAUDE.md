@AGENTS.md

# CLAUDE.md: working in steamidler

`AGENTS.md` (imported above) holds the hard rules and wins any conflict. This file covers how to work: changing code safely, the quality gates, review, testing and docs. A fact about the code belongs in `AGENTS.md`, not here.

The user is security-cautious and audited this code before running it. Windows host, CRLF working tree, deployment on a Linux VPS.

## 1. At a glance

| Task | How |
|---|---|
| Install dependencies | `npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts` |
| Build and type-check | `npx pnpm@10.34.6 build` (strict `tsc`; there is no linter) |
| See the CLI | `node dist/index.js --help` |
| Offline tests | `node:test` files in your scratchpad, run against `dist/` (§5) |
| Resolve a new package | `npx pnpm@10.34.6 add <pkg>@<exact> --save-exact --lockfile-only --ignore-scripts --config.minimum-release-age=20160`, then the review in `AGENTS.md` §6 |
| Find what's left of a plan | compare `git log` with the plan's tasks; plan checkboxes are not ticked as work lands |
| Live test | the user runs it; you hand over a short checklist |
| Push | only when asked, one named branch at a time (`AGENTS.md` §7) |

## 2. Change safely

- **Start from a clean tree** on the feature branch, so `git diff` shows exactly your change. Commit the previous task first if it is done and approved.
- **Read before changing.** `src/index.ts` is a long state machine; most "simple" changes touch a guard (`isWaitingForResume`, `isInEditMode`, `playingBlocked`, `isShuttingDown`).
- **Reuse.** Extract and share existing logic (as `computeSelection` and `BOT_DOWN_REASONS` are shared) rather than writing a second copy. Untouched paths keep their behavior.
- **Timers:** read `docs/steam-playtime-research.md` before touching the flush relog, the zombie watchdog, or reconnect and backoff timers.
- **Library behavior:** when a design depends on what discord.js, steam-user or steam-session do, check their source in `node_modules` rather than assuming. (A failed `Client.login()` destroys that client for good, which shaped `bot.ts`.)
- **Designs first:** anything non-trivial gets a spec in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` before code. Say what you plan to change from an approved plan, and why, before doing it.
- **Unfamiliar tools:** say what a script or build tool does before running it.

## 3. Quality gates

Run these before reporting any change as done. A gate that fails blocks the report: fix it, or tell the user why it is left.

1. `npx pnpm@10.34.6 build` passes with no new errors.
2. The offline tests for every touched module pass, and the earlier test files still pass (§5).
3. `pnpm-lock.yaml` is unchanged, or every change in it was reviewed and recorded in `SECURITY-AUDIT.md`.
4. No secret (Steam token, Discord bot token, webhook URL, interaction token) can reach logs, console output, error messages or Discord messages. Check every `console.*` line and every Discord message string you touched.
5. The runtime invariants in `AGENTS.md` §4 still hold.
6. Touched files are CRLF.
7. Docs changed in the same change (§6): `README.md` for shipped behavior, `AGENTS.md` for layout or invariants, `SECURITY-AUDIT.md` for anything security-relevant.

## 4. Review at four zooms

Review each change as you make it, scaled to its size:

- **Line:**
  - a log line prints `err.message` with URLs and the token stripped, never an error object;
  - user-controlled text is escaped before it reaches Discord;
  - every promise has a catch, every network call a timeout;
  - a timer is cleared before it is re-armed, and on shutdown;
  - relative imports end in `.js`.
- **Function:**
  - which guards apply (`AGENTS.md` §5), and is each one respected;
  - is it safe to run twice (a reconnect, a repeated event, a re-run setup)? `bankElapsed` is the model;
  - can a missing, malformed or hand-edited config value break it;
  - does anything a shutdown path awaits reject or hang.
- **File:**
  - each function's comment is still true;
  - no dead code, and no second copy of a constant, reason string or message;
  - new module-level state is reset where the old state is.
- **Project:**
  - exit codes, headless stdin and the 32-game cap;
  - outbound destinations unchanged, or recorded in `SECURITY-AUDIT.md`;
  - `README.md`, `AGENTS.md` and `SECURITY-AUDIT.md` match the code.

Before saying something is done, read your own `git diff` end to end as a reviewer would. For changes to the state machine, networking, config or secret handling, or dependencies, also get an independent review: a fresh subagent with the diff and `AGENTS.md`. Fix or explicitly answer each finding, and check a finding about library behavior against the library source.

Report plainly: what changed, what was verified and how, what was not run, and the risk left. A live test that didn't happen is reported as not run.

## 5. How much testing

| Change | Testing |
|---|---|
| Docs, comments, wording | Build passes |
| Pure helper (formatting, parsing, validation) | Offline tests with normal, edge and hostile inputs |
| Network or config code (Discord, credentials) | As above with `fetch` mocked: failures, timeouts, tampered config files, and secrets absent from output |
| Bot client (`bot.ts`) | As above with discord.js replaced by a fake (below): Gateway events, login failures and retries, interactions, destroy |
| Idling state machine, timers, Steam session | Scripted checks of every guard path reachable offline, plus a live checklist for the user |

The harness:

- Test files are throwaway `node:test` files in your scratchpad, kept out of the repo unless the user asks for a suite.
- Each one imports compiled modules from `dist/` by absolute file URL, after `npx pnpm@10.34.6 build`.
- Config paths are computed at import time: create a temp home, set `HOME` and `USERPROFILE` to it, and create `.steam-idler/` inside it **before** the dynamic import.
- Mock the network by assigning `globalThis.fetch`. A mock that simulates a hang rejects when `init.signal` aborts.
- Replace discord.js with a fake module through a Node resolve hook (`module.register`, loaded with `node --import`), so no test opens a Gateway connection.
- Run with `node --test --test-concurrency=1`: the notifier's timeout tests assert tight wall-clock bounds and can fail when files run in parallel.

Earlier sessions' test files may still be in their scratchpads under `C:\Users\Nightingale\AppData\Local\Temp\claude\C--Mudrock-s-Headquarters-Project-Steam-Idle\*\scratchpad\tests`; copy them into your own scratchpad and run them as the regression baseline.

## 6. Docs

| Read | When |
|---|---|
| `docs/steam-playtime-research.md` | Before touching the flush relog, zombie watchdog, or reconnect and backoff timers |
| `docs/steam-error-codes.md` | Before changing how an EResult, disconnect or Steam error is handled, or which exit code it leads to |
| `SECURITY-AUDIT.md` | Before changing secrets, validation, network destinations or dependencies |
| `docs/superpowers/specs/` | Before changing a feature that has a design (the Discord bot: `2026-10-19-discord-control-panel-design.md`) |
| `docs/superpowers/plans/` | Before continuing planned work |
| `README.md` | Before changing anything the user sees: flags, setup, messages, systemd |

Update in the same change as the behavior:

- `README.md`: shipped behavior only.
- `AGENTS.md`: layout, conventions, invariants.
- `SECURITY-AUDIT.md`: secrets, validation, network destinations, dependencies, as a dated addendum section.

New Markdown files use CRLF like the rest of the tree.
