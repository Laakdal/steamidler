# Saved selection: design

Date: 2026-10-25. Branch: `saved-selection`, off `dev` (same commit as `main`, `cb7b5d4`).

## Intent

After every update or restart the owner has to run steamidler interactively over SSH and pick their games again. Two things cause that:

- Only **starred** games (favorites, `F`) are saved. Games ticked with Space, and every `/add` from Discord, live only in memory.
- Headless mode idles favorites only, and stops with exit 2 ("No favorites configured") when there are none. That is the failure seen on the VPS.

The randomizer has the same problem: each game's 7–30-day idle phase and its 100–200-hour cooldown live only in memory, so every restart resets them. On a VPS that is updated more than once a week, games rarely reach cooldown at all.

The owner said they don't care about favorites. So favorites go away, and the one list that matters, **the selected games**, is saved together with the randomizer state, and restored on every start.

## Goals

- **One list.** The selection (which games idle, which one is exempt `∞`) is saved whenever it changes, however it changed: the picker at start, edit mode (`E`), `/add`, `/remove`.
- **Randomizer state survives restarts.** Per game:
  - how much of its current idle phase is left;
  - when its cooldown ends, as a wall-clock time, so downtime counts toward a cooldown. A game due back at 3 pm comes back at 3 pm, or at the first start after that if steamidler was down;
  - idle-phase progress counts only time actually idled, as now.
- **Headless resumes** the saved selection after any restart or update, with no interactive run.
- **Interactive start** opens the picker with the saved selection already ticked and listed first, so Enter carries on where it stopped. Games kept from the saved selection keep their timers; newly ticked games start fresh; unticked ones are dropped.
- **`/add` and `/remove` persist.** This deliberately reverses today's "changes last until restart".
- **Favorites are removed:** the `F` and `S` keys, the favorites section in the picker, and favorites as the headless source.
- **One-time migration:** if there is no saved selection yet but a `favorites-<account>.json` exists, its games (first 32) and its exempt game become the starting selection, with fresh timers. The old file is then never read again and is left on disk.
- **The session logic moves out of `src/index.ts`** into its own module, testable offline (see "Code layout").

## Non-goals

- The daily report's "today" totals still reset on a restart.
- No sync between machines, no named profiles or multiple lists.
- Hand-editing the save file is tolerated (it is validated) but not a supported way to configure steamidler, and is not documented as one.
- No other refactoring of `index.ts`: reconnect and backoff, the flush relog, the zombie check, notifications, the keyboard and shutdown stay where they are.
- No settings for cooldown lengths or the persona; those are separate roadmap items.

## Anti-goals (a failure even if it works)

- A damaged or hand-edited save file crashes steamidler, or stops it while a usable game is left in it.
- A saved game disappears from the list without the owner removing it.
- Saving blocks idling, delays shutdown past today's budget, or throws.
- A restart double-counts playtime, or shows hours gained before the restart as gained "this session".
- `/add` or the picker can push the saved list past 32 games.
- Behaviour changes for anything not listed here: reconnects, takeovers, the flush relog, the zombie check, Discord notifications other than the `/add`/`/remove` wording.

## Behaviour

### The save file

`~/.steam-idler/selection-<account>.json`, next to the other files, keyed by the same account name as today's favorites file. It holds no secret; it is written with `writeFileAtomic` like every other config file.

Content, per game: the appid, its name (for log lines when the game is no longer in the library), and its randomizer state as one of:

- exempt (`∞`, no cooldowns);
- idling, with the idle-phase time **left** in ms;
- in cooldown, with the cooldown **end time** (ISO).

A file-format `version` and a `savedAt` time are included. The exact field names are the builder's.

Storing "time left in the phase" instead of the in-memory accumulated time is deliberate: after a restart the game's total comes fresh from Steam (`playtime_forever`, which already contains what was idled), and "gained this session" starts at zero, so nothing is counted twice. The randomizer keeps the remaining phase.

A game paused because it is being played elsewhere is saved in its underlying state (idling, or cooldown if it had one). Steam re-reports the block after logon.

### When it is written

- After every change to the selection or to a game's state: picker Enter at start, edit-mode apply, `/add`, `/remove`, a game entering or leaving cooldown, a block releasing games.
- Every 5 minutes while idling, so idle-phase progress is never more than 5 minutes stale. A save computes the live progress without changing the in-memory clocks (the `bankElapsed` rules still hold: no progress while frozen).
- At shutdown and in the crash handler, synchronously, before the exit grace.

A failed write never throws: it logs the path and the error to the console (as config writes do today), and the first failure in a run also sends one Discord notice ("⚠️ Could not save the game selection — a restart will forget recent changes"). Later failures stay console-only until a write succeeds again.

### When it is read

At start, after the library is fetched, both modes:

1. Load and validate the save file.
2. If there is none, fall back to the old favorites file (migration). If neither exists, there is no saved selection.
3. Match against the library. A saved game that is not in the library is **kept and retried** (the owner's answer to the builder check), see "Saved games missing from the library" below. If no saved game is in the library: with incomplete license data headless exits 1 (transient), as today; with complete license data it exits 2 ("None of your N saved games are in your library"), and the file is left untouched.

Validation, on every load, salvages what it can (builder check, my call):

- **The whole file** counts as absent only when it cannot be used at all: unreadable, not JSON, not an object, or an unknown `version`. It is then renamed to `selection-<account>.json.invalid` (replacing an older one), so it can be inspected and is never silently overwritten, and one console line says why. Loading continues with step 2 (favorites migration), then "no saved selection".
- **Single entries** that are bad are dropped, each with a console line, and the rest is used:
  - an appid that is not a positive integer, or a repeated appid (the first one wins);
  - an unknown state, or a time left that is not a finite number ≥ 0, or a cooldown end that is not a valid date.
- Clamped instead of dropped: a time left above the longest idle phase (30 days) is clamped to it; a cooldown end further away than the longest cooldown (200 h from now) is clamped to that.
- More than 32 entries: the first 32 are kept. More than one exempt game: the first one stays exempt, the others become normal games with a fresh idle phase.

Writes are atomic (`writeFileAtomic`), so a crash mid-write leaves the old file, not a truncated one. A save file that fails only partly never stops a start; exit 2 happens only when, after all of the above, no selected game is left.

### Saved games missing from the library

Family-shared games can be missing at start when Steam's license data arrives after the 10 s wait, and a lender can withdraw a game for a while. The owner chose: keep such a game and retry, never drop it on its own.

- It stays in the saved selection with its saved state unchanged (idle time left, or the cooldown end time, which keeps running on the wall clock). It is not idled and not shown in the status table or status box.
- It counts toward the 32-game cap, so `/add` and the picker cannot fill its place by accident.
- One console line at start names the missing games ("Saved but not in your library right now: …; kept, retried at the next start").
- Every start checks again. Once the game is back in the library it rejoins the session with its saved state, as if it had never been missing.
- It is removed only by the owner: unticked in the picker, where it is listed ticked with a "not in library" mark (in the "Selected" group), or with `/remove`, which accepts it (my call). Nothing else drops it.
- Saves write it back unchanged.

### Headless

Resumes the saved selection: timers restored, cooldown games stay in cooldown (or rejoin idling if their cooldown ended during downtime, with a fresh idle phase, like a normal cooldown exit). With no saved selection it stops with exit 2: "No games selected. Run steamidler interactively once to pick games." The `🛑 Headless start failed` Discord message carries that text.

### Interactive

The picker opens with the saved selection ticked. The games that were selected when the picker opened are listed first under a "Selected" header, then the rest of the library, alphabetically. The order is fixed while the picker is open; ticking a game does not move it. Keys: Space, X (exempt), T (filter), `/` (search), Enter, Esc in edit mode, as today. `F` and `S` are gone. X no longer writes a file the moment it is pressed; the exempt choice is saved with the selection when the picker closes. Esc in edit mode keeps today's behaviour (builder check, my call): the ticks go back to what is idling, but an X change still applies, and is saved. The edit-mode help line changes from "Esc: Back (keep selection; F/X already saved)" to "Esc: Back (keep selection; X still applies)".

Edit mode (`E` while idling) behaves as today, plus a save on apply.

### Discord

`/add` and `/remove` change the saved selection. The `/status` footer line "Changes made here last until steamidler restarts; favorites are unchanged." becomes "Changes are saved and kept after a restart." The 32-game cap and the guards (`busyReason`) are unchanged.

## Code layout (the owner's choice: move the session out of `index.ts`)

- **`src/session.ts`** (new): owns the selected games and their state: the three arrays (idling, cooldown, paused), the saved games missing from the library, the exempt game, playtime banking (`bankElapsed`), the randomizer tick, applying a new selection (through the existing `computeSelection`), block and unblock (moving games to and from paused), and converting to and from the saved form. It imports nothing from Steam or Discord. Time and randomness are injectable, so every rule above can be tested offline.
- **`src/storage/selection.ts`** (new): load, validate and save the file, and read the legacy favorites file for migration. Never throws.
- **`src/index.ts`** keeps the Steam connection, the guards (`isWaitingForResume`, `isInEditMode`, `isShuttingDown`, `startTime`), timers, rendering, Discord and shutdown. It calls the session for every state change, then re-sends `setGamesPlaying` and renders as today. Whether `playingBlocked` lives in the session or in `index.ts` is the builder's call, as long as the guard rules in `AGENTS.md` §5 still read true.
- **`src/storage/favorites.ts`** shrinks to the read-only migration loader (or folds into `storage/selection.ts`).
- **`src/ui/gameSelector.ts`** loses favorites; it takes the saved selection as its preselection.

## Constraints

- `AGENTS.md` §4 invariants hold: exit codes (no saved selection = 2, incomplete library = 1), the 32-game cap, shutdown always reaches `process.exit` within today's budget, Discord stays optional.
- `AGENTS.md` §4 "`/add` and `/remove` change the running session only and never write favorites" is replaced by "`/add` and `/remove` change the saved selection", updated in the same change, as is §5 (the state model now lives in `src/session.ts`).
- No new dependency. No new network destination.
- TypeScript strict with the new stricter flags; CRLF; tests per `CLAUDE.md` §5 (the session module counts as "idling state machine": scripted offline checks of every rule, plus a live checklist).

## Docs to update with the change

README (keys, headless, Discord "changes are saved", config tree, exit code 2 wording, VPS setup step 4), `docs/runbook.md` (restart note, the exit-2 row), `docs/architecture.md`, `docs/live-tests.md` (new checklist), `docs/status.md`, `docs/steam-error-codes.md` (startup failure row), `AGENTS.md` §4/§5, `SECURITY.md` (the `/add` line), `SECURITY-AUDIT.md` (dated addendum: new file, its validation, no secrets), `--help` text.

## Left to the builder

- Field names and exact shape of the save file.
- The session module's exact interface.
- Whether the 5-minute save rides the existing 60 s display tick or has its own timer (it must be cleared on shutdown either way).
