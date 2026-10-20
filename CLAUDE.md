@AGENTS.md

`AGENTS.md` holds the project facts (layout, invariants, security rules). This file is how Claude should work here. If something is a fact about the code, put it in `AGENTS.md`, not here.

## At a glance

- steamidler: TypeScript ESM CLI/daemon that idles up to 32 Steam games. Node >=18, pnpm lockfile, strict `tsc`.
- This tree is an **uncommitted local fork** of upstream v1.2.0 (`9f2b1ab`): Telegram replaced by Discord. Don't pull, reset, or commit unless asked.
- Build: `npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts`, then `npx pnpm@10.34.6 build`.
- No test suite, no linter. `tsc` is the only automated gate.
- Windows host, CRLF working tree. The user is security-cautious and audited this code before running it.

## Change safely

- Read the code you're changing first. `src/index.ts` is a long state machine; most "simple" changes touch a guard (`isWaitingForResume`, `isInEditMode`, `playingBlocked`, `isShuttingDown`).
- Prefer extracting and reusing existing logic over rewriting it. Keep behavior of untouched paths identical.
- Read `docs/steam-playtime-research.md` before touching the flush relog, zombie watchdog, or reconnect/backoff timers.
- Use Edit/Write for tracked files (keeps CRLF). Never `sed -i` on them.
- Never run the app against the user's real Steam account, and never contact Discord with real credentials, unless the user asks. Don't run unfamiliar scripts or build tools without saying what they do.
- No new or upgraded dependency until it's reviewed and the user agrees (see the dependency rule in `AGENTS.md`).

## Quality gates

A change is not done until all of these hold:

- `npx pnpm@10.34.6 build` passes with no new errors.
- `pnpm-lock.yaml` is unchanged, or every change in it was reviewed and recorded in `SECURITY-AUDIT.md`.
- No secret (Steam token, Discord token or webhook URL) can reach logs, console output, error messages, or Discord messages.
- Runtime invariants in `AGENTS.md` still hold: exit codes 0/1/2, headless never touches stdin, `send()` never rejects, 32-game cap.
- Touched files are still CRLF.

## Review

- Before saying something is done, read your own `git diff` end to end as a reviewer would.
- For changes to the state machine, networking, config/secret handling, or dependencies, also get an independent review (a fresh subagent with the diff and `AGENTS.md`), then fix or explicitly answer each finding.
- Report plainly: what changed, what was verified and how, what was not run, and any risk left. Never claim a live test that didn't happen.

## How much testing

Scale testing to the risk of the change:

| Change | Testing |
|---|---|
| Docs, comments, wording | Build passes |
| Pure helper (formatting, parsing, validation) | Throwaway script in the scratchpad importing the compiled module from `dist/`, with assertions for normal, edge, and hostile inputs |
| Network or config code (Discord, credentials) | As above with `fetch`/sockets mocked; cover failures, timeouts, tampered config files, and that secrets never appear in output |
| Idling state machine, timers, Steam session | Scripted checks of every guard path that can be exercised offline, plus a short manual test checklist for the user to run live |

Keep test scripts out of the repo (there is no test framework to put them in) unless the user asks for one.

## Docs

- `README.md`: shipped behavior only. Update it in the same change as the behavior.
- `AGENTS.md`: update when conventions, layout, or invariants change.
- `SECURITY-AUDIT.md`: update for anything security-relevant (secrets, network destinations, dependencies, validation).
- Designs go in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` before building anything non-trivial.
- New Markdown files use CRLF like the rest of the tree.
