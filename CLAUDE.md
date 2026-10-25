@AGENTS.md

# CLAUDE.md: working in steamidler

`AGENTS.md` (imported above) holds the hard rules and wins any conflict. This file is the index to the other docs, plus how to change code safely, the quality gates, review and how much to test. A fact about the code belongs in `docs/architecture.md` or `AGENTS.md`, not here.

The user is security-cautious and audited this code before running it. Windows host, CRLF working tree, deployment on a Linux VPS.

## 1. Docs

Read a doc when its trigger applies. Update it in the same change as what it describes.

| Doc | Read when | Update when |
|---|---|---|
| [docs/status.md](docs/status.md) | starting a session or picking up work: what is released and unreleased | a feature lands on `main`, or a release is tagged |
| [docs/roadmap.md](docs/roadmap.md) | choosing what to build next, or judging whether a request is in scope | an item is confirmed, done or dropped |
| [docs/architecture.md](docs/architecture.md) | finding where code lives, or changing the idling state model | a source file is added, moved or removed; the state model changes |
| [docs/development.md](docs/development.md) | building, writing offline tests, adding a dependency, branching or releasing | a command, the test harness or the release flow changes |
| [docs/runbook.md](docs/runbook.md) | the service stops or misbehaves, updating or rolling back, a secret leaks | an exit path, a Discord message, the systemd unit or the update steps change |
| [docs/live-tests.md](docs/live-tests.md) | handing the user a live checklist, or preparing a release | a feature needing a live test lands, or the user reports a result |
| [SECURITY.md](SECURITY.md) | explaining the security model, or a vulnerability report arrives | the security model or reporting route changes |
| [SECURITY-AUDIT.md](SECURITY-AUDIT.md) | changing secrets, validation, network destinations or dependencies | any of those change, as a dated addendum section |
| [CHANGELOG.md](CHANGELOG.md) | preparing a release | a release is tagged, from `git log` since the last tag |
| [README.md](README.md) | changing anything the user sees: flags, setup, messages, systemd | shipped behavior changes (shipped behavior only) |
| [docs/steam-playtime-research.md](docs/steam-playtime-research.md) | touching the flush relog, zombie watchdog, or reconnect and backoff timers | new findings on how Steam commits playtime |
| [docs/steam-error-codes.md](docs/steam-error-codes.md) | changing how an EResult, disconnect or Steam error is handled, or which exit code it leads to | that handling changes |
| [docs/superpowers/specs/](docs/superpowers/specs/) | changing a feature that has a design, or starting a non-trivial one (§2) | the design is settled or changed |
| [docs/superpowers/plans/](docs/superpowers/plans/) | continuing planned work | a plan is written; its checkboxes are not ticked as work lands |
| [AGENTS.md](AGENTS.md) | always loaded | conventions or invariants change |

## 2. Change safely

- **Start from a clean tree** on the feature branch, so `git diff` shows exactly your change. Commit the previous task first if it is done and approved.
- **Read before changing.** `src/index.ts` is a long state machine; most "simple" changes touch a guard (`rt.isWaitingForResume`, `rt.isInEditMode`, `session.blocked`, `rt.isShuttingDown`).
- **Reuse.** Extract and share existing logic (as `Session.apply` through `installSelection` and `BOT_DOWN_REASONS` are shared) rather than writing a second copy. Untouched paths keep their behavior.
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
6. Touched files are CRLF, new Markdown files included.
7. Docs changed in the same change, per the "Update when" column in §1.

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
  - is it safe to run twice (a reconnect, a repeated event, a re-run setup)? `session.bank()` (idempotent) is the model;
  - can a missing, malformed or hand-edited config value break it;
  - does anything a shutdown path awaits reject or hang.
- **File:**
  - each function's comment is still true;
  - no dead code, and no second copy of a constant, reason string or message;
  - new module-level state is reset where the old state is.
- **Project:**
  - exit codes, headless stdin and the 32-game cap;
  - outbound destinations unchanged, or recorded in `SECURITY-AUDIT.md`;
  - the docs in §1 match the code.

Before saying something is done, read your own `git diff` end to end as a reviewer would. For changes to the state machine, networking, config or secret handling, or dependencies, also get an independent review: a fresh subagent with the diff and `AGENTS.md`. Fix or explicitly answer each finding, and check a finding about library behavior against the library source.

Report plainly: what changed, what was verified and how, what was not run, and the risk left. A live test that didn't happen is reported as not run.

## 5. How much testing

| Change | Testing |
|---|---|
| Docs, comments, wording | Build passes |
| Pure helper (formatting, parsing, validation) | Offline tests with normal, edge and hostile inputs |
| Network or config code (Discord, credentials) | As above with `fetch` mocked: failures, timeouts, tampered config files, and secrets absent from output |
| Bot client (`bot.ts`) | As above with discord.js replaced by a fake: Gateway events, login failures and retries, interactions, destroy |
| Idling state machine, timers, Steam session | Scripted checks of every guard path reachable offline, plus a live checklist for the user |

Offline tests live in `test/` and run with `npx pnpm@10.34.6 test`; the harness is in [docs/development.md](docs/development.md#offline-test-harness). Live tests are the user's to run: hand over the matching checklist from [docs/live-tests.md](docs/live-tests.md), adding one there for a new feature.
