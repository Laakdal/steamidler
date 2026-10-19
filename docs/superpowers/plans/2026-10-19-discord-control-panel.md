# Discord Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated Discord bot that lets the owner `/add`, `/remove` and `/status` the running idle set, posts the existing notifications, and falls back to an optional webhook (with an offline/online notice) when the bot dies.

**Architecture:** Discord code moves into `src/discord/`, split into small modules: pure logic (config validation, formatting, command handling, gateway health, selection diff) that tests import from `dist/`, and thin glue (discord.js client, inquirer prompts, `index.ts` wiring) that `tsc` and the user's live checklist cover. Notifications and setup use Discord's REST API through `fetch`, so they are testable with a mocked `fetch`; discord.js is used only for the Gateway connection and interaction replies.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node 22, `discord.js` 14.27.0 (exact pin), `@inquirer/prompts`, `node:test` for throwaway tests.

**Spec:** `docs/superpowers/specs/2026-10-19-discord-control-panel-design.md` (approved 2026-10-19). Read it and `AGENTS.md` before starting any task.

## Global Constraints

- Project rules in `AGENTS.md` and `CLAUDE.md` apply to every task (CRLF via Edit/Write only, `.js` import suffixes, one `//` why-comment per function, config writes never throw).
- Build: `npx pnpm@10.34.6 build` from the repo root. Install only with `npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts`.
- `discord.js` pinned exactly as `"discord.js": "14.27.0"` (no caret). No other new dependency.
- Never log, print, or put in an error message: the bot token, the webhook URL, the Steam token, or a raw Discord response body.
- Every outgoing Discord message: `escapeMarkdown`, `allowed_mentions: { parse: [] }`, `flags: 4` (suppress embeds); notifications split at 2000 characters. Interaction replies are ephemeral (flag 64) with `allowedMentions: { parse: [] }`.
- Gateway intents: `GatewayIntentBits.Guilds` only. No privileged intents.
- `send()` never rejects. Per message part: bot attempt ≤ 4000 ms, webhook attempt ≤ 4000 ms (8 s total).
- Bot counts as down after **120 000 ms** of failed Gateway reconnects, immediately on close codes 4004/4010/4011/4012/4013/4014, on REST 401 (fatal), and on REST 403/404 when posting.
- `/add` and `/remove` never write favorites. Reply copy says "until steamidled restarts".
- Autocomplete: at most 25 choices, names truncated to 100 characters, value = appid as a decimal string.
- Discord REST base: `https://discord.com/api/v10`. Invite permissions `3072` (View Channel + Send Messages), scopes `bot applications.commands`.
- Do not run the app against the real Steam account or contact Discord with real credentials. Live testing is the user's checklist in Task 9.
- **Commits:** the user decides at handoff. If commits are off, each "Commit" step becomes "run `git diff --stat` and review the task's diff"; never commit without that approval.

**Test harness (all tasks):** tests are throwaway `node:test` files kept outside the repo (per `CLAUDE.md`), in
`T=C:/Users/Nightingale/AppData/Local/Temp/claude/C--Mudrock-s-Headquarters-Project-Steam-Idle/4f2ad399-9126-48a8-97b5-e531d24dc42e/scratchpad/tests`.
Each test file:
- creates a fresh temp home with `fs.mkdtempSync`, sets `process.env.HOME` and `process.env.USERPROFILE` to it, and creates `.steam-idler/` inside **before** any dynamic import (config paths are computed at import time);
- imports compiled modules with `await import(pathToFileURL(join(process.env.STEAMIDLED_DIST, 'discord/config.js')).href)`;
- mocks the network by assigning `globalThis.fetch`; a mock that simulates a hang must reject when `init.signal` aborts.

Run (Git Bash): `cd "/c/Mudrock's Headquarters/Project/Steam Idle" && npx pnpm@10.34.6 build && STEAMIDLED_DIST="C:/Mudrock's Headquarters/Project/Steam Idle/dist" node --test "$T"/<file>.test.mjs`

## Deviations from the spec (planner's calls)

- **Bot connects when idling starts** (end of `startIdling`), not right after the library loads. This is what makes "only a process that has started idling answers commands" true without extra state, and keeps `--setup-discord` and a not-yet-started interactive session off the Gateway. The `startTime === null` guard stays as a defensive check.
- **Webhook-only config files do not re-trigger the first-run prompt.** Declining that prompt writes `{ "disabled": true }`, which would erase the saved webhook. Instead a one-line console notice points to `--setup-discord` (Task 5).
- **"Owner is not an admin" warning** compares the owner with the server's owner (`GET /guilds/{id}`). Computing real admin rights needs role data; the warning wording covers both cases.

## Review Focus

1. **Hostile game names**: a library name containing `@everyone`, `**bold**`, `[x](http://y)`, or 300 characters must show up in autocomplete truncated to 100 characters, and in replies and `/status` as plain text with no ping. Covered in Task 6 (`suggestAdd truncates…`, `formatStatus escapes…` via `escapeMarkdown` in replies).
2. **Spoofed autocomplete values**: a client can send any string as `game`; `"abc"`, `"-1"`, `"1e3"`, `" 10 "`, and an appid not in the library must all reply "Unknown game." and change nothing. Task 6 (`runAdd rejects non-library values`).
3. **Shutdown while Discord hangs**: a bot API and webhook that never answer must not hold `send()` past both timeouts. Task 5 (`send resolves within both timeouts when everything hangs`).
4. **Flapping connection**: disconnects and reconnects every few seconds for 10 minutes must produce zero notices; one outage longer than 2 min, then recovery, produces exactly one offline and one online notice. Task 7 (`GatewayHealth` tests).
5. **Changing games while another device is playing** (`playingBlocked`): `/add` must still succeed and be idled once the block ends. Not reachable offline; Task 9 live checklist item 7, and Task 2 keeps `computeSelection` free of block logic so the existing unblock re-send covers it.

---

### Task 1: Review and install discord.js

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Modify: `SECURITY-AUDIT.md` (new `## 15. Addendum — discord.js dependency review (2026-10-19)`)

**Interfaces:**
- Produces: `discord.js` 14.27.0 in `node_modules`, importable as `import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js'`.

- [ ] **Step 1: Resolve the tree without installing.** Run `npx pnpm@10.34.6 add discord.js@14.27.0 --save-exact --lockfile-only --ignore-scripts`. Expected: `package.json` gains `"discord.js": "14.27.0"`, `pnpm-lock.yaml` changes, `node_modules` untouched.
- [ ] **Step 2: List every new package.** Diff `pnpm-lock.yaml` against `git show HEAD:pnpm-lock.yaml` and list each added `name@version` with its `integrity`. Expected: a table of N packages (record N).
- [ ] **Step 3: Review each new package** from `https://registry.npmjs.org/<name>/<version>`: `scripts` has no `preinstall`/`install`/`postinstall`; maintainers (discord.js packages are published by the discord.js org's maintainers); publish date ≥ 14 days before 2026-10-19; `engines.node` (record the highest floor); `dist.integrity` equals the lockfile entry. Run `npx pnpm@10.34.6 audit --prod` and classify any advisory as reachable or not, as §8 did. **Stop and report to the user** if any package has install scripts, an integrity mismatch, a suspicious maintainer change, or a reachable advisory.
- [ ] **Step 4: Install.** `npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts`. Expected: success, no lifecycle scripts run. If the highest `engines.node` floor exceeds 18, set `package.json` `engines.node` to that floor.
- [ ] **Step 5: Smoke check.** `node -e "import('discord.js').then(m=>console.log(typeof m.Client, m.GatewayIntentBits.Guilds))"` from the repo root. Expected: `function 1`. Then `npx pnpm@10.34.6 build` passes.
- [ ] **Step 6: Record in `SECURITY-AUDIT.md` §15**: the package table (name, version, integrity verified, install scripts none), maintainers, advisories and verdict, new engines floor, and that `pnpm-lock.yaml` changed only by these additions. Add one line to the top note pointing at §15.
- [ ] **Step 7: Commit** `package.json pnpm-lock.yaml SECURITY-AUDIT.md` — `chore: add discord.js 14.27.0 after dependency review`.

### Task 2: Extract the selection diff from edit mode

**Files:**
- Create: `src/selection.ts`
- Modify: `src/index.ts` (`enterEditMode`, the block from `const oldAppIds` through `exemptAppId = newExemptAppId;`)
- Test: `$T/selection.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface SelectionState { idling: IdlingGame[]; pausing: IdlingGame[]; paused: IdlingGame[] }
  export function computeSelection(
    state: SelectionState,
    newSelection: GameSelection[],
    newExemptAppId: number | null,
    createGame: (selection: GameSelection, isExempt: boolean) => IdlingGame,
    randomIdlePhaseMs: () => number,
    now: Date
  ): SelectionState
  ```

- [ ] **Step 1: Write the failing tests** (`selection.test.mjs`), with games built as plain objects (`startTime: new Date(0)`, `accumulatedMs: 1000`, `nextPauseAtMs: 5000`, `pauseUntil: null`), `randomIdlePhaseMs = () => 7`, `now = new Date(99)`:
  - `keeps kept games as the same objects`: idling A kept → `result.idling[0] === A`, `A.startTime` still `new Date(0)`.
  - `drops deselected games from all three arrays`.
  - `new games come from createGame with the exempt flag`: newSelection adds C with `newExemptAppId = C` → `createGame` called with `(C, true)`, C appended to `idling`.
  - `becoming exempt clears the cooldown threshold`: kept idling A, exempt → `A.nextPauseAtMs === null && A.pauseUntil === null`.
  - `losing exempt rolls a new phase from accumulatedMs`: A with `nextPauseAtMs: null`, not exempt → `A.nextPauseAtMs === 1007`.
  - `a cooling game that becomes exempt moves to idling with startTime = now`.
  - `a cooling game that stays non-exempt stays in pausing`; `paused games stay paused`.
- [ ] **Step 2: Run** → FAIL (`Cannot find module …/selection.js`).
- [ ] **Step 3: Implement `computeSelection` in `src/selection.ts`** by moving the existing block verbatim in behavior (same order of the idling/paused/pausing loops, same `applyExemptChange`). It must not mutate the input arrays (it mutates game objects, as today). Replace the block in `enterEditMode` with a call passing `{ idling: idlingGames, pausing: pausingGames, paused: pausedGames }`, `(sel, isExempt) => createIdlingGame(sel, gamesById.get(sel.appid), isExempt)`, `randomIdlePhaseMs`, `new Date()`, then assign the three arrays and `exemptAppId`.
- [ ] **Step 4: Run tests and build** → PASS, `tsc` 0 errors.
- [ ] **Step 5: Commit** — `refactor: extract selection diff from edit mode`.

### Task 3: Discord config, formatting, and REST helpers

**Files:**
- Create: `src/discord/config.ts`, `src/discord/format.ts`, `src/discord/rest.ts`
- Modify: `src/notifications/discord.ts` (import `parseWebhookUrl`, `escapeMarkdown`, `splitMessage` from the new modules instead of defining them; it is deleted in Task 5)
- Test: `$T/config.test.mjs`, `$T/rest.test.mjs` (port every check from the earlier scratch `scripts/test-discord.mjs` for `parseWebhookUrl`, `escapeMarkdown`, `splitMessage` into these)

**Interfaces:**
- Produces (`config.ts`):
  ```ts
  export const CONFIG_PATH: string                    // ~/.steam-idler/discord.json
  export interface BotConfig { token: string; applicationId: string; ownerId: string; guildId: string; channelId: string }
  export interface DiscordConfig { bot: BotConfig | null; webhookUrl: string | null; disabled: boolean }
  export function loadDiscordConfig(): DiscordConfig | null   // null = no file, unreadable, or invalid (console.error names the path, never values)
  export function saveDiscordConfig(config: { bot: BotConfig | null; webhookUrl: string | null }): boolean
  export function saveDiscordDisabled(): boolean
  export function parseWebhookUrl(raw: string): string | null // moved unchanged
  export function isSnowflake(value: unknown): value is string // /^\d{17,20}$/
  export function isBotTokenShape(value: unknown): value is string // /^[\w-]{18,}\.[\w-]{4,}\.[\w-]{25,}$/
  ```
  File format (flat, as in the spec): `{ "botToken", "applicationId", "ownerId", "guildId", "channelId", "webhookUrl"?, "disabled"? }`. The five bot fields are all present and valid, or all absent; anything partial or invalid makes the whole file invalid. `webhookUrl` is normalized through `parseWebhookUrl`. Written with `writeFileAtomic(CONFIG_PATH, json, 0o600)`; chmod-on-load kept from the current loader.
- Produces (`format.ts`): `export const MAX_CONTENT_LENGTH = 2000`, `escapeMarkdown(text: string): string`, `splitMessage(text: string, max?: number): string[]` (moved unchanged).
- Produces (`rest.ts`):
  ```ts
  export const API_BASE = 'https://discord.com/api/v10'
  export class DiscordApiError extends Error { constructor(public readonly status: number, message: string) }
  export function discordApi(token: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, timeoutMs?: number): Promise<Response> // default 10_000; header Authorization: `Bot ${token}`
  export function postChannelMessage(token: string, channelId: string, content: string, timeoutMs: number): Promise<Response>
  export function postWebhook(webhookUrl: string, content: string, timeoutMs: number): Promise<Response>
  export const COMMANDS: readonly unknown[]
  export function registerCommands(bot: BotConfig): Promise<Response> // PUT /applications/{applicationId}/guilds/{guildId}/commands with COMMANDS
  ```
  Message bodies (channel and webhook): `{ content, allowed_mentions: { parse: [] }, flags: 4 }`. `COMMANDS`: `add` and `remove` each with one required string option `game` (`autocomplete: true`), and `status` with no options; all `type: 1`, `default_member_permissions: "0"`.

- [ ] **Step 1: Write the failing tests.**
  - `config.test.mjs`: valid full file loads with `bot` filled and `disabled: false`; webhook-only file loads with `bot: null`; `{ "disabled": true }` loads `disabled: true`; each of these is rejected (returns `null`, console message contains `discord.json`, never the token): missing `channelId`, `ownerId: "abc"`, `guildId: 123` (number), `botToken: "short"`, `webhookUrl: "https://evil.example/api/webhooks/1/x"`; save then load round-trips and the file text contains no keys other than the flat ones; plus all ported `parseWebhookUrl` / `escapeMarkdown` / `splitMessage` checks.
  - `rest.test.mjs`: `postChannelMessage` calls `https://discord.com/api/v10/channels/123/messages` with `Authorization: Bot <token>` and the exact body; `postWebhook` posts the same body without an Authorization header; `registerCommands` sends `PUT …/applications/<app>/guilds/<guild>/commands` with three commands named `add`, `remove`, `status` and `default_member_permissions === "0"` on each; `DiscordApiError` message for a 401 does not contain the token.
- [ ] **Step 2: Run** → FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules; repoint `src/notifications/discord.ts` imports.
- [ ] **Step 4: Run tests and build** → PASS.
- [ ] **Step 5: Commit** — `feat: add discord config, formatting and REST helpers`.

### Task 4: Bot setup flow (`--setup-discord`)

**Files:**
- Create: `src/discord/setup.ts`
- Test: `$T/setup.test.mjs`

**Interfaces:**
- Consumes: `discordApi`, `postChannelMessage`, `postWebhook`, `registerCommands`, `DiscordApiError`, `saveDiscordConfig`, `loadDiscordConfig`, `parseWebhookUrl`, `isBotTokenShape`.
- Produces:
  ```ts
  export interface BotIdentity { applicationId: string; botName: string; owners: { id: string; name: string }[] }
  export function fetchBotIdentity(token: string): Promise<BotIdentity>      // GET /users/@me (must have bot: true) + GET /oauth2/applications/@me (owner, or team members)
  export function listGuilds(token: string): Promise<{ id: string; name: string }[]>          // GET /users/@me/guilds
  export function guildOwnerId(token: string, guildId: string): Promise<string>                // GET /guilds/{id} → owner_id
  export function listTextChannels(token: string, guildId: string): Promise<{ id: string; name: string }[]> // GET /guilds/{id}/channels, type 0 only, sorted by position
  export function inviteUrl(applicationId: string): string
  export function finishSetup(bot: BotConfig, webhookUrl: string | null): Promise<void> // test post via bot, test post via webhook (if any), registerCommands; saves only if all three succeed; otherwise throws DiscordApiError and saves nothing
  export function runDiscordSetup(): Promise<void>  // prompt glue, exported for index.ts
  ```
  `inviteUrl` returns exactly `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=3072`. Test message text: `✅ steamidled bot connected.` (bot) and `✅ steamidled backup webhook connected.` (webhook).

- [ ] **Step 1: Write the failing tests** (mocked `fetch` routing by URL + method):
  - `fetchBotIdentity returns app id, bot name and owner`; `…lists team members when team-owned`; `…rejects a non-bot token` (`bot` missing) with a message that does not contain the token; `…throws DiscordApiError(401)` on 401.
  - `listTextChannels keeps only type 0, sorted by position`.
  - `inviteUrl` exact string for application `"111111111111111111"`.
  - `finishSetup saves after bot post, webhook post and registration succeed` (file then loads with the same values).
  - `finishSetup saves nothing when registration fails`; `…when the webhook test fails`; `…without a webhook skips the webhook post`.
  - No console output in any test contains the token or the webhook URL.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the core functions, then `runDiscordSetup` with `@inquirer/prompts` (`password` with `mask: '*'` for token and webhook, `select` for owner when there are several, guild, and channel). Flow and copy follow the spec's Setup section: steps text, invite URL printed after identity is known, "invite the bot, then run --setup-discord again" when `listGuilds` is empty, a warning when `guildOwnerId !== ownerId` ("if you're not an admin of this server, Discord will hide the commands from you"), webhook prompt "Backup webhook URL (Enter to skip)" or "(Enter to keep the current one)" when a valid one is already saved, a one-line warning when skipped. Print only names, never tokens or URLs.
- [ ] **Step 4: Run tests and build** → PASS.
- [ ] **Step 5: Commit** — `feat: add discord bot setup flow`.

### Task 5: Notifier with webhook fallback

**Files:**
- Create: `src/discord/notifier.ts`
- Delete: `src/notifications/discord.ts`
- Modify: `src/index.ts` (imports; first-run prompt uses `runDiscordSetup` from `./discord/setup.js`, `saveDiscordDisabled` from `./discord/config.js`; `--help` line becomes `steamidled --setup-discord   (Re)configure the Discord bot and backup webhook`)
- Test: `$T/notifier.test.mjs`

**Interfaces:**
- Consumes: `loadDiscordConfig`, `escapeMarkdown`, `splitMessage`, `postChannelMessage`, `postWebhook`.
- Produces:
  ```ts
  export interface NotifierOptions { botTimeoutMs?: number; webhookTimeoutMs?: number } // defaults 4000 / 4000
  export class DiscordNotifier {
    constructor(options?: NotifierOptions)
    reload(): void
    hasFile(): boolean            // a config file exists and loaded (first-run prompt uses !hasFile(), as today)
    isConfigured(): boolean       // (bot or webhook) and not disabled
    botConfig(): BotConfig | null // null when disabled
    send(text: string): Promise<void>                   // never rejects
    botDown(reason: string, fatal: boolean): Promise<void> // never rejects; announces once per outage
    botUp(): Promise<void>                              // never rejects
  }
  ```
  State: `bot` route is `up` | `down` | `fatal` | `none`. Routing per part, in order: up → bot post; on failure (throw, timeout, non-2xx) retry the same part via webhook; 401 → `botDown(<token reason>, true)`; 403 → `botDown(<permission reason>, false)`; 404 → `botDown(<channel reason>, false)`. down/fatal/none → webhook only. No webhook → console only (`[discord] …`, HTTP status or error message only). A 403/404 "down" lasts for the rest of the run; only a Gateway-driven `botUp()` after a non-fatal `botDown` restores it.
  Exact copy (sent through the normal escape path):
  - offline (via webhook, or console if none): `⚠️ Discord bot offline (${reason}). Notifications are coming through the backup webhook. /add, /remove and /status won't work until the bot is back.`
  - online (via bot; if that post fails, stay down silently): `✅ Discord bot back online. Commands work again.`
  - reasons: 401/4004 `token rejected — reset it in the Developer Portal, run --setup-discord, then restart steamidled`; 403 `no permission to post in the notification channel — fix the bot's channel permissions, then restart steamidled`; 404 `notification channel not found — run --setup-discord, then restart steamidled`; Gateway grace `can't reach Discord for 2 min`; 4013/4014 `gateway intents rejected by Discord`; 4010–4012 `gateway connection rejected (code ${code})`.

- [ ] **Step 1: Write the failing tests** (config file written per test; timeouts `{ botTimeoutMs: 50, webhookTimeoutMs: 50 }`):
  - `bot healthy: posts once to the channel, webhook untouched`.
  - `bot post 500: same content retried via webhook, bot stays up` (next send goes to the bot again).
  - `bot post 401: offline notice then message via webhook; later sends skip the bot`; the offline notice contains `token rejected` and not the token.
  - `bot post 403 and 404 mark down with their reasons`.
  - `botDown twice announces once`; `botUp after non-fatal botDown posts the online notice via bot and routes to bot again`; `botUp after fatal does nothing`.
  - `no webhook: bot failure logs to console only and send resolves`.
  - `webhook-only config sends via webhook`; `disabled config sends nothing`.
  - `send resolves within both timeouts when everything hangs` (Review Focus 3): fetch never resolves until aborted; `send` settles in < 500 ms with 50 ms timeouts and never rejects.
  - `multi-part messages keep order across a mid-message failover`.
  - Console output never contains the token or the webhook URL.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `notifier.ts`, delete `src/notifications/discord.ts`, update `index.ts` imports and help text. A webhook-only config (no bot) prints once at headless/interactive start: `Discord: notifications only (webhook). Run --setup-discord to add the bot for /add, /remove and /status.`
- [ ] **Step 4: Run tests and build** → PASS; `grep -rn "notifications/discord" src` is empty.
- [ ] **Step 5: Commit** — `feat: route notifications through the bot with webhook fallback`.

### Task 6: Command logic

**Files:**
- Create: `src/discord/commands.ts`
- Test: `$T/commands.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export type SelectedState = 'idling' | 'cooldown' | 'paused'
  export interface SelectedGameView { appid: number; name: string; state: SelectedState; exempt: boolean; cooldownEndsAt: Date | null }
  export interface ControlPanel {
    library(): { appid: number; name: string }[]
    selection(): SelectedGameView[]
    busyReason(): string | null      // guard message, or null when changes are allowed
    waitingReason(): string | null   // Steam disconnect reason for /status, or null
    add(appid: number): void
    remove(appid: number): void
  }
  export interface Choice { name: string; value: string }
  export function isAuthorized(ctx: { userId: string; guildId: string | null }, bot: { ownerId: string; guildId: string }): boolean
  export function suggestAdd(panel: ControlPanel, query: string): Choice[]
  export function suggestRemove(panel: ControlPanel, query: string): Choice[]
  export function runAdd(panel: ControlPanel, rawAppid: string): string
  export function runRemove(panel: ControlPanel, rawAppid: string): string
  export function formatStatus(panel: ControlPanel, now: Date): string
  export const NOT_ALLOWED_REPLY = "You're not allowed to control this steamidled."
  ```
  Suggestions: case-insensitive; names starting with the query first, then names containing it, each group alphabetical; empty query → alphabetical; `suggestAdd` excludes selected appids; max 25; names over 100 chars cut to 99 + `…`. Appid parsing: only `/^\d+$/`, then must exist in `library()` (add) or `selection()` (remove), else `Unknown game.`
  Reply copy: add `▶️ Now idling ${name} (until steamidled restarts).`; `Already idling ${name}.`; `Already idling 32 games — remove one first.`; remove `⏹️ Stopped idling ${name} (until steamidled restarts).`; `${name} isn't being idled.`; `${name} is the only game left — steamidled needs at least one.`; busy → `busyReason()` text. Check order: busy, parse/unknown, already/not selected, cap/last game.
  `formatStatus`: sections `Idling (n)`, `Cooldown (n)` with time left (`2h 05m` style), `Paused — playing elsewhere (n)`, `Exempt: name ∞` if any, `Steam: disconnected — ${reason}` when waiting, and last line `Changes made here last until steamidled restarts; favorites are unchanged.`

- [ ] **Step 1: Write the failing tests** against a fake `ControlPanel` that records `add`/`remove` calls:
  - `isAuthorized`: owner in configured guild → true; other user → false; owner in another guild → false; owner in DM (`guildId: null`) → false.
  - `suggestAdd excludes selected games and caps at 25` (library of 40); `…ranks prefix matches first`; `…truncates names over 100 chars to 100` (Review Focus 1, 300-char name); `suggestRemove lists only the selection`.
  - `runAdd rejects non-library values` (Review Focus 2): `"abc"`, `"-1"`, `"1e3"`, `" 10 "`, `"999"` (not in library) → `Unknown game.`, no `add` call.
  - `runAdd refuses the 33rd game`; `runAdd refuses an already selected game`; `runAdd returns busyReason and does not call add when busy`; `runAdd success calls add(appid) and replies with "until steamidled restarts"`.
  - `runRemove refuses the last game`; `runRemove success calls remove`.
  - `formatStatus lists sections, time left, waiting reason, and the restart note`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `commands.ts` (pure; no discord.js import; escaping happens at reply time in Task 7).
- [ ] **Step 4: Run tests and build** → PASS.
- [ ] **Step 5: Commit** — `feat: add discord command logic`.

### Task 7: Gateway health, bot client, and idler wiring

**Files:**
- Create: `src/discord/health.ts`, `src/discord/bot.ts`
- Modify: `src/index.ts` (ControlPanel implementation, bot start in `startIdling`, teardown in `handleShutdown` / `handleCrash`)
- Test: `$T/health.test.mjs`

**Interfaces:**
- Consumes: `DiscordNotifier` (`botConfig`, `botDown`, `botUp`), `registerCommands`, `DiscordApiError`, `escapeMarkdown`, everything in `commands.ts`, `computeSelection`.
- Produces (`health.ts`):
  ```ts
  export const GATEWAY_DOWN_GRACE_MS = 120_000
  export const FATAL_CLOSE_CODES: ReadonlySet<number> // 4004, 4010, 4011, 4012, 4013, 4014
  export class GatewayHealth {
    constructor(onDown: (reason: string, fatal: boolean) => void, onUp: () => void, graceMs?: number)
    disconnected(closeCode: number | null): void // fatal code → onDown(reason, true) now; else arm one grace timer (if not armed and not down)
    ready(): void   // cancel the timer; if down (non-fatal) → onUp()
    stop(): void    // clear timers; ignore later calls
  }
  ```
  After a fatal `onDown`, later calls are ignored.
- Produces (`bot.ts`):
  ```ts
  export interface BotHandle { destroy(): Promise<void> }
  export function startBot(bot: BotConfig, panel: ControlPanel, notifier: DiscordNotifier): BotHandle
  ```
  Behavior: `registerCommands(bot)` first (401 → `notifier.botDown(token reason, true)` and stop; other failures logged, continue); `new Client({ intents: [GatewayIntentBits.Guilds] })`; `client.login(token)` rejection → token reason if the error code is `TokenInvalid`, else `health.disconnected(null)`. Events: `ShardDisconnect` → `health.disconnected(event.code)`; `ShardReconnecting` → `health.disconnected(null)`; `ShardReady` / `ShardResume` → `health.ready()`; `Invalidated` → `notifier.botDown('session invalidated by Discord', true)`; `Error` → `console.error('[discord] ' + err.message)`. `InteractionCreate`: unauthorized autocomplete → `respond([])`; unauthorized command → ephemeral `NOT_ALLOWED_REPLY`; autocomplete `add`/`remove` → `respond(suggest…(panel, focused value))`; commands → `reply({ content: escapeMarkdown(text), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })` with text from `runAdd` / `runRemove` / `formatStatus`. Every handler is wrapped so nothing throws. `destroy()` → `health.stop()` then `client.destroy()`.
- Produces (`index.ts`): `const controlPanel: ControlPanel` and `let botHandle: BotHandle | null`.
  - `busyReason()` in order: `isShuttingDown` → `steamidled is shutting down.`; `!startTime` → `Idling hasn't started yet.`; `isInEditMode` → `The game selector is open on the PC — try again after closing it.`; `isWaitingForResume` → `Disconnected from Steam (${waitingReason}) — try again after it reconnects.`
  - `add(appid)` / `remove(appid)`: `bankElapsed(idlingGames)` unless `playingBlocked`; new selection = current selection plus or minus the game (remove clears `exemptAppId` if it was the exempt game); `computeSelection(...)`; assign arrays and `exemptAppId`; `client.setGamesPlaying(idlingGames.map((g) => g.appid))` unless `isWaitingForResume`; `renderStatus()` unless `isInEditMode`. Never touches favorites.
  - `selection()` maps the three arrays to `SelectedGameView` (`cooldown` with `cooldownEndsAt = pauseUntil`; `exempt = nextPauseAtMs === null`).
  - Start: at the end of `startIdling`, `if (discord.botConfig()) botHandle = startBot(discord.botConfig()!, controlPanel, discord)`.
  - Teardown: in both `handleShutdown` and `handleCrash`, after `Promise.all([grace, finalMessage])` and before `process.exit`, `await botHandle?.destroy()` bounded by `Promise.race` with a 1000 ms timer.

- [ ] **Step 1: Write the failing tests** (`health.test.mjs`, `mock.timers.enable({ apis: ['setTimeout'] })`, `graceMs = 120_000`):
  - `fatal close code reports down immediately with fatal=true`, for each of 4004, 4010–4014.
  - `flapping under the grace never reports` (Review Focus 4): 60 cycles of `disconnected(1006)` + tick 9 s + `ready()` + tick 1 s → zero `onDown`/`onUp` calls.
  - `outage over the grace reports down once, then up once`: `disconnected(1006)`, `disconnected(null)` again at 60 s, tick to 121 s → one `onDown(…, false)`; `ready()` → one `onUp`.
  - `ready after fatal does nothing`; `stop cancels a pending timer`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `health.ts`, then `bot.ts`, then the `index.ts` wiring. `tsc` checks the discord.js event names and payload types against the installed typings; fix any mismatch there rather than casting to `any`.
- [ ] **Step 4: Run tests and build** → PASS. Also re-run every earlier test file (all must still pass).
- [ ] **Step 5: Commit** — `feat: control idling from discord slash commands`.

### Task 8: Documentation and VPS deployment guide

**Files:**
- Modify: `README.md`, `AGENTS.md`, `SECURITY-AUDIT.md`

- [ ] **Step 1: `README.md`.** Replace the "📲 Discord notifications" section with "📲 Discord bot (optional)": creating the application and bot, the invite (View Channel + Send Messages), `--setup-discord`, the three commands, session-only behavior ("lasts until steamidled restarts; favorites unchanged"), owner-only, ephemeral replies, the backup webhook and the offline/online notices, keeping the token and webhook secret (never paste them in chats or screenshots; Reset Token / delete webhook to revoke; put the webhook in a private channel). Update the feature bullet, usage line, and config tree comment (`discord.json  # Discord bot token, IDs, optional backup webhook`).
- [ ] **Step 2: `README.md` systemd section → "Running 24/7 on a Linux VPS"**: Node 22; clone and build with the pinned pnpm commands; a dedicated non-root user (`sudo useradd --system --create-home steamidled`); first interactive run as that user over SSH (QR in the terminal, star favorites, `--setup-discord`); unit with `User=steamidled`, `WorkingDirectory=/opt/steamidled`, `ExecStart=/usr/bin/node /opt/steamidled/dist/index.js --headless`, `Environment=TZ=<Region/City>`, `Restart=on-failure`, `RestartSec=10`, `RestartPreventExitStatus=2`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `ReadWritePaths=/home/steamidled/.steam-idler`; firewall note (no inbound ports needed); keep the "Useful commands" block. State that the unit was not tested by the author of this change.
- [ ] **Step 3: `AGENTS.md`.** Layout: replace `notifications/discord.ts` with the `src/discord/` modules and `src/selection.ts`; add invariants: Discord changes go through `controlPanel` guards and `computeSelection`; `/add` and `/remove` never write favorites; bot is started only from `startIdling`; `send()` budget 4 s + 4 s.
- [ ] **Step 4: `SECURITY-AUDIT.md` §16 "Discord bot control panel"**: new secret (bot token) and its handling; owner/guild lock; intents; new destinations (Gateway, `discord.com/api/v10`); fallback; what was tested offline and what was not; pointer to §15 for the dependency.
- [ ] **Step 5: Verify** `grep -rn "Telegram\|telegram" README.md AGENTS.md src` is empty, all touched files are CRLF (`file <path>` shows CRLF), build passes.
- [ ] **Step 6: Commit** — `docs: document discord bot control and vps deployment`.

### Task 9: Final verification and live checklist

- [ ] **Step 1:** Clean build: delete `dist/`, run `npx pnpm@10.34.6 build` → 0 errors; run every test file in `$T` → all pass.
- [ ] **Step 2:** Secret sweep: `grep -rnE "console\.(log|error|warn).*(token|webhookUrl)" src` → only lines that print names or statuses, reviewed by hand.
- [ ] **Step 3:** Whole-change review by a fresh reviewer against the spec, `AGENTS.md` invariants, and the Global Constraints; fix or answer each finding.
- [ ] **Step 4:** Hand the user this live checklist (they run it on the VPS):
  1. `--setup-discord`: bot and webhook test messages arrive; commands appear in the server.
  2. `/status` shows the idling games; the reply is visible only to you.
  3. `/add` a game by typing part of its name; the PC/VPS status table shows it within seconds.
  4. `/remove` it; `/remove` the last game is refused.
  5. Another account in the server tries `/status` → "not allowed" (or doesn't see the commands).
  6. Reset the bot token in the Developer Portal → within seconds to minutes the webhook posts the offline notice; restart after `--setup-discord` → bot works again.
  7. Play a game on another device, `/add` during the block, stop playing → the added game idles.
  8. `sudo systemctl stop steamidled` returns within a few seconds and "🛑 Idling stopped" arrives.
- [ ] **Step 5:** Report to the user: what changed, test results, what was not run, and the checklist.
