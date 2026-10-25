# Own codebase: rewrite the remaining steamidled code

**Status:** draft, awaiting the owner's approval.

## Why

The owner wants `LICENSE` to name only Laakdal. The MIT license of steamidled (louisraetz) requires its copyright notice in every copy that contains a substantial portion of that code, and on 2026-10-26 a lot of it was still here. Measured against upstream v1.2.0 (commit `9f2b1ab`), comparing trimmed lines of 12+ characters, 1,989 of the 6,257 such lines in the tree occur verbatim in upstream. Almost all of `src/steam/client.ts`, `src/steam/auth.ts`, `src/storage/credentials.ts`, `src/ui/display.ts`, `src/ui/gameSelector.ts`, `src/types/*` and the two research docs are the upstream text.

The notice can come out once no substantial portion of the upstream code or text is left. This project rewrites what remains, then changes `LICENSE`.

## Goals

- Every file that still carries upstream expression gets rewritten in new code, with new structure, names and comments in our own words. Upstream contributed ideas and facts; those can stay. That covers how steam-user behaves, EResult values, Steam's playtime rules and billing-type numbers.
- The two research docs (`docs/steam-error-codes.md`, `docs/steam-playtime-research.md`) get rewritten in our own words, keeping the findings.
- `LICENSE` names only `Copyright (c) 2026 Laakdal`.
- Behavior stays identical. The same exit codes, flags, files, Steam calls, Discord messages and terminal flow. A user notices nothing.

## Non-goals

- No new features, no dependency changes, no change to file formats on disk.
- No rewrite of git history. Old commits keep the license they were published with, which is correct for them.
- Tests are ours already and stay. New tests get added only where a rewritten module has none.

## Anti-goals

- A cosmetic rename (shuffling variable names over the same code) that keeps the upstream structure. That would not change the legal position and would waste the work.
- Any behavior drift in the Steam login, reconnect or flush paths, which only a live run can catch.

## Constraints

- All `AGENTS.md` rules hold: exit codes, headless stdin, the 32-game cap, secrets, CRLF, comment density, the conventions.
- User-visible strings stay the same. These are the Discord messages, the exit and stop messages, and the terminal prompts. The README, runbook and tests refer to them, and short functional strings are not what the license protects.
- Public interfaces between modules may change where the rewrite is cleaner, as long as callers and tests are updated in the same task.

## How it gets done (owner's choices)

- The owner chose to rewrite everything, with behavior kept as it is today.
- Native execution: I write every task myself, with one fresh review of the whole branch at the end.
- Branch `rewrite-upstream`, off `dev`.

## Done when

1. The overlap measurement (a script that lists lines shared verbatim with `9f2b1ab`) shows only generic lines in each file. Generic lines are library imports, closing braces and keywords, a steam-user or steam-session API call whose shape the library dictates, a user-visible string kept on purpose, and `package.json` dependency and version lines. The audit addendum lists what is left and why.
2. Build passes and the whole offline suite passes, including the new characterization tests.
3. The final reviewer, given the upstream tree and ours, agrees that no substantial portion remains.
4. `LICENSE` and the docs are updated (below).

## Docs and credit (my calls, flagged for the owner)

- `README.md`: the line "Based on steamidled by louisraetz (MIT)" becomes "Inspired by steamidled by louisraetz." That stays true and costs nothing. The owner can remove it later.
- `AGENTS.md` §1 says it started as a fork and now is an independent rewrite. §7 drops the "keep the upstream credit" rule.
- `SECURITY-AUDIT.md` gets addendum §19, saying the code was rewritten and the security-relevant behavior is unchanged. It lists the remaining generic overlap.
- `docs/architecture.md` and `docs/status.md` get updated if file names change.

## Risk

- **Legal:** this is not a clean-room rewrite, because the rewriter has read the original. Rewriting functional code into new expression is the normal way to stop owing a notice, but this is not legal advice.
- **Behavior:** the Steam login (QR, password plus Steam Guard) and the steam-user reconnect workarounds have little offline coverage. Characterization tests go in first, and the live checklist's login and reconnect items must be run before release.
