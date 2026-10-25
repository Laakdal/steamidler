# Saved selection, without favorites, randomizer or forced status: design

Date: 2026-10-25. Branch: `saved-selection`, off `dev` (same commit as `main`, `cb7b5d4`).

## Intent

After every update or restart the owner has to run steamidler interactively over SSH and pick their games again. Two things cause that:

- Only **starred** games (favorites, `F`) are saved. Games ticked with Space, and every `/add` from Discord, live only in memory.
- Headless mode idles favorites only, and stops with exit 2 ("No favorites configured") when there are none. That is the failure seen on the VPS.

While talking it through, the owner also decided to drop three things they don't want:

- **Favorites.** They don't care about them. There is one list, the selected games, and it is always saved.
- **The randomizer.** Every selected game idles nonstop. No idle phases, no cooldowns, and so no exempt (`∞`) game either.
- **Forcing the Steam status to Online.** The owner sets their status by hand in the Steam app and doesn't want steamidler to override it.

## Goals

- **One saved list.** The selected games are saved whenever the selection changes, however it changed: the picker at start, edit mode (`E`), `/add`, `/remove`.
- **Headless resumes** the saved selection after any restart or update, with no interactive run.
- **Interactive start** opens the picker with the saved selection already ticked and listed first, so Enter carries on where it stopped.
- **`/add` and `/remove` persist.** This deliberately reverses today's "changes last until restart".
- **Favorites removed:** the `F` and `S` keys, the favorites section in the picker, favorites as the headless source.
- **Randomizer removed:** idle phases, cooldowns, the exempt game and the `X` key, and every place that shows them (terminal table, status box, `/status`, daily report, started message).
- **Status left alone:** steamidler no longer calls `setPersona`, so the status the owner sets in the Steam app stands.
- **One-time migration:** if there is no saved selection yet but a `favorites-<account>.json` exists, its games (first 32) become the starting selection. Its exempt field is ignored. The old file is then never read again and is left on disk.
- **The session logic moves out of `src/index.ts`** into its own module, testable offline (see "Code layout").
- **Offline tests move into the repo** with a GitHub check (see "Tests in the repo").

## Non-goals

- The daily report's "today" totals still reset on a restart.
- No sync between machines, no named profiles or multiple lists.
- Hand-editing the save file is tolerated (it is validated) but not a supported way to configure steamidler, and is not documented as one.
- No other refactoring of `index.ts`: reconnect and backoff, the flush relog, the zombie check, notifications, the keyboard and shutdown stay where they are.
- No settings file. With the randomizer and the forced status gone, nothing is left to configure.
- The "paused while you play it elsewhere" state stays exactly as it is: Steam blocks the whole session then, and that is not the randomizer.

## Anti-goals (a failure even if it works)

- A damaged or hand-edited save file crashes steamidler, or stops it while a usable game is left in it.
- A saved game disappears from the list without the owner removing it.
- Saving blocks idling, delays shutdown past today's budget, or throws.
- `/add` or the picker can push the saved list past 32 games.
- Behaviour changes for anything not listed here: reconnects, takeovers, the flush relog, the zombie check, Discord notifications other than the wording changes listed below.

## Behaviour

### The save file

`~/.steam-idler/selection-<account>.json`, next to the other files, keyed by the same account name as today's favorites file. It holds no secret; it is written with `writeFileAtomic` like every other config file. Content: a format `version`, a `savedAt` time, and the selected games as appid plus name (the name only for log lines when a game is missing from the library). The exact field names are the builder's.

Nothing about playtime is saved: after a restart each game's total comes fresh from Steam (`playtime_forever`, which already includes what was idled), and "gained this session" starts at zero.

### When it is written

- After every change to the selection: picker Enter at start, edit-mode apply, `/add`, `/remove`.
- Nothing else changes the list now (no cooldowns), so there is no periodic save and no save at shutdown.

A failed write never throws: it logs the path and the error to the console (as config writes do today), and the first failure in a run also sends one Discord notice ("⚠️ Could not save the game selection — a restart will forget recent changes"). Later failures stay console-only until a write succeeds again.

### When it is read

At start, after the library is fetched, both modes:

1. Load and validate the save file.
2. If there is none, fall back to the old favorites file (migration). If neither exists, there is no saved selection.
3. Match against the library. A saved game that is not in the library is **kept and retried** (the owner's answer to the builder check): see "Saved games missing from the library". If no saved game is in the library: with incomplete license data headless exits 1 (transient), as today; with complete license data it exits 2 ("None of your N saved games are in your library"), and the file is left untouched.

Validation, on every load, salvages what it can:

- **The whole file** counts as absent only when it cannot be used at all: unreadable, not JSON, not an object, or an unknown `version`. It is then renamed to `selection-<account>.json.invalid` (replacing an older one), so it can be inspected and is never silently overwritten, and one console line says why. Loading continues with step 2, then "no saved selection".
- **Single entries** that are bad are dropped, each with a console line, and the rest is used: an appid that is not a positive integer, or a repeated appid (the first one wins).
- More than 32 entries: the first 32 are kept.

Writes are atomic, so a crash mid-write leaves the old file, not a truncated one. A save file that fails only partly never stops a start; exit 2 happens only when no selected game is left.

### Saved games missing from the library

Family-shared games can be missing at start when Steam's license data arrives after the 10 s wait, and a lender can withdraw a game for a while. The owner chose: keep such a game and retry, never drop it on its own.

- It stays in the saved selection, is not idled, and is not shown in the status table or status box.
- It counts toward the 32-game cap, so `/add` and the picker cannot fill its place by accident.
- One console line at start names the missing games ("Saved but not in your library right now: …; kept, retried at the next start").
- Every start checks again; once the game is back in the library it idles again.
- It is removed only by the owner: unticked in the picker, where it is listed ticked with a "not in library" mark in the "Selected" group, or with `/remove`, which accepts it (my call). Nothing else drops it.

### Headless

Idles the saved selection. With no saved selection it stops with exit 2: "No games selected. Run steamidler interactively once to pick games." The `🛑 Headless start failed` Discord message carries that text.

### Interactive

The picker opens with the saved selection ticked. The games that were selected when the picker opened are listed first under a "Selected" header, then the rest of the library, alphabetically. The order is fixed while the picker is open; ticking a game does not move it. Keys: Space, T (filter), `/` (search), Enter, and Esc in edit mode (back, keeping what is idling), as today. `F`, `S` and `X` are gone.

Edit mode (`E` while idling) behaves as today, plus a save on apply.

### Without the randomizer

- Every selected game idles until it is removed, or paused because it is being played elsewhere.
- Terminal table, status box, `/status` and daily report lose their cooldown parts and the `∞` mark. The status box keeps 🎮 Idling and ⏸️ Paused.
- "▶️ Idling started — N games" loses its "(exempt: …)" suffix.
- The README's randomizer description, the `X` key row and the exempt mentions go.

### Without the forced status

- The `setPersona(Online)` call on every logon is removed. steamidler sets no status at all; the owner's choice in the Steam app applies.
- **Unverified:** whether Steam still counts hours when steamidler's own session has no status set. The original author added the call after seeing the account offline following a relog (`SECURITY-AUDIT.md` §6.1), and the research notes call the "must be online" claim lore. The live checklist must check that hours keep rising for a few hours after the change, including across one 4-hour flush relog.

### Discord

`/add` and `/remove` change the saved selection. The `/status` footer line "Changes made here last until steamidler restarts; favorites are unchanged." becomes "Changes are saved and kept after a restart." The 32-game cap and the guards (`busyReason`) are unchanged.

## Code layout (the owner's choice: move the session out of `index.ts`)

- **`src/session.ts`** (new): owns the selected games and their state: idling and paused games, the saved games missing from the library, playtime banking (`bankElapsed`), applying a new selection, block and unblock (moving games to and from paused), and converting to and from the saved form. It imports nothing from Steam or Discord. Time is injectable, so every rule above can be tested offline. `src/selection.ts` (`computeSelection`) shrinks with the randomizer gone, and may fold into it.
- **`src/storage/selection.ts`** (new): load, validate and save the file, and read the legacy favorites file for migration. Never throws.
- **`src/index.ts`** keeps the Steam connection, the guards (`isWaitingForResume`, `isInEditMode`, `isShuttingDown`, `startTime`), timers, rendering, Discord and shutdown. It calls the session for every state change, then re-sends `setGamesPlaying` and renders as today. Whether `playingBlocked` lives in the session or in `index.ts` is the builder's call, as long as the guard rules in `AGENTS.md` §5 still read true.
- **`src/storage/favorites.ts`** shrinks to the read-only migration loader, or folds into `storage/selection.ts`.
- **`src/ui/gameSelector.ts`** loses favorites and exempt; it takes the saved selection as its preselection.

## Tests in the repo

- The offline tests (now throwaway files in a scratchpad, 166 of them) move into the repo under `test/`, run with `npx pnpm@10.34.6 test` against the build, using Node's built-in test runner and the existing fake discord.js loader. Tests for removed behaviour (cooldowns, exempt) are deleted, not kept.
- A GitHub Actions workflow builds and runs them on every push to `dev` and `main` and on pull requests, with the pinned pnpm and `--frozen-lockfile --ignore-scripts`. It uses only GitHub's own actions (`actions/checkout`, `actions/setup-node`), pinned to a full commit SHA, and no secrets.
- `CLAUDE.md` §5 and `docs/development.md` change from "throwaway scratchpad tests" to "tests live in `test/`".

## Constraints

- `AGENTS.md` §4 invariants hold: exit codes (no saved selection = 2, incomplete library = 1), the 32-game cap, shutdown always reaches `process.exit` within today's budget, Discord stays optional.
- `AGENTS.md` §4 "`/add` and `/remove` change the running session only and never write favorites" becomes "`/add` and `/remove` change the saved selection"; §5's state model loses the cooldown array and points to `src/session.ts`. Both in the same change.
- No new dependency. No new network destination (GitHub Actions runs on GitHub, not in steamidler).
- TypeScript strict with the stricter flags; CRLF; tests per `CLAUDE.md` §5 (the session module counts as "idling state machine": scripted offline checks of every rule, plus a live checklist).

## Docs to update with the change

README (features, keys, headless, randomizer section, Discord "changes are saved", status box sections, messages table, config tree, exit code 2 wording, VPS setup step 4), `docs/runbook.md` (restart note, the exit-2 row), `docs/architecture.md`, `docs/development.md` (tests), `docs/live-tests.md` (new checklist, including hours with no forced status), `docs/status.md`, `docs/steam-error-codes.md` (startup failure row), `AGENTS.md` §4/§5, `CLAUDE.md` §5, `SECURITY.md` (the `/add` line), `SECURITY-AUDIT.md` (dated addendum: the new file and its validation, no secrets; §6.1's forced Online is gone; the CI workflow and its pinned actions), `--help` text.

## Left to the builder

- Field names and exact shape of the save file.
- The session module's exact interface.
- Whether `computeSelection` survives as its own file.
