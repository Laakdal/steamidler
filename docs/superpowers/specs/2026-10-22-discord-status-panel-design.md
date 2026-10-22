# Live status panel in Discord: design

Date: 2026-10-22. Branch: `discord-status-panel`, off `main` after v0.1.0.

## Intent

The owner wants to glance at Discord on their phone and see what steamidler is doing right now, without typing `/status`. They showed a reference: a bot message styled as a rich embed (coloured side bar, bold title, "Next update in 56 seconds", one heading per section with the values in code boxes, a footer with a timestamp) that is edited in place instead of posted again.

So steamidler keeps **one** embed message in a **dedicated status channel** and edits it every minute. The existing notifications (started, paused, resumed, flush, zombie, daily report, stopped, bot offline/online) stay exactly as they are, in the notification channel.

## Goals

- One message in a status channel chosen at setup, edited in place, never re-posted while it still exists.
- Content, from the same state the terminal table shows:
  - **State line**, with colour:
    - green "🟢 Idling N games"
    - yellow "🟡 Waiting to resume — <reason>" when disconnected or kicked
    - yellow "🟡 Paused — a game is being played on this account elsewhere" when `playingBlocked`
    - red "🛑 Stopped" after shutdown
    - When both waiting and blocked apply, the waiting line wins (builder's call). In the Stopped state there is no "Next update" line.
  - **Next update** as a Discord relative timestamp `<t:UNIX:R>`, which each client renders as a live countdown ("in 56 seconds"). If the panel stops updating (bot token revoked, VPS down), it turns into "3 minutes ago" by itself, so a stale panel is visible as stale.
  - **Sections**, each an embed field whose value is a code block, shown only when not empty:
    - 🎮 Idling (n): game, total hours, `+gained` this session
    - ❄️ Cooldown (n): game, time left
    - ⏸️ Paused (n): game, while it is being played elsewhere
  - The exempt game is marked `∞` on its row.
  - **Footer** "steamidler v<version>", plus the embed `timestamp` (the client shows "Today at 7:26 PM").
- Refreshed every 60 s, and promptly after anything that repaints the terminal table (start, `/add`, `/remove`, cooldown changes, block/unblock, disconnect/resume), coalesced so edits are at least 5 s apart.
- Survives restarts: the message ID is remembered, so a restarted steamidler edits the same message. If the message was deleted, it posts a new one and remembers that.
- On shutdown or crash: one final edit to the red "🛑 Stopped" state, inside the existing shutdown budget.

## Non-goals

- No webhook fallback for the panel. The relative timestamp already shows when it went stale, and the webhook still delivers the "bot offline" notice.
- No buttons or other interactive components.
- No pinning (it would need the Pin Messages permission). The dedicated channel keeps the message on screen anyway.
- No images or icon URLs in the embed (author, footer or thumbnail icons). Discord would fetch them, and they add nothing the owner asked for.
- No change to existing notifications, commands or `/status`.

## Anti-goals (a failure even if it works)

- The panel delays or breaks idling, a reconnect or shutdown, or changes an exit code (`AGENTS.md` §4: Discord stays optional).
- It floods the channel with new messages instead of editing one.
- A game name or error string pings anyone, formats itself, breaks out of a code block, or a token or URL ends up in the embed or the logs.
- It hammers Discord: more than one edit in flight, or edits closer than 5 s.

## Decided

| Topic | Decision |
|---|---|
| Location | Its own channel, picked at setup (owner's choice). |
| Format | Classic rich embed, closest to the reference (owner approved the mock-up description). |
| Cadence | 60 s, plus coalesced nudges on state changes. |
| Persistence | `~/.steam-idler/discord-status.json` holds `{ "channelId", "messageId" }`. |
| Transport | REST through `fetch` with the bot token, like the notifier (`rest.ts`), not the Gateway. The panel keeps working while the Gateway reconnects. |

## Config and setup

- `discord.json` gains an optional `statusChannelId`, validated as a snowflake on every load like the other IDs. Absent means no panel, so existing configs keep working unchanged. A malformed value makes the file invalid, like any other malformed bot field.
- `--setup-discord` asks "Live status channel:" after the notification channel. The choices are **None** first, then the server's text channels (the notification channel is allowed but not recommended).
- If a channel is picked, setup shows the panel's placeholder embed ("Waiting for idling to start") as its test message and saves its ID to `discord-status.json`. If a message is already stored for that channel, setup edits it, and posts a new one only if the edit fails, so re-running setup never leaves an orphaned panel (builder's call, from the first goal). Like every other setup step, a failure there means nothing is saved.
- **Embed Links.** Discord's docs don't say whether a bot needs Embed Links to send rich embeds, so we don't rely on it either way:
  - the invite link asks for View Channel, Send Messages and Embed Links (`permissions=19456`, up from 3072);
  - after every post or edit, the result is checked. Discord may handle a missing Embed Links permission by returning the message with an empty `embeds` array, or by refusing it with a 403. Either case means the box is not showing, so setup fails with a clear message (give the bot Embed Links in that channel), and at runtime it is logged once. The message carries no `content` text, to match the reference (builder's call).

## Runtime behaviour

- **Start.** The panel starts in `startIdling`, next to the bot, only when the bot config has a `statusChannelId`. It takes a snapshot function from `index.ts`, so `ControlPanel` stays unchanged.
- **Snapshot.** Per game: name, state (idling/cooldown/paused), exempt, total minutes, gained ms and cooldown end. Gained and total use the same rules as the terminal table: no live delta while frozen (`isWaitingForResume || playingBlocked`) or for non-idling games. Plus the global state and the waiting reason.
- **Update.** A PATCH of the stored message. The response is handled by status:

  | Response | Action |
  |---|---|
  | 2xx | Done. Check that `embeds` isn't empty. |
  | 404 on the message | Post a new one and store its ID. |
  | 404 or 403 on the channel | Log once per failure kind, keep trying each tick. |
  | 401 | Stop the panel for this run; the notifier already announces the rejected token. |
  | 429, 5xx, timeout or network error | Skip; the next tick retries. |

  One request is in flight at a time, and each has a 4 s timeout.
- **No stored message,** or one stored for a different channel: post a new one. The old message is left alone, because deleting it isn't worth a failure path.
- **No duplicate posts** (builder's call). A post carries a `nonce` with `enforce_nonce: true`. The same nonce is reused for every retry of that post until one succeeds. If a timed-out post had actually landed, Discord returns that message instead of creating a second one (Create Message docs: "that message will be returned and no new message will be created").
- **The panel has its own 60 s timer** (builder's call). The display loop stops while waiting for resume, and that is exactly when the panel matters.
- **Shutdown and crash.** `stop()` stops the timers, aborts any in-flight request so a slow request can't use up the budget, then sends one final edit (or post) in the red "Stopped" state. It never rejects and is capped at 4 s. `handleShutdown` and `handleCrash` add it to the `Promise.all` they already await, so `process.exit` is always reached (`AGENTS.md` §4).
- **Logging.** Only `err.message` with the token and URLs redacted (`redactSecrets`), never a response body, and only when the failure kind changes.

## Content rules and limits

- Game names are user-controlled:
  - inside code blocks, backticks are replaced so a name can't close the block;
  - outside code blocks, `escapeMarkdown` applies;
  - `allowed_mentions: { parse: [] }` is always sent.
- Embed limits: title 256, description 4096, field value 1024, 25 fields, 6000 total.
  - Rows are clipped to a fixed width (long names end in `…`).
  - A field that would pass 1024 characters ends with "…and N more".
  - With 32 games the whole embed stays well under 6000.
- The `SUPPRESS_EMBEDS` flag the notifications use must **not** be set on panel messages, because it would hide the embed.
- No URL appears in the embed.

## Network and security

- The panel uses one new endpoint, PATCH `/channels/{id}/messages/{id}`. It is on `discord.com/api` like the others, so there's no new destination.
- There is one new permission (Embed Links) and one new file (`discord-status.json`). The file holds no secret, but it is written with `writeFileAtomic(…, 0o600)` like its neighbours and re-validated on load (snowflakes only; anything else is ignored and a new message is posted).
- `SECURITY-AUDIT.md` gets a dated addendum (§17).

## Left to the builder

- Module split: a pure embed builder plus a small `StatusPanel` class in `src/discord/statusPanel.ts` is the expected shape.
- Exact wording, emoji, colours, column widths and duration formats. Reuse the existing `formatDuration` style (`2h 05m`), and show days for cooldowns over 24 h.
- How the coalescing timer is built, as long as edits stay ≥ 5 s apart and timers are cleared on stop.

## Testing

- **Offline tests** (`node:test`, `fetch` mocked):
  - **Embed builder:** normal, empty sections, 32 long names, names with backticks, markdown, `@everyone` and URLs; size limits.
  - **Status file:** tampered and missing files.
  - **Panel:** first post, edit, repost on 404, 401 stops, 403 logs once, 429 and timeout skip, single flight, coalescing, `stop()` resolves within its cap even when `fetch` hangs, no token or URL in any log line.
  - **Setup:** status channel None and picked, empty `embeds` rejected, the invite permissions value.
- **Live checklist** for the owner: setup with a status channel, the box appears and counts down, `/add` updates it within seconds, restart reuses the message, deleting it makes a new one, stop turns it red.
