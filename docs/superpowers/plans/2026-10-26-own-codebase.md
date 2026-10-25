# Own codebase Implementation Plan

> **For agentic workers:** executed natively (the owner's preference): one implementer, one final whole-branch review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No substantial portion of steamidled v1.2.0 remains, so `LICENSE` can name only Laakdal.

**Architecture:** Rewrite module by module behind the same behavior. Untested modules get characterization tests first, against the current code, so the rewrite has to pass them.

**Tech Stack:** TypeScript strict, ESM/NodeNext, `node:test` with the fakes in `test/fake/`.

**Spec:** `docs/superpowers/specs/2026-10-26-own-codebase-design.md`

## Global Constraints

- Behavior identical: exit codes 0/1/2, flags, file names and formats under `~/.steam-idler/`, Steam calls, Discord message strings, terminal prompts.
- No dependency or lockfile change.
- New code, new structure, own comments. Facts (EResults, steam-user quirks, billing types) may be reused; upstream sentences and code shape may not.
- Each task ends with `npx pnpm@10.34.6 test` green, CRLF, and a commit.
- Overlap check: `node <scratchpad>/upstream-overlap.cjs <file-regex>` lists the lines still shared with `9f2b1ab`. After a task, its files show only generic lines (spec "Done when" 1).

## Review Focus

- A stored token rejected with EResult 5/15/26/27/126 is cleared. Any other failure keeps it.
- The `logOn` guards while steam-user is connecting or reconnecting. Calling `logOn` in that state throws uncatchably and crashes the process.
- Library classification: family-shared vs free vs owned, and shared apps missing from the owned-apps response.
- Steam Guard code prompt: 3 attempts, aborted when the phone approval lands, Ctrl+C cancels.
- The selector's limits: the 32-game cap, missing games shown last, Esc cancels.

---

### Task 1: Characterization tests

**Files:** create `test/credentials.test.mjs`, `test/auth.test.mjs`; extend `test/client.test.mjs`. Add fakes to `test/fake/` as needed.

- [ ] credentials: save, then load round-trips. A missing file gives null. Malformed JSON, a missing `refreshToken` and a wrong type each give null with no throw. A save failure returns false. `clearCredentials` on a missing file does not throw.
- [ ] atomicWrite: writes the contents and leaves no temp file.
- [ ] auth `loginWithStoredCredentials`: EResult 5/15/26/27/126 clears credentials and returns `eresult`. EResult 84 and a plain error keep them. No credentials gives `success:false`.
- [ ] client: `loginWithRefreshToken` rejects when connected and when connecting, and times out at 2 min with mock timers. `getOwnedGames` tags shared, free (billing 0/3/5/12 only) and owned, and appends shared apps missing from the response under their PICS name. `setGamesPlaying` is a no-op when logged out and throws above 32. `relog` falls back to `logOff` with the manual flag, so no reconnect is pending. The disconnect flags hold: the `(0,'Logged off')` case gives no pending reconnect.
- [ ] Run against the current code: all green. Commit `test: characterize client, auth and credentials before the rewrite`.

### Task 2: Storage, types, constants

**Files:** `src/storage/atomicWrite.ts`, `credentials.ts`, `favorites.ts`, `src/types/index.ts`, `src/constants.ts`.

- [ ] Rewrite each file. The config dir helpers may move to a new `src/storage/paths.ts`, with importers updated.
- [ ] Tests green, overlap clean. Commit `refactor: rewrite storage, types and constants`.

### Task 3: Steam client

**Files:** `src/steam/client.ts`, `src/types/modules.d.ts`.

- [ ] Rewrite the client. Same public surface (getters, `loginWithRefreshToken`, `getOwnedGames`, `getPlaytimeForever`, `setGamesPlaying`, `stopPlaying`, `relog`, `abortPendingConnect`, `logout`, the `on*` registrations), or renamed with every caller updated. The library classification may move to its own pure helper.
- [ ] Rewrite the steam-user and steam-session type declarations, declaring only what the code uses.
- [ ] Tests green, overlap clean. Commit.

### Task 4: Login flow

**Files:** `src/steam/auth.ts`, `src/ui/prompts.ts`, `src/ui/spinner.ts`.

- [ ] Rewrite QR login, password plus Steam Guard login and stored login. Same prompts and outcomes.
- [ ] Tests green, overlap clean. Commit.

### Task 5: Terminal UI

**Files:** `src/ui/display.ts`, `src/ui/gameSelector.ts`, the upstream-derived parts of `src/ui/keyboard.ts`.

- [ ] Rewrite. The screens look the same. Selector keys, filters and search work the same.
- [ ] Tests green (`gameSelector.test.mjs`), overlap clean. Commit.

### Task 6: Idling core leftovers

**Files:** `src/notifications/dailyReport.ts`, and the upstream-derived parts of `src/start.ts`, `src/steam/resume.ts`, `src/steam/flush.ts`, `src/shutdown.ts`, `src/session.ts`, `src/runtime.ts`, `src/index.ts`, `src/cli.ts`, `src/discord/config.ts`, `src/discord/notifier.ts`, `src/storage/selection.ts`.

- [ ] Rewrite the lines the overlap script lists. Reword the comments in our own words. Restructure where the code still follows the upstream shape.
- [ ] Tests green, overlap clean. Commit.

### Task 7: Docs, license, audit

**Files:** `docs/steam-error-codes.md`, `docs/steam-playtime-research.md`, `README.md`, `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `AGENTS.md`, `CLAUDE.md` (if it refers to the docs), `docs/architecture.md`, `docs/status.md`, `SECURITY-AUDIT.md`.

- [ ] Rewrite both research docs in our own words, keeping every finding the code relies on.
- [ ] `LICENSE`: only `Copyright (c) 2026 Laakdal`. README credit becomes "Inspired by". AGENTS §1 and §7 per the spec. Audit §19 lists the remaining generic overlap.
- [ ] Full overlap run. Build and tests green. Commit.

### Final: whole-branch review

- [ ] One fresh reviewer on the most capable model, given the diff, `AGENTS.md`, the spec, and `git show 9f2b1ab:<file>` access. It checks for behavior changes and for remaining substantial upstream expression. Fix the findings, then report to the owner with the live checklist (login, reconnect, flush).
