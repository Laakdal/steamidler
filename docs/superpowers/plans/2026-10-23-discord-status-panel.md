# Discord Live Status Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one live, self-updating rich-embed status message in a dedicated Discord channel, edited every 60 s and on state changes, turning red on shutdown.

**Architecture:** The embed is built by a pure function in `src/discord/statusEmbed.ts`. A `StatusPanel` class in `src/discord/statusPanel.ts` owns the timers and the REST calls (bot token through `fetch`, as the notifier does), and remembers the message in `~/.steam-idler/discord-status.json` (`src/discord/statusStore.ts`). `index.ts` supplies a state snapshot, starts the panel in `startIdling`, nudges it from `renderStatus`, and awaits `panel.stop()` in both exit paths.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 18.17 (VPS runs 20.20; `AbortSignal.any` is available), built-in `fetch`, Discord REST v10, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-discord-status-panel-design.md`

## Global Constraints

- `AGENTS.md` and `CLAUDE.md` apply in full. Relative imports end in `.js`; every function gets a short `//` why-comment; files are CRLF; conventional commits.
- **Discord stays optional.** Nothing in the panel throws out of a public method or rejects. `stop()` resolves within **4 s** even if `fetch` hangs.
- **Timing:** request timeout **4 s**, refresh interval **60 s**, edits at least **5 s** apart, at most one request in flight.
- **Posts** carry `nonce` (≤ 25 chars) with `enforce_nonce: true`. The nonce is reused for retries of the same post until one succeeds.
- **Panel messages** send `allowed_mentions: { parse: [] }`, no `content`, and never the `SUPPRESS_EMBEDS` flag. No URL and no icon anywhere in the embed.
- **Limits:** title ≤ 256, description ≤ 4096, field value ≤ 1024, ≤ 25 fields, total ≤ 6000.
- **Invite permissions:** `19456` (View Channel + Send Messages + Embed Links).
- **Logs:** `redactSecrets(err.message, [token])` only, never a response body. One line per change of failure kind, not one per tick.
- **Tests:** throwaway `node:test` files in the session scratchpad `tests/` folder, importing `dist/` through `process.env.STEAMIDLED_DIST`. Use the temp-`HOME` and `.steam-idler/` setup before the dynamic import, as in the existing `setup.test.mjs`. Run with `node --test --test-concurrency=1`, with `STEAMIDLED_DIST="C:/Mudrock's Headquarters/Project/Steam Idle/dist"`. Build first: `npx pnpm@10.34.6 build`.
- **Deviation from the spec (planner's call):** the spec says a field passing 1024 chars "ends with …and N more". With 32 idling games one field cannot hold all rows, so a section instead continues into further fields, each named `\u200b`. "…and N more" stays as the last resort if the whole embed would pass 6000.

## Review Focus

1. **The panel message is deleted while running.** Expect one new post and no duplicate on the next tick, even when the first post timed out (Task 3: `repost on 404 uses nonce and stores new id`).
2. **The bot lacks Embed Links.** Expect a single log line naming the fix and no log spam on later ticks, whether Discord answers 403 or returns empty `embeds` (Task 3: `missing embed links logs once`).
3. **Hand-edited `discord-status.json`** (non-snowflake IDs, `../` in an ID, wrong types, not JSON). Expect it to be ignored and a fresh post made (Task 1: `tampered status file is ignored`).
4. **Shutdown while a request hangs.** Expect `stop()` to abort it, attempt the red edit, and resolve in ≤ 4.5 s (Task 3: `stop resolves within cap when fetch hangs`).
5. **Hostile game names:** triple backticks, `@everyone`, `**bold**`, a URL, a 300-char name, or 32 such games. Expect no broken code block, no ping, every value within limits (Task 2: `hostile names stay inside limits`).

---

### Task 1: Config field and status file

**Files:**
- Modify: `src/discord/config.ts` (BotConfig, `loadDiscordConfig`, `saveDiscordConfig`)
- Create: `src/discord/statusStore.ts`
- Test: `<scratchpad>/tests/statusStore.test.mjs`, and extend a copy of `config.test.mjs`

**Interfaces:**
- Produces:
  - `BotConfig.statusChannelId: string | null`. Optional in the file as `statusChannelId`; a present but non-snowflake value makes the file invalid (the same `invalid('bot settings are incomplete or malformed')` path). It is not counted in `botKeys`.
  - `STATUS_PATH: string` (`~/.steam-idler/discord-status.json`)
  - `interface StatusMessageRef { channelId: string; messageId: string }`
  - `loadStatusMessage(): StatusMessageRef | null`: null on missing, unreadable, non-object or non-snowflake data; never throws, logs nothing for a missing file.
  - `saveStatusMessage(ref: StatusMessageRef): boolean`: `writeFileAtomic(…, 0o600)`; on error, `console.error` the path and message and return false.

- [ ] **Step 1: Write failing tests:** `statusChannelId round-trips through save/load`; `missing statusChannelId loads as null`; `malformed statusChannelId invalidates the file`; `status file round-trips`; `tampered status file is ignored`, covering `{"channelId":"../x","messageId":"1"}`, numbers instead of strings, `[]`, `not json` and a missing file, all returning `null`.
- [ ] **Step 2: Build and run them.** Expect FAIL (`saveStatusMessage` is not exported, and `statusChannelId` is missing).
- [ ] **Step 3: Implement.** Reuse `isSnowflake` and the config dir helper. Update existing `BotConfig` literals (`setup.ts`) so the build passes, with `statusChannelId: null` for now.
- [ ] **Step 4: Build and run the new tests plus the old `config.test.mjs`.** Expect all PASS.
- [ ] **Step 5: Commit** `feat: store the status channel and panel message id`

### Task 2: REST helpers and embed builder

**Files:**
- Modify: `src/discord/rest.ts`
- Create: `src/discord/statusEmbed.ts`
- Test: `<scratchpad>/tests/statusEmbed.test.mjs`, `<scratchpad>/tests/rest-status.test.mjs`

**Interfaces:**
- Produces, in `rest.ts`:
  - `discordApi` method union gains `'PATCH'`, plus an optional last parameter `signal?: AbortSignal`, combined with the timeout through `AbortSignal.any`.
  - `postEmbedMessage(token: string, channelId: string, embed: Embed, nonce: string, timeoutMs: number, signal?: AbortSignal): Promise<Response>`, which sends `{ embeds: [embed], allowed_mentions: { parse: [] }, nonce, enforce_nonce: true }`.
  - `editEmbedMessage(token: string, channelId: string, messageId: string, embed: Embed, timeoutMs: number, signal?: AbortSignal): Promise<Response>`, which sends `{ embeds: [embed], allowed_mentions: { parse: [] } }` with PATCH to `/channels/{c}/messages/{m}`.
- Produces, in `statusEmbed.ts`:
  - `type PanelState = 'starting' | 'idling' | 'waiting' | 'blocked' | 'stopped'`
  - `interface PanelGame { name: string; state: 'idling' | 'cooldown' | 'paused'; exempt: boolean; totalMinutes: number; gainedMs: number; cooldownEndsAt: Date | null }`
  - `interface StatusSnapshot { state: PanelState; waitingReason: string | null; games: PanelGame[] }`
  - `interface Embed { title: string; description: string; color: number; fields: { name: string; value: string }[]; footer: { text: string }; timestamp: string }`
  - `buildStatusEmbed(snap: StatusSnapshot, now: Date, nextUpdateAt: Date | null, version: string): Embed`

**Pinned content:**
- Title `Steam Idler`.
- Colours: idling `0x57F287`, waiting/blocked `0xFEE75C`, stopped `0xED4245`, starting `0x99AAB5`.
- Description, by state:
  - idling: `🟢 Idling N game(s)`
  - waiting: `🟡 Waiting to resume — <escapeMarkdown(reason)>`
  - blocked: `🟡 Paused — a game is being played on this account elsewhere`
  - stopped: `🛑 Stopped`
  - starting: `⏳ Waiting for idling to start`
  - Then, when `nextUpdateAt` is not null and the state isn't stopped, a second line `Next update <t:SECONDS:R>`.
- Fields, only for non-empty sections:
  - `🎮 Idling (n)`: rows `name  total  +gained`
  - `❄️ Cooldown (n)`: rows `name  <left> left`
  - `⏸️ Paused (n)`: rows `name  total`
  - Each value is a code block (three backticks, newline, rows, newline, three backticks).
- Rows:
  - The name is clipped to 24 chars with `…`, gets ` ∞` when exempt, and has every backtick replaced with `ˋ` (U+02CB).
  - Total is `toLocaleString('en-US')` hours + `h`.
  - Gained is `+Xh MMm` or `+Mm`.
  - Time left is `Dd Hh` when ≥ 24 h, else `Hh MMm` or `Mm`. Negative counts as 0.
- Footer `steamidler v<version>`; `timestamp` is `now.toISOString()`.
- A section that passes 1024 chars continues in more fields named `\u200b` (see Global Constraints).

- [ ] **Step 1: Write failing tests:**
  - `idling snapshot renders state, countdown and rows`: description contains `<t:${Math.floor(next/1000)}:R>`, colour 0x57F287, field name `🎮 Idling (2)`, and the value starts and ends with three backticks.
  - `stopped has red colour and no countdown`
  - `waiting wins and escapes the reason`
  - `empty sections are omitted`
  - `cooldown over a day shows days`
  - `hostile names stay inside limits`: 32 games named `` ```@everyone **x** https://e.x/`` `` padded to 300 chars. Every field value ≤ 1024 and contains exactly two code fences, the title, description and footer total is ≤ 6000 together with all fields, and no value contains `http`.
  - `post body has nonce, enforce_nonce, no flags, mentions off` (mocked `fetch`)
  - `edit uses PATCH on the message path`
  - `signal abort cancels the request`
- [ ] **Step 2: Build and run.** Expect FAIL.
- [ ] **Step 3: Implement** both files. Reuse `escapeMarkdown` from `format.ts`. Write the duration helpers once in `statusEmbed.ts`; don't import from `index.ts`.
- [ ] **Step 4: Build and run.** Expect all PASS. The older `rest.test.mjs` must also pass.
- [ ] **Step 5: Commit** `feat: build the status embed and add message edit calls`

### Task 3: StatusPanel

**Files:**
- Create: `src/discord/statusPanel.ts`
- Test: `<scratchpad>/tests/statusPanel.test.mjs`

**Interfaces:**
- Consumes: Task 1's store functions and `BotConfig`; Task 2's `postEmbedMessage`, `editEmbedMessage`, `buildStatusEmbed`, `StatusSnapshot`, `Embed`.
- Produces:
  - `type PublishResult = { ok: true; messageId: string; embedShown: boolean } | { ok: false; status: number | undefined }`
  - `publishStatus(token: string, channelId: string, stored: StatusMessageRef | null, embed: Embed, nonce: string, timeoutMs: number, signal?: AbortSignal): Promise<PublishResult>`. It edits `stored` when its `channelId` matches, and posts when there's no match or the edit returned 404. It never throws: network errors and timeouts give `{ ok: false, status: undefined }`. `embedShown` is `Array.isArray(body.embeds) && body.embeds.length > 0`.
  - `interface StatusPanelOptions { version: string; timeoutMs?: number; intervalMs?: number; minGapMs?: number; stopCapMs?: number }`, with defaults 4000 / 60000 / 5000 / 4000.
  - `class StatusPanel`:
    - `constructor(bot: BotConfig & { statusChannelId: string }, snapshot: () => StatusSnapshot, options: StatusPanelOptions)`
    - `start(): void`: publish now, then every `intervalMs`.
    - `nudge(): void`: coalesced; publishes no sooner than `minGapMs` after the last request started.
    - `stop(): Promise<void>`: clears timers, aborts in flight, publishes once with `state: 'stopped'` and `nextUpdateAt: null`. Resolves ≤ `stopCapMs` + 500 ms and never rejects. Calling it twice is harmless.

**Behaviour:**
- Reads the stored ref once at construction (`loadStatusMessage()`), saves after every successful post that changed the ID, and keeps the current nonce until a post succeeds.
- Handles each response:

  | Response | Action |
  |---|---|
  | 401 | disabled for the run (no more requests, no log beyond one line) |
  | 403 | log once "no permission to post in the status channel: give the bot View Channel, Send Messages and Embed Links there" |
  | 404 from a post | log once "status channel not found: run --setup-discord" |
  | 429, 5xx, network error | silent skip |
  | `embedShown === false` | log once "Discord hid the status box: give the bot Embed Links in the status channel" |

- A tick that fires while a request is in flight is skipped.

- [ ] **Step 1: Write failing tests,** with `fetch` mocked and small `intervalMs` and `minGapMs` values:
  - `first publish posts and stores the id`
  - `next publish edits the stored message`
  - `repost on 404 uses nonce and stores new id`: an edit gets 404, the post times out, and the retry reuses the same nonce
  - `401 disables further requests`
  - `missing embed links logs once`: an empty `embeds` result over three ticks gives one log line; a 403 likewise
  - `ticks are skipped while a request is in flight`
  - `nudges are coalesced to minGap`
  - `stop resolves within cap when fetch hangs`: a mock that rejects on `init.signal` abort; `stop()` resolves in < 4.5 s, and the last request body has the red colour
  - `stop is idempotent and never rejects`
  - `no token or url in logs`: a fetch error whose message contains the token and a URL; the logs contain neither
- [ ] **Step 2: Build and run.** Expect FAIL.
- [ ] **Step 3: Implement** `statusPanel.ts`.
- [ ] **Step 4: Build and run.** Expect all PASS.
- [ ] **Step 5: Commit** `feat: keep a live status message up to date`

### Task 4: Setup asks for the status channel

**Files:**
- Modify: `src/discord/setup.ts` (`inviteUrl`, `finishSetup`, `runDiscordSetup`)
- Test: `<scratchpad>/tests/setup-status.test.mjs`. Update the copied `setup.test.mjs` only where it asserts `permissions=3072`.

**Interfaces:**
- Consumes: Task 3's `publishStatus`; Task 2's `buildStatusEmbed` with `state: 'starting'`; Task 1's store.
- Produces: `finishSetup(bot: BotConfig, webhookUrl: string | null, version: string): Promise<void>`. When `bot.statusChannelId` is set, it runs after the command registration and before saving: `publishStatus` with the stored ref. `!ok` throws `DiscordApiError(status ?? 0, 'Discord rejected the status box: HTTP <status>')`. `embedShown === false` throws `Error('Discord hid the status box: give the bot Embed Links in that channel, then run --setup-discord again')`. After a successful `saveDiscordConfig`, it calls `saveStatusMessage`; a false return there only warns.

**Setup flow:**
- The invite line reads "(View Channel, Send Messages and Embed Links)".
- After the notification channel, `select({ message: 'Live status channel:', choices: [{ name: 'None', value: null }, ...channels] })`.
- The success message mentions the status box when one was set.
- `index.ts` passes its version to `runDiscordSetup` → `finishSetup`.

- [ ] **Step 1: Write failing tests:**
  - `invite asks for 19456`
  - `no status channel: no embed request`
  - `status channel: placeholder posted and id saved`
  - `rerun edits the stored placeholder instead of posting`
  - `empty embeds aborts setup and saves nothing`
  - `403 on placeholder aborts setup and saves nothing`
- [ ] **Step 2: Build and run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Build and run the new and old setup tests.** Expect all PASS.
- [ ] **Step 5: Commit** `feat: pick a live status channel during discord setup`

### Task 5: Wire into the idler, and docs

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`, `AGENTS.md`, `SECURITY-AUDIT.md`
- Test: build, the full scratchpad suite, plus the scripted check below

**Interfaces:**
- Consumes: Task 3's `StatusPanel`; Task 2's `StatusSnapshot`.

**Changes to `index.ts`:**
- A module-level `let statusPanel: StatusPanel | null = null`.
- `function statusSnapshot(): StatusSnapshot`:
  - `state`: `isShuttingDown` → `'stopped'`, `isWaitingForResume` → `'waiting'`, `playingBlocked` → `'blocked'`, else `'idling'`.
  - `gainedMs`: `accumulatedMs + (state idling && !isFrozen() ? now − startTime : 0)`.
  - `totalMinutes`: `initialPlaytime + floor(gainedMs / 60000)`.
  - `exempt`: `nextPauseAtMs === null`; `cooldownEndsAt`: `pauseUntil` for cooldown games.
- `startIdling`, right after `startBot`: when `botConfig?.statusChannelId`, create the panel with `{ version: packageVersion() }` and `start()`.
- `renderStatus()` ends with `statusPanel?.nudge()`.
- `handleShutdown` and `handleCrash`: `const panelStopped = statusPanel ? statusPanel.stop() : Promise.resolve();`, added to the existing `Promise.all([grace, finalMessage, panelStopped])`.

**Docs:**
- `README.md`: the Discord setup step names the status channel and Embed Links; a "Live status box" subsection says what it shows, that it is edited in place every minute, how to turn it on (rerun `--setup-discord`), and the new `discord-status.json` in the Configuration tree.
- `AGENTS.md` §2 layout: the three new files. §4: the panel joins the shutdown `Promise.all` and never rejects, 4 s cap.
- `SECURITY-AUDIT.md` §17 dated addendum: the Embed Links permission, the PATCH endpoint (same host), the non-secret status file and its validation, the no-URL/no-icon rule, nonce dedupe, and failure isolation.

- [ ] **Step 1: Implement the `index.ts` changes.**
- [ ] **Step 2: Build.** Expect exit 0.
- [ ] **Step 3: Run the whole scratchpad suite** (`bot.test.mjs` with `--import ./fake/register.mjs`). Expect all PASS.
- [ ] **Step 4: Scripted check.** `grep` that every `process.exit` in `handleShutdown`/`handleCrash` comes after an `await` that includes `panelStopped`, and that `statusPanel` is only assigned in `startIdling`.
- [ ] **Step 5: Write the docs;** convert any LF file to CRLF; read `git diff main` end to end.
- [ ] **Step 6: Commit** `feat: show a live status box in discord` and `docs: document the live status box`.
- [ ] **Step 7: Independent review.** A fresh subagent gets the branch diff and `AGENTS.md`. Fix or answer each finding.
- [ ] **Step 8: Hand the owner the live checklist:**
  1. rerun setup and pick a status channel;
  2. the box appears grey, then turns green with a countdown once idling starts;
  3. `/add` changes it within ~5 s;
  4. a `systemctl restart` reuses the same message;
  5. deleting the message brings a new one within a minute;
  6. `systemctl stop` turns it red.
