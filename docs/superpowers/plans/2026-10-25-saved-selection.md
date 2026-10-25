# Saved selection and index.ts split: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** steamidler saves the selected games and restores them on every start. Favorites, the randomizer and the forced Online status are gone. `src/index.ts` is split into single-purpose modules that are tested offline from a test suite in the repo, checked on GitHub.

**Architecture:** One shared `Runtime` object holds the Steam client, the notifier, the `Session` (selected games and their state), a `Timers` registry and the guard flags. Every module takes the runtime, plus explicit collaborators, instead of reading module-level variables. `index.ts` only wires them together. The selection file is a small validated JSON list written on every change.

**Tech Stack:** TypeScript (strict, NodeNext, ESM), Node `node:test` with `mock.timers`, pnpm 10.34.6, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-25-saved-selection-design.md`

## Global Constraints

- Relative imports end in `.js`. Every function has a short `//` comment saying why it exists. CRLF in every touched file, new ones included (`AGENTS.md` §3).
- Exit codes: `0` clean stop, `1` transient, `2` config or terminal error ("No games selected", "None of your N saved games are in your library", no saved login, dead token). The systemd unit's `RestartPreventExitStatus=2` depends on these.
- Shutdown and crash always reach the exit: `Promise.all([grace, discord.send(...), statusPanel.stop()])`, then `stopBot()` capped at 1 s. Grace: 1500 ms on shutdown, 2000 ms on crash.
- 32-game cap (`MAX_IDLE_GAMES`) on every selection, including saved games missing from the library.
- Discord stays optional. No secret reaches a log, the console or Discord. No new dependency, no new network destination.
- Selection file: `~/.steam-idler/selection-<account>.json`, `{ "version": 1, "savedAt": "<ISO>", "games": [{ "appid": 730, "name": "…" }] }`. Unusable file → renamed to `selection-<account>.json.invalid`.
- Exact copy:
  - headless with no selection: `No games selected. Run steamidler interactively once to pick games.`
  - no saved game in the library: `None of your N saved games are in your library.`
  - missing games at start: `Saved but not in your library right now: <names>; kept, retried at the next start.`
  - first save failure: `⚠️ Could not save the game selection — a restart will forget recent changes`
  - `/status` footer: `Changes are saved and kept after a restart.`
- The split is behaviour-preserving. Code moves verbatim except where a module-level variable becomes a runtime field or a parameter. A fix found along the way is its own commit with its own test.
- Run tests with `npx pnpm@10.34.6 test` (Task 1 defines it). The suite is green after every task.

## Review Focus

1. **First start after the update on the VPS** (only a favorites file exists): the favorites become the selection, the selection file is written at once, and the next restart reads the selection file. Pinned in Task 10, `migrates favorites once and writes the selection file`.
2. **Unwritable config folder** (root-owned file after a `sudo` run): idling carries on; exactly one Discord warning per failure streak. Pinned in Task 9, `save failure warns once until a save succeeds`.
3. **Restart while a game is played elsewhere:** paused games are still saved and come back. Pinned in Task 9, `toSaved includes paused and missing games`.
4. **Family-shared games late at boot:** missing games survive any number of saves and rejoin when they reappear. Pinned in Task 9, `missing games survive apply and saves`, and Task 10, `missing games are kept when some match`.
5. **Quit while a resume login is in flight:** shutdown still exits, and a login that lands afterwards logs off instead of idling. Pinned in Task 5, `restoreIdling after shutdown logs out`.

---

### Task 1: Tests in the repo and a GitHub check

**Files:**
- Create: `test/*.test.mjs` (copied from `C:\Users\Nightingale\AppData\Local\Temp\claude\C--Mudrock-s-Headquarters-Project-Steam-Idle\3be5167a-d6de-4d8e-8484-7a79e18d9720\scratchpad\tests\`), `test/fake/discord.mjs`, `test/fake/hooks.mjs`, `test/fake/register.mjs`, `test/helpers.mjs`, `.github/workflows/ci.yml`
- Modify: `package.json` (scripts), `docs/development.md` (Commands, Offline test harness), `CLAUDE.md` §5

**Interfaces:**
- Produces: `test/helpers.mjs` exporting `dist(relPath: string): string`, the file URL of `dist/<relPath>`, resolved from `import.meta.url`, and `tempHome(): string`, which creates a temp dir with `.steam-idler/` inside, sets `HOME` and `USERPROFILE`, and returns the dir. Every test file imports compiled modules through `dist()`.
- Produces: the script `"test": "tsc && node --import ./test/fake/register.mjs --test --test-concurrency=1 --test-force-exit --test-timeout=20000 \"test/*.test.mjs\""`.

- [ ] **Step 1:** Copy the 13 test files and `fake/`. Replace each `process.env.STEAMIDLED_DIST` lookup with `dist('…')` from `test/helpers.mjs`, and each hand-rolled temp-home block with `tempHome()`. It must still run before the dynamic imports.
- [ ] **Step 2:** Add the `test` script. Run `npx pnpm@10.34.6 test`. Expected: `# pass 166`, `# fail 0`.
- [ ] **Step 3:** Write `.github/workflows/ci.yml`:
  - `name: CI`, `on: push: branches: [main, dev]` and `pull_request`;
  - `permissions: contents: read`;
  - one job `test` on `ubuntu-latest`;
  - steps:
    - `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2` with `persist-credentials: false`;
    - `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0` with `node-version: 22`;
    - `npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts`;
    - `npx pnpm@10.34.6 test`.
- [ ] **Step 4:** Docs:
  - `docs/development.md`: the "Offline test harness" section now describes `test/`, `test/helpers.mjs`, the fake loader, `pnpm test`, Node 22+ for running tests, and the CI workflow. Drop the scratchpad paragraph.
  - `CLAUDE.md` §5: "Offline tests live in `test/` and run with `npx pnpm@10.34.6 test`".
  - Add a `Run tests` row to the Commands table.
- [ ] **Step 5:** Run `npx pnpm@10.34.6 test`. Expected: 166 pass. Commit: `test: move the offline suite into the repo and run it on GitHub`.

### Task 2: Leave the Steam status alone

**Files:**
- Modify: `src/steam/client.ts` (constructor `loggedOn` listener, ~lines 58-67)
- Create: `test/fake/steam-user.mjs`, `test/fake/steam-session.mjs`, `test/client.test.mjs`
- Modify: `test/fake/hooks.mjs` (also map `steam-user` and `steam-session`)

**Interfaces:**
- Produces: `test/fake/steam-user.mjs`, a default-exported class extending `EventEmitter` with:
  - `setPersona(state)` recording into `this.personaCalls`;
  - `logOn()`, `logOff()`, `gamesPlayed(ids)` recording;
  - `steamID = null`, `EPersonaState = { Online: 1 }`, `EResult = {}`.
- Produces: `test/fake/steam-session.mjs` exporting `LoginSession` (with `renewRefreshToken() → false`), `EAuthTokenPlatformType` and `EAuthSessionGuardType`.

- [ ] **Step 1: Failing test** in `test/client.test.mjs`, `logon does not change the Steam status`. It constructs `SteamClient`, emits `loggedOn` on the underlying fake (`client.steamUser`), and asserts `client.steamUser.personaCalls.length === 0`.
- [ ] **Step 2:** Run `npx pnpm@10.34.6 test`. Expected: FAIL (`personaCalls.length` is 1).
- [ ] **Step 3:** Remove the `setPersona(SteamUser.EPersonaState.Online)` call. Rewrite the listener's comment to say the status is left to the owner's Steam app.
- [ ] **Step 4:** Run tests. Expected: all pass. Commit: `feat: stop forcing the Steam status to Online`.

### Task 3: Remove the randomizer

**Files:**
- Modify:
  - `src/types/index.ts`: `IdlingGame` loses `nextPauseAtMs` and `pauseUntil`; `GameSelectorResult` loses `exemptAppId`.
  - `src/selection.ts`
  - `src/index.ts`: delete `randomIdlePhaseMs`, `randomCooldownMs`, `tickRandomizer`, `pausingGames`, `exemptAppId` and every use.
  - `src/ui/display.ts`, `src/ui/gameSelector.ts` (`X` key, exempt)
  - `src/storage/favorites.ts`: delete `loadExempt` and `saveExempt`.
  - `src/discord/commands.ts`, `src/discord/statusEmbed.ts`, `src/notifications/dailyReport.ts`
  - `README.md`: features, `X` row, randomizer paragraph, `/status` row, status box sections, the started and daily-report rows.
- Modify tests: `test/selection.test.mjs`, `test/statusEmbed.test.mjs`, `test/statusPanel.test.mjs`, `test/commands.test.mjs`, `test/bot.test.mjs`
- Create: `test/dailyReport.test.mjs`

**Interfaces:**
- Produces: `IdlingGame = { appid: number; name: string; initialPlaytime: number; startTime: Date; accumulatedMs: number }`.
- Produces: `computeSelection(state: { idling: IdlingGame[]; paused: IdlingGame[] }, newSelection: GameSelection[], createGame: (s: GameSelection) => IdlingGame): { idling: IdlingGame[]; paused: IdlingGame[] }`.
- Produces: `SelectedState = 'idling' | 'paused'`; `SelectedGameView = { appid; name; state }`; `PanelGame = { name; state: 'idling' | 'paused'; totalMinutes; gainedMs }`; `formatDailyReport(idling, paused, dayStartAccumulatedMs, date, isFrozen?, nowMs?)`.

- [ ] **Step 1: Failing tests:**
  - `selection.test`: rewrite for the new signature (keeps kept games as the same objects; drops deselected from both arrays; creates new games through `createGame`).
  - `statusEmbed.test`: `no cooldown field and no ∞ mark`, with fields named only `🎮 Idling (n)` and `⏸️ Paused (n)`.
  - `commands.test`: `status has no cooldown or exempt lines`.
  - `dailyReport.test`: `report lists idling and paused only`, with no `Cooldown` and no `Exempt` text.
  - Delete the tests of removed behaviour (cooldown rows, exempt marks, exempt handling in `computeSelection`).
- [ ] **Step 2:** Run tests. Expected: FAIL in those files.
- [ ] **Step 3:** Remove the randomizer everywhere listed.
  - The 60 s display tick now repaints only on a TTY: `if (process.stdout.isTTY) renderStatus()`.
  - `releasePausedGames` moves every paused game back to idling.
  - `▶️ Idling started — N games` loses its exempt suffix.
  - Headless loses the exempt log line.
  - The picker loses the `Exempt:` line and the `X` key.
  - An `exemptAppId` left in an old favorites file is ignored.
- [ ] **Step 4:** Run tests. Expected: all pass. Commit: `feat: remove the randomizer and the exempt game`.

### Task 4: Split — timers, runtime and session

Code moves out of `index.ts`; behaviour is unchanged.

**Files:**
- Create: `src/timers.ts`, `src/runtime.ts`, `src/session.ts`, `test/timers.test.mjs`, `test/session.test.mjs`
- Modify: `src/index.ts`
- Delete or fold: `computeSelection` moves into `Session.apply`. `src/selection.ts` becomes `installSelection` (below); `test/selection.test.mjs` cases move to `session.test`.

**Interfaces (produced, used by every later task):**

```ts
// src/timers.ts — every timer in the app is registered here by name
export class Timers {
  timeout(name: string, fn: () => void, ms: number): void;   // clears a timer of the same name first
  interval(name: string, fn: () => void, ms: number): void;  // same
  clear(name: string): void;
  has(name: string): boolean;
  clearAll(): void;
}
// Names: 'display', 'resume', 'resumeNotify', 'pauseNotify', 'midnight', 'flush', 'zombie', 'takeoverDrift'

// src/session.ts — no Steam or Discord imports
export class Session {
  constructor(now?: () => Date);
  get idling(): readonly IdlingGame[];
  get paused(): readonly IdlingGame[];
  get blocked(): boolean;                       // was playingBlocked
  selection(): GameSelection[];                 // idling then paused (was getGameCurrentSelection)
  start(selection: GameSelection[], library: Map<number, SteamGame>, blocked: boolean): void;
  bank(now?: Date): void;                       // was bankElapsed(idlingGames)
  apply(selection: GameSelection[], library: Map<number, SteamGame>): number[]; // returns appids created
  setBlocked(blocked: boolean, playingApp: number, opts: { bank: boolean; restartClocks: boolean }): boolean; // false = no transition
  release(now?: Date): void;                    // paused → idling, blocked = false (restoreIdling)
  restartClocks(now?: Date): void;              // startTime = now for idling games
  gainedMs(game: IdlingGame, frozen: boolean, now?: Date): number;
}

// src/runtime.ts
export type SteamLike = Pick<SteamClient, 'isLoggedIn' | 'isConnected' | 'isConnecting' | 'isReconnecting'
  | 'isPlayingBlocked' | 'currentRefreshToken' | 'ownershipCacheComplete' | 'loginWithRefreshToken'
  | 'abortPendingConnect' | 'setGamesPlaying' | 'stopPlaying' | 'relog' | 'logout' | 'getOwnedGames'
  | 'getPlaytimeForever' | 'onDisconnected' | 'onLoggedOn' | 'onError' | 'onPlayingState' | 'onRefreshToken'>;
export type NotifierLike = Pick<DiscordNotifier, 'send' | 'botConfig' | 'isConfigured' | 'hasFile' | 'reload'>;
export interface Actions { render(): void; shutdown(exitCode?: number): void }
export interface Runtime {
  readonly client: SteamLike; readonly discord: NotifierLike; readonly session: Session;
  readonly timers: Timers; readonly isHeadless: boolean; exit(code: number): void;
  accountName: string; library: { games: SteamGame[]; byId: Map<number, SteamGame> };
  idlingStartedAt: Date | null;  // was startTime
  isIdling: boolean; isWaitingForResume: boolean; waitingReason: string; isInEditMode: boolean;
  isShuttingDown: boolean; stopNotified: boolean; selfInitiatedRelog: boolean;
  botHandle: BotHandle | null; statusPanel: StatusPanel | null;
  actions: Actions;              // filled in by the wiring in index.ts
}
export function createRuntime(deps: { client: SteamLike; discord: NotifierLike; isHeadless: boolean;
  exit?: (code: number) => void; now?: () => Date }): Runtime;   // exit defaults to process.exit
export function isFrozen(rt: Runtime): boolean;  // rt.isWaitingForResume || rt.session.blocked
```

`src/selection.ts` becomes `installSelection(rt: Runtime, forgetDayStart: (appids: number[]) => void, selection: GameSelection[]): void`. That is today's `installSelection`: `session.apply`, then forget the day-start of the games it created.

- [ ] **Step 1: Failing tests:**
  - `timers.test`:
    - `re-arming a name clears the old timer`;
    - `clearAll leaves nothing pending`, using `mock.timers`.
  - `session.test`:
    - `apply keeps kept games as the same objects`;
    - `apply drops deselected games from idling and paused`;
    - `apply returns created appids`;
    - `bank is idempotent`, as two banks at the same instant add the delta once;
    - `setBlocked moves the played game to paused and banks once`;
    - `setBlocked returns false without a transition`;
    - `release returns paused games and clears blocked`;
    - `gainedMs adds no live delta while frozen`.
- [ ] **Step 2:** Run tests. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the three modules. In `index.ts`:
  - replace the game arrays, `playingBlocked` and `bankElapsed` with `rt.session`;
  - replace the guard variables with `rt` fields;
  - route every `setTimeout`/`setInterval` that today has a module-level handle through `rt.timers`, under the names above.
  
  Call sites keep their conditions exactly. For example, `enterWaitingState` still banks only `if (!rt.session.blocked)`.
- [ ] **Step 4:** Run tests. Expected: all pass. Run `node dist/index.js --help`. Expected: the usage text. Commit: `refactor: move game state into Session and guards into Runtime`.

### Task 5: Split — resume and flush, with a fake Steam client

Code moves; behaviour is unchanged.

**Files:**
- Create: `src/steam/resume.ts`, `src/steam/flush.ts`, `test/fake/steamClient.mjs`, `test/fake/notifier.mjs`, `test/resume.test.mjs`, `test/flush.test.mjs`
- Modify: `src/index.ts`. The resume, flush and zombie constants move with their code.

**Interfaces:**

```ts
// src/steam/flush.ts — the 4-hour relog and the zombie check (moved verbatim)
export class Flush {
  constructor(rt: Runtime);
  start(): void;                     // arms 'flush' and 'zombie'
  forceRelog(): void;                // was forceFlushRelog
  runZombieCheck(): Promise<void>;
  resetBaseline(): void;             // on a block: zombieBaseline = null, zombieStrike = 0
  noteTakeover(): void;              // takeoverDriftPending = true when lastGoodPlaytime is known
  afterResume(): void;               // reports takeover drift if pending ('takeoverDrift' timer)
}
// src/steam/resume.ts — waiting, getting back, debounced notices (moved verbatim)
export interface DisplayLoop { start(): void; stop(): void }
export class Resume {
  constructor(rt: Runtime, flush: Flush, loop: DisplayLoop);
  enterWaiting(reason: string, isTakeover?: boolean): void;
  attemptResume(): Promise<void>;
  restoreIdling(): void;
  onLoggedOn(): void;                // the body of startIdling's onLoggedOn handler
}
```

- `test/fake/steamClient.mjs` exports `createFakeClient(over?)`, a `SteamLike` with:
  - settable flags;
  - recorded calls (`gamesPlayed`, `relogs`, `logouts`, `logins`);
  - `loginImpl` for `loginWithRefreshToken`;
  - stored handlers plus `emitDisconnected(eresult, msg)`, `emitLoggedOn()`, `emitError(err)` and `emitPlayingState(blocked, appid)`.
- `test/fake/notifier.mjs` exports `createFakeNotifier()`, with `sent: string[]` and `send()` resolving at once.

- [ ] **Step 1: Failing tests:**
  - `resume.test`, all with `mock.timers` (`setTimeout`, `setInterval`, `Date`):
    - `disconnect enters waiting and freezes clocks`;
    - `steam-user's own reconnect restores without a second logon`;
    - `terminal EResult 26 stops with exit 0 and a stop message`, and also clears credentials (`tempHome` with a credentials file);
    - `rate limit waits at least 10 minutes and gives up after 10`, with exit 1;
    - `transient errors give up after 30`, with exit 1;
    - `takeover retries after 5 minutes`;
    - `a blip inside 30 s sends no paused notice`;
    - `resumed notice waits 90 s and is cancelled by a new kick`;
    - `restoreIdling after shutdown logs out`.
  - `flush.test`:
    - `flush relog only when connected and idle`;
    - `two flat probes: relog, then zombie notice`;
    - `resetBaseline clears strikes`;
    - `unprobeable app is skipped next time`.
  - Shutdown is a stub in `rt.actions.shutdown` that records the exit code.
- [ ] **Step 2:** Run tests. Expected: FAIL (modules missing).
- [ ] **Step 3:** Move the code. `index.ts` builds `Flush` and `Resume` and registers their handlers where `startIdling` did.
- [ ] **Step 4:** Run tests. Expected: all pass. Commit: `refactor: move resume and flush out of index.ts, with offline tests`.

### Task 6: Split — status view, keyboard, control panel, daily report, shutdown

Code moves; behaviour is unchanged.

**Files:**
- Create: `src/ui/statusView.ts`, `src/ui/keyboard.ts`, `src/discord/controlPanel.ts`, `src/shutdown.ts`, `test/controlPanel.test.mjs`, `test/shutdown.test.mjs`
- Modify: `src/notifications/dailyReport.ts` (gains the scheduling), `src/index.ts`

**Interfaces:**

```ts
// src/ui/statusView.ts
export class StatusView implements DisplayLoop {
  constructor(rt: Runtime);
  render(): void;          // showIdlingStatus + statusPanel?.nudge()
  start(): void;           // 'display' interval, 60 s
  stop(): void;
}
// src/notifications/dailyReport.ts (formatter unchanged)
export class DailyReport {
  constructor(rt: Runtime);
  start(): void;                         // snapshot + 'midnight' timer
  snapshotDayStart(): void;
  forget(appids: number[]): void;
}
// src/ui/keyboard.ts
export function setupKeyboardInput(rt: Runtime, editMode: () => Promise<void>): void;
export function createEditMode(rt: Runtime, view: StatusView, report: DailyReport): () => Promise<void>;
// src/discord/controlPanel.ts
export function createControlPanel(rt: Runtime, report: DailyReport): ControlPanel;
export function statusSnapshot(rt: Runtime): StatusSnapshot;
// src/shutdown.ts
export function createShutdown(rt: Runtime): {
  handleShutdown(exitCode?: number): void;
  handleCrash(err: unknown): void;
  handleRejection(reason: unknown): void;
};
```

`handleShutdown` and `handleCrash` start with `rt.timers.clearAll()` in place of the per-handle clears.

- [ ] **Step 1: Failing tests:**
  - `controlPanel.test`:
    - `busyReason mirrors the guards`, with each guard's text;
    - `add ignores unknown, duplicate and the 33rd game`;
    - `remove re-sends gamesPlayed unless waiting`;
    - `statusSnapshot: waiting wins over blocked`.
  - `shutdown.test`, all with `mock.timers`:
    - `shutdown clears every timer and exits after 1500 ms`;
    - `shutdown waits for a slow Discord send, then a stuck bot destroy is capped at 1 s` (send resolves after 8000 ms, `destroy` never settles; exit is called after 9000 ms);
    - `crash exits 1 after 2000 ms with the message redacted`;
    - `crash before idling says it crashed before idling started`;
    - `a discord.js library rejection is ignored`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Move the code. `rt.actions.render` is `view.render`, `rt.actions.shutdown` is `handleShutdown`.
- [ ] **Step 4:** Run tests. Expected: all pass. Commit: `refactor: move the view, keyboard, control panel, report and shutdown out of index.ts`.

### Task 7: Split — start, cli and the wiring

Code moves; behaviour is unchanged.

**Files:**
- Create: `src/start.ts`, `src/cli.ts`, `test/start.test.mjs`
- Modify: `src/index.ts`, which ends as wiring only. `docs/architecture.md` gets the new module table. `AGENTS.md` §4 names `src/shutdown.ts` for the shutdown invariant, and §5 points the state model to `src/session.ts` and says which module owns each guard.

**Interfaces:**

```ts
// src/start.ts
export interface App { rt: Runtime; view: StatusView; report: DailyReport; flush: Flush; resume: Resume;
  shutdown: ReturnType<typeof createShutdown>; editMode: () => Promise<void> }
export function runHeadless(app: App): Promise<void>;
export function runInteractive(app: App): Promise<void>;
export function startIdling(app: App, games: GameSelection[]): void;  // registers handlePlayingState too
// src/cli.ts
export function parseArgs(argv: string[]): { headless: boolean; setupDiscord: boolean; logout: boolean;
  help: boolean; version: boolean; unknown: string[] };
export function main(app: App, argv: string[]): Promise<void>;
```

- [ ] **Step 1: Failing tests:**
  - `start.test`, with the fake client and `tempHome`:
    - `headless without a stored login exits 2`;
    - `headless with a dead token exits 2, a network error exits 1`;
    - `headless rate-limited login waits instead of exiting`;
    - `headless with no favorites exits 2`;
    - `headless with incomplete license data and no match exits 1`;
    - `startIdling sends Idling started and enters waiting when the client is already disconnected`.
  - `cli.test` (in `start.test`): `unknown flags are listed`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Move the code. `index.ts` keeps the shebang, builds `SteamClient`, `DiscordNotifier`, `createRuntime` and the modules, fills `rt.actions`, registers the signal and process handlers, and calls `main`.
- [ ] **Step 4:** Run tests and `node dist/index.js --help` and `--version`. Expected: all pass, same output as before. Check `wc -l src/index.ts`; expected under 120 lines. Commit: `refactor: finish splitting index.ts into modules`.

### Task 8: Selection file storage

**Files:**
- Create: `src/storage/selection.ts`, `test/selectionStore.test.mjs`
- Modify: `src/storage/favorites.ts`, which becomes `loadFavorites` only (read-only, used by the migration).

**Interfaces:**

```ts
export const SELECTION_VERSION = 1;
export function selectionPath(accountName: string): string;   // ~/.steam-idler/selection-<account>.json
export interface LoadedSelection { games: GameSelection[]; source: 'saved' | 'favorites' }
// null = neither file usable; each salvage step logs one line through `log` (default console.log)
export function loadSelection(accountName: string, log?: (line: string) => void): LoadedSelection | null;
export function saveSelection(accountName: string, games: GameSelection[]): boolean;  // never throws
```

- [ ] **Step 1: Failing tests** (`tempHome`):
  - `round trip keeps order and names`;
  - `missing file falls back to favorites`, where names are `App <id>` and the exempt field is ignored;
  - `no files → null`;
  - `unparsable JSON is renamed to .invalid and falls back`, also when an older `.invalid` exists;
  - `unknown version is renamed to .invalid`;
  - `bad entries dropped with a line each, rest kept`, for appid `0`, `-1`, `1.5` and `"730"`, and a duplicate where the first wins;
  - `more than 32 keeps the first 32`;
  - `empty games list loads as saved with no games`;
  - `save into a read-only folder returns false and logs the path`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement, writing with `writeFileAtomic`. A rename failure is logged and loading carries on.
- [ ] **Step 4:** Run tests. Expected: all pass. Commit: `feat: store the game selection in a validated file`.

### Task 9: Saved selection — session, Discord and the save action

**Files:**
- Modify:
  - `src/session.ts`: missing games;
  - `src/runtime.ts`: `Actions.saveSelection`;
  - `src/discord/controlPanel.ts`, `src/discord/commands.ts`;
  - `src/selection.ts` (`installSelection` saves);
  - `src/ui/keyboard.ts`: the edit apply saves through `installSelection`.
- Tests: `test/session.test.mjs`, `test/controlPanel.test.mjs`, `test/commands.test.mjs`

**Interfaces:**
- `Session` gains:
  - `get missing(): readonly GameSelection[]`;
  - `toSaved(): GameSelection[]`, covering idling, then paused, then missing.
  
  `start` and `apply` put library misses into `missing`. `apply` keeps a missing game that is still selected and drops one that is not. `selection()` now includes missing games, so every 32-cap check counts them.
- `SelectedState = 'idling' | 'paused' | 'missing'`. The status box and the terminal table never show `missing`.
- `Actions.saveSelection(): void` calls `saveSelection(rt.accountName, rt.session.toSaved())`. On failure it sends the save-failure notice from the Global Constraints, once per failure streak; a success resets it.
- `rt.saveFailureNotified: boolean` is added to `Runtime`.

- [ ] **Step 1: Failing tests:**
  - `session.test`:
    - `missing games survive apply and saves`;
    - `toSaved includes paused and missing games`;
    - `deselecting a missing game drops it`.
  - `controlPanel.test`:
    - `add and remove save the selection`;
    - `save failure warns once until a save succeeds`;
    - `cap counts missing games`;
    - `remove accepts a missing game`.
  - `commands.test`:
    - `status lists missing games under Not in library`;
    - `status footer says changes are saved`;
    - `add and remove replies no longer say until restart`;
    - `removing the last game in the library is refused, a missing one is allowed`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The replies become `▶️ Now idling <name>.` and `⏹️ Stopped idling <name>.`. The status section title is `Not in library — kept, retried at the next start`.
- [ ] **Step 4:** Run tests. Expected: all pass. Commit: `feat: save the selection on every change and keep missing games`.

### Task 10: Saved selection — start-up and the picker

**Files:**
- Modify:
  - `src/start.ts`: headless and interactive read the selection; migration saves once;
  - `src/ui/gameSelector.ts`: no favorites; a fixed "Selected" group; "not in library" rows;
  - `src/cli.ts`: help text;
  - `src/steam/auth.ts`: the comment about the favorites file names the selection file.
- Tests: `test/start.test.mjs`, `test/gameSelector.test.mjs` (new; drives `selectGames` with emitted keypress events on a fake TTY stdin)

**Interfaces:**
- `selectGames(games: SteamGame[], selected: GameSelection[], isEditMode: boolean): Promise<{ selectedGames: GameSelection[]; aborted?: boolean }>`. Entries of `selected` that are not in `games` are rows marked `not in library`, ticked, in the Selected group.
- Help text:
  - `steamidler --headless        Headless mode: auto-login and idle your saved selection`
  - `Config lives in ~/.steam-idler/ (credentials, selection, discord).`

- [ ] **Step 1: Failing tests:**
  - `start.test`, each replacing the Task 7 favorites test:
    - `headless with no selection exits 2 with the exact message`;
    - `migrates favorites once and writes the selection file`;
    - `missing games are kept when some match`, which also checks the console line from the Global Constraints;
    - `no saved game in the library: exit 2 with complete license data, exit 1 without`;
    - `interactive start saves what the picker returns`.
  - `gameSelector.test`:
    - `opens with the saved selection ticked and first`;
    - `ticking does not reorder`;
    - `F, S and X do nothing`;
    - `Enter with nothing ticked shows the hint`;
    - `Esc in edit mode returns the selection it opened with`;
    - `a missing game can be unticked and is not returned`;
    - `the 33rd tick is refused, counting missing games`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - The Enter hint becomes `Nothing selected — Space toggles a game`.
  - The help lines drop `F: Favorite`, `X: Exempt`, `S: Start all favorites` and `S: Idle all favorites`, and the edit-mode line becomes `Enter: Apply | Esc: Back (keep selection)`.
  - The counter line drops `Favorites: n`.
  - Delete `saveFavorites`.
- [ ] **Step 4:** Run tests and `node dist/index.js --help`. Expected: all pass, the new help text. Commit: `feat: start from the saved selection and drop favorites`.

### Task 11: Docs, audit addendum and live checklist

**Files:**
- Modify:
  - `README.md`:
    - keys table;
    - headless paragraph;
    - Discord "Changes are saved and kept after a restart";
    - config tree, with `selection-<account>.json` replacing the favorites row and a note that an old favorites file is read once;
    - exit-code 2 text;
    - VPS setup step 4: pick games with Space, then Enter.
  - `docs/runbook.md`: restart note; the exit-2 rows for "No games selected" and "None of your N saved games…".
  - `docs/live-tests.md`: new "Saved selection" checklist (below).
  - `docs/status.md`, `docs/steam-error-codes.md` (startup failure row), `SECURITY.md` (the `/add` line).
  - `AGENTS.md` §1: the bot line; §4: "`/add` and `/remove` change the saved selection", and the "no favorites" exit-code mention.
  - `SECURITY-AUDIT.md`: new `## 18. Addendum — Saved selection, split index.ts, no forced status (2026-10-25)`, covering the new file (no secrets, validation, `.invalid` rename), §6.1 resolved (no `setPersona`), the CI workflow (pinned SHAs, `contents: read`, no secrets, `--ignore-scripts`), and validation results.

- [ ] **Step 1:** Write the live checklist:
  1. Update the VPS to this build; with the old favorites file present, the service starts and idles them, and `selection-<account>.json` appears.
  2. `/add` a game, restart the service: the game is still idling.
  3. Your Steam status set in the app stays as you set it after a 4-hour relog.
  4. Hours on the Steam profile keep rising for 3+ hours, across one relog.
  5. Edit the selection file to invalid JSON, restart: a `.invalid` file appears, the service falls back (favorites or exit 2 with the message).
  6. Ctrl+C in interactive mode exits within a few seconds; the status box turns red.
- [ ] **Step 2:** Update the docs listed. Grep `src`, `README.md`, `docs` and `AGENTS.md` for `favorite`, `exempt`, `cooldown`, `randomizer` and `setPersona`. Expected: only the migration code, its tests, `CHANGELOG.md`, older specs and plans, and the audit's history sections remain.
- [ ] **Step 3:** Run the build and tests, and check CRLF on every touched file. Expected: all pass. Commit: `docs: document the saved selection and the split`.
