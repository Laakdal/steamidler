# Security Audit — steamidled v1.2.0

| | |
|---|---|
| **Repository** | https://github.com/louisraetz/steamidled |
| **Commit audited** | `9f2b1ab` (chore: release v1.2.0) |
| **Audit date** | 2026-10-18 |
| **Target platform** | Windows 11 |
| **Method** | Static analysis only — the application was never executed and no dependencies were installed |

> **Local modification (2026-10-18):** Telegram notifications were removed and replaced with Discord webhooks after this audit. Sections below describe upstream v1.2.0 as audited; see **§13 Addendum** for what changed, the new network destination, and the effect on findings. Docker support was removed on 2026-10-19 (**§14**). `discord.js` 14.27.0 and 21 transitive packages were added on 2026-10-21 after review (**§15**), and the webhook notifier became a Discord bot with commands and a webhook fallback (**§16**). This local build is **no longer identical** to the published npm package.

---

## 1. Executive Summary

No malware, credential exfiltration, telemetry, or account-modifying behavior was found. The app's own code makes exactly one kind of network call — to `api.telegram.org`, and only if you opt into notifications. Everything else is the well-known `steam-user` / `steam-session` libraries talking exclusively to Valve.

The published npm package is byte-for-byte identical to this repository's source. The main real risk is by design: the Steam refresh token is stored in plaintext, and the file permissions the code sets are ignored on Windows.

## 2. Overall Risk Rating

**Low**

## 3. Audit Coverage

| Area | What was examined |
|---|---|
| Application source | All 15 files in `src/` (3,490 lines), read line by line |
| Build / run config | `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `tsconfig.json`, `package.json`, `.gitignore`, `.dockerignore`, `README.md` |
| Docs | `docs/*.md` (research notes) — grepped for URLs and commands, not line-read |
| CI/CD | No `.github/` directory exists — no workflows |
| Assets | Both PNGs are valid images with zero trailing bytes after `IEND` (no hidden payload) |
| Dependencies | All 103 locked packages downloaded, SHA-512 verified against the lockfile, extracted, and scanned for network hosts, `child_process`, `eval`, `new Function`; Steam library code paths traced |
| Published package | `@louisraetz/steamidled@1.2.0` downloaded and diffed against a fresh build of the repo source |
| Git history | 32 commits, single author, history reset 2026-04-13, unsigned commits, no deleted files |

## 4. Critical and High Findings

**None.**

## 5. Medium and Low Findings

### M1 — Steam refresh token stored in plaintext

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | High |
| **Location** | `src/storage/credentials.ts:13`, `:24`, `:77` |
| **File** | `%USERPROFILE%\.steam-idler\credentials.json` |

**Issue:** The code sets `0o600` / `0o700` permission modes, but these are no-ops on Windows. Only the user-profile ACL protects the file, so any process running as your user can read it.

**Exploitation scenario:** Other malware on the machine steals the token and obtains a logged-in Steam client session without your password or Steam Guard, until the token is revoked. Trades and market listings still require mobile-authenticator confirmation if you use it.

**Remediation:** No small code fix (Windows DPAPI encryption would require a native module or a PowerShell shell-out). Mitigate by running `steamidled --logout` when you stop using the tool and keeping the machine free of other malware.

---

### L1 — README install path bypasses the lockfile

| | |
|---|---|
| **Severity** | Low |
| **Confidence** | High |
| **Location** | `README.md:41` |

**Issue:** `npm install -g @louisraetz/steamidled` ignores `pnpm-lock.yaml`; caret ranges resolve fresh at install time to unaudited versions (e.g. `ip-address@10.7.4`, published 2026-10-11, one week before this audit).

**Remediation:** Build from the clone with the frozen lockfile (see §12).

---

### L2 — Transitive dependencies with published advisories (not reachable)

| | |
|---|---|
| **Severity** | Low |
| **Confidence** | High |

| Package | Advisories | Why it does not apply here |
|---|---|---|
| `protobufjs@6.11.6` | 1 critical, 4 high, several moderate (code injection, DoS) | Pulled in only by `steam-appticket`, whose functions are called only from `steam-user`'s app-ticket methods (`components/appauth.js`). The app never calls them. No patched 6.x release exists. |
| `protobufjs@7.5.6` | 4 (DoS, name shadowing) | GHSA-jggg-4jg4-v7c6, GHSA-f38q-mgvj-vph7, GHSA-j3f2-48v5-ccww require an attacker-controlled **schema**; Steam schemas are static JSON inside a hash-verified tarball. GHSA-wcpc-wj8m-hjx6 is byte-triggered but requires `google.protobuf.Any` fields — no Steam schema uses that type. |
| `adm-zip@0.5.17` | 8 (zip bombs, symlink overwrite, SUID) | Used only in `steam-user/components/cdn_compression.js` for depot/CDN downloads, which the app never performs. |
| `ip-address@10.2.0` | 7 (SSRF bypasses) | Reached only via `socks-proxy-agent`, which `steam-user` uses only when the `socksProxy` option is set. The app never sets it. |

**Remediation:** None required to run. `steam-user@5.3.0` is already the latest release, so the fix must come from upstream. Overrides could be added later once newer versions have aged.

---

### L3 — Telegram chat-ID selection can pick a stranger's chat — **Resolved locally (§13)**

| | |
|---|---|
| **Severity** | Low |
| **Confidence** | High |
| **Location** | `src/notifications/telegram.ts:122-125` |

**Issue:** If no `/start` message is found, setup falls back to whichever chat last messaged the bot. If someone else sends `/start` to your bot after you during the setup window, their chat wins.

**Impact:** Game names, playtime, and status/error messages are sent to that chat. No credentials are exposed. Only relevant if Telegram notifications are enabled.

**Remediation:** Remove the fallback (`?? messages[messages.length - 1]`) and show the chosen chat's name for confirmation before saving.

---

### Informational

| Item | Location | Notes |
|---|---|---|
| Persona forced to Online on every logon | `src/steam/client.ts:65` | Overrides an Invisible setting. See §6.1. |
| Telegram bot token stored in plaintext | `~/.steam-idler/telegram.json` | Same Windows permission caveat as M1. |
| Crash message forwarded to Telegram | `src/index.ts:1367-1374` | Includes `err.message`; no secrets observed in reachable error paths. |
| Favorites filename built from account name | `src/storage/favorites.ts:15` | Path traversal would require an attacker who can already write your config — false positive. |
| Docker base image not digest-pinned; `pnpm@10` floating | `Dockerfile:2,4,12` | Relevant only if you use Docker. **Moot locally:** Docker files removed (§14). |
| No npm provenance attestation; unsigned commits | — | Mitigated by the byte-identical rebuild in §8. |
| Terms-of-service risk (not a security issue) | `README.md:111-121` | Idling uses the official protocol (as Idle Master / ASF do). The randomizer exists to make hours look natural; whether Valve objects is a ToS question. |

## 6. Steam Account Security

- **Login methods:** QR code, or username + password via `steam-session`. The password is RSA-encrypted with Steam's own public key (`steam-session/dist/AuthenticationClient.js:36,46`) and never stored. Only the refresh token and account name are persisted.
- **Every Steam API the app calls:** `logOn`, `logOff`, `relog`, `gamesPlayed`, `getUserOwnedApps`, `setPersona`, `renewRefreshToken`, plus Steam Guard code submission during login.
- **Never called:** trade, inventory, market, wallet, or account-settings APIs.
- **Device identity:** machine ID is derived from the account name (`AccountNameGenerated`, `steam-user` default) and `machine_name` is sent empty — no hardware fingerprint or hostname leaves the PC.
- **Extra local files:** `steam-user` writes small cache files (e.g. `cellid-*.txt`) to `%LOCALAPPDATA%\doctormckay\node-steamuser\`. `--logout` does not remove them; they contain no credentials.

### 6.1 Why the persona is forced Online

`src/steam/client.ts:61-65`:

```ts
// Persona resets to Offline on every fresh session — including relog and
// steam-user's silent autoRelogin, both of which bypass
// loginWithRefreshToken. Re-assert Online here so a flush relog never
// leaves the account invisible/offline.
this.client.setPersona(SteamUser.EPersonaState.Online);
```

Every new Steam session starts Offline. The tool logs in again on its own every 4 hours (to make Steam commit playtime) and after any dropped connection. Commit `9fe8b42` ("fix: flush invisible issue") added this line after the author saw the account show as offline following a re-login.

The rationale in `docs/steam-playtime-research.md` §3 is that hours only save reliably if the client is "online" at game start and stop — but that section is about being **connected**, not about visible status, and the author labels nearby claims as "lore". Nothing in the repo proves Invisible status stops playtime from counting.

**Impact:** Privacy, not security. If you normally use Invisible, friends will see you online and "playing" the idled games. To stay invisible, change `Online` to `Invisible` on line 65 — untested whether hours still count, so verify on your profile after a few hours.

### 6.2 Recovery steps if credentials leak

1. Steam → Account details → **Manage Steam Guard** → **Deauthorize all other devices** (revokes refresh tokens).
2. Delete `%USERPROFILE%\.steam-idler\credentials.json` (or run `steamidled --logout`).
3. For Telegram: send `/revoke` to @BotFather, then rerun `steamidled --setup-telegram`.

## 7. Network Analysis

| Destination | Initiated by | Data sent | Auth | Expected |
|---|---|---|---|---|
| Steam CM servers `wss://<cm>/cmsocket/` (list from `api.steampowered.com/ISteamDirectory/GetCMListForConnect`) | `steam-user` via `src/steam/client.ts` | Refresh token, idled app IDs, persona state | Yes | Yes |
| Steam authentication service | `steam-session` via `src/steam/auth.ts` | Username + RSA-encrypted password, or QR challenge; Steam Guard code | Yes | Yes |
| Refresh-token renewal over the CM connection | `src/steam/client.ts:163` | Refresh token | Yes | Yes |
| `https://api.telegram.org/bot<token>/{getMe,getUpdates,sendMessage}` | `src/notifications/telegram.ts:77,112,136,166` | Chat ID; game names, playtime, status and error text | Bot token | Yes (opt-in only) |

- No hardcoded IP addresses.
- No analytics, telemetry, or crash-reporting services.
- No auto-update or download-and-execute mechanism.
- Other Steam URLs present in the libraries (trade-offer links, CDN avatar images, `s.team` links) are string builders never invoked by this app.

## 8. Dependency and Supply-Chain Review

- **Lockfile:** pnpm lockfile v9; all 103 packages carry `sha512` integrity hashes and resolve to `registry.npmjs.org`. Every downloaded tarball matched its hash (0 mismatches). No git, file, or link dependencies.
- **Published vs. source:** `@louisraetz/steamidled@1.2.0` — all 28 `dist/` files (`.js` + `.d.ts`), `README.md`, and both PNGs are identical to the repo compiled with TypeScript 5.9.3. The package's `gitHead` is `9f2b1ab`; `hasInstallScript: false`.
- **Install-time scripts:** only `protobufjs` (6.11.6 and 7.5.6) has a `postinstall`; it was read and only prints a version-scheme warning. `prepare` scripts in other packages do not run for registry installs. pnpm 10 does not run dependency lifecycle scripts by default.
- **Process execution in dependencies:** only `@inquirer/external-editor` (for the `editor` prompt, which this app never uses), protobufjs's built-in code generation, and dev-only `scripts/generate-protos.js` files.
- **Maintainers:** `steam-user`, `steam-session`, `@doctormckay/stdlib`, `websocket13`, `steam-totp`, `file-manager` are all published by `doctormckay`, the long-standing author of these libraries.
- **Deprecated packages:** none.

## 9. Changes Made

None during the audit itself. Afterwards, at the user's request, Telegram was replaced with Discord — see **§13 Addendum**.

## 10. Validation Results

| Check | Outcome |
|---|---|
| Full manual review of `src/` | No `child_process`, `eval`, or dynamic imports; `fetch` only in `telegram.ts` |
| Advisory lookup for every locked version (npm bulk advisory endpoint — same backend as `npm audit`) | Hits in 4 packages; all traced and found not applicable (§5 L2) |
| GitHub advisory details for `protobufjs@7.5.6` | All require attacker-controlled schemas or `google.protobuf.Any`; not applicable |
| SHA-512 verification of all 103 tarballs | 0 mismatches |
| Rebuild from source + diff against npm package | Identical |
| PNG trailing-data check | 0 bytes after `IEND` in both files |

**Not performed:** `pnpm audit` itself (pnpm not installed), any execution of the application, any dynamic or network-capture analysis.

**Data sent externally during the audit:** package names and versions to `registry.npmjs.org`; advisory IDs to `api.github.com`. No source code, credentials, or personal data.

## 11. Remaining Risks

- Transitive dependency code was searched for hosts and dangerous APIs, not fully reviewed line by line.
- No dynamic or network-capture testing was done.
- Any commit after `9f2b1ab`, or a regenerated lockfile, is not covered by this audit.
- Whether Valve tolerates the idling is outside the scope of static analysis.

## 12. Final Recommendation

**SAFE TO CONSIDER RUNNING** — on two conditions:

1. Build from the cloned repository with the frozen lockfile (not `npm install -g`):

   ```
   npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts
   npx pnpm@10.34.6 build
   node dist/index.js
   ```

   `pnpm@10.34.6` is pinned (released 2026-09-28) rather than a floating `@10`, so a just-published pnpm release is never pulled in.

2. Accept the plaintext refresh-token caveat (M1).

Prefer **QR login** so your Steam password never passes through the tool.

---

## 13. Addendum — Telegram replaced with Discord webhooks (2026-10-18)

At the user's request, Telegram support was removed and replaced with Discord **webhook** notifications. A webhook was chosen over a Discord bot: it is a single URL, can only post to one channel, cannot read messages, and needs no chat-ID discovery.

### Files changed

| File | Change |
|---|---|
| `src/notifications/telegram.ts` | **Deleted** |
| `src/notifications/discord.ts` | **New** — `DiscordNotifier` (`send` / `reload` / `isConfigured` / `hasFile`), `runDiscordSetup`, `saveDiscordDisabled`, plus pure helpers `parseWebhookUrl`, `escapeMarkdown`, `splitMessage` |
| `src/index.ts` | Notifier swapped; `--setup-telegram` → `--setup-discord`; help text, setup prompt and comments updated. Message wording and timing unchanged |
| `src/notifications/dailyReport.ts` | Comment only |
| `docker-entrypoint.sh`, `docker-compose.yml` | Comments only |
| `README.md` | Telegram section rewritten as Discord webhook setup; flags, Docker commands and config tree updated |
| `docs/steam-playtime-research.md` | Four references renamed |

### Security properties of the Discord module

| Property | Implementation |
|---|---|
| Destination locked to Discord | `parseWebhookUrl` accepts only `https://` on `discord.com`, `discordapp.com`, `canary.discord.com`, `ptb.discord.com`, path `/api/(vN/)webhooks/<digits>/<token>`; rejects ports, credentials, extra path segments. The stored URL is rebuilt from validated parts (only a numeric `thread_id` query survives, for forum channels). Validation runs at setup **and on every config load**, so a hand-edited `discord.json` pointing elsewhere is ignored and nothing is posted |
| No pings | Every post sends `allowed_mentions: { parse: [] }`, so a game name such as `@everyone` cannot ping the channel |
| Plain text | `escapeMarkdown` neutralises markdown and masked links (`[text](url)`) in game names and error strings; `flags: 4` (SUPPRESS_EMBEDS) stops link previews |
| Discord 2000-char limit | `splitMessage` splits at line boundaries (a 32-game daily report is ~3,600 chars) and posts parts sequentially |
| Shutdown never hangs | `send()` catches errors per part and never rejects, preserving the `Promise.all([grace, send()])` exit paths |
| Secret never logged | The webhook URL embeds its token; only HTTP status or error message is logged. Setup prints only the webhook's name, never the GET response (which contains the token) |
| Broken webhook never stored | Setup validates the URL, GETs the webhook, posts a test message, and saves `discord.json` only after the post succeeds |

### Effect on findings

- **L3 resolved.** There is no chat-ID discovery; the webhook URL fixes the channel.
- **New secret:** `%USERPROFILE%\.steam-idler\discord.json` holds the webhook URL in plaintext (same Windows caveat as M1; `0o600` is a no-op). Impact if stolen: someone can post messages into that one channel — no read access, no access to your Steam account. Revoke by deleting the webhook in Discord (Server Settings → Integrations → Webhooks).
- **§7 Network:** `api.telegram.org` is gone. Replacement row:

  | Destination | Initiated by | Data sent | Auth | Expected |
  |---|---|---|---|---|
  | `https://discord.com/api/webhooks/<id>/<token>` | `src/notifications/discord.ts` | Game names, playtime, status and error text | Token in URL | Yes (opt-in only) |

- **§8 Supply chain:** the byte-identical match with npm `@louisraetz/steamidled@1.2.0` no longer applies to this local build. No dependencies were added or changed — `package.json` and `pnpm-lock.yaml` are untouched; Discord is reached with Node's built-in `fetch`.

### Validation

| Check | Outcome |
|---|---|
| `pnpm@10.34.6 install --frozen-lockfile --ignore-scripts` | Installed exactly the 103 audited lockfile packages; no lifecycle scripts run |
| `pnpm build` (`tsc`, full type check) | Passed, 0 errors |
| Scratch test of the compiled module (mocked `fetch`, temporary home dir, no network) | 42/42 checks passed: 22 URL accept/reject cases (lookalike hosts, `http:`, ports, credentials, extra paths, bad `thread_id`), 4 tampered-`discord.json` cases (ignored, zero posts), stored-URL normalization, markdown escaping, splitting (32-game report → 2 parts ≤ 2000 chars, nothing lost), sequential posting, `send()` resolving despite a thrown and a rejected part, mention/embed suppression in every payload, no token in logged errors, disabled config sends nothing |
| Leftover-reference sweep | No Telegram references remain outside this report |

**Not performed:** a real post to a live webhook, and running the application.

## 14. Addendum — Docker support removed (2026-10-19)

The user plans to run steamidled headless on a Linux VPS under systemd, and asked for Docker to be removed from the repo.

| File | Change |
|---|---|
| `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `.dockerignore` | **Deleted** |
| `README.md` | Docker section and the Docker volume note removed |

No source code, dependency, or lockfile changed. Effect on findings: the informational "Docker base image not digest-pinned; `pnpm@10` floating" item no longer applies to this tree. On Linux, the `0o600` file mode on `credentials.json` and `discord.json` is enforced, which narrows M1 (plaintext refresh token) to root and the account running the service, unlike Windows where the mode is a no-op.

## 15. Addendum — discord.js dependency review (2026-10-21)

The Discord bot control panel (spec `docs/superpowers/specs/2026-10-19-discord-control-panel-design.md`) needs a Gateway connection, so `discord.js` was added as the project's first new runtime dependency since the audit. It is pinned exactly (`"discord.js": "14.27.0"`, no caret).

### How the tree was resolved

`pnpm@10.34.6 add discord.js@14.27.0 --save-exact --lockfile-only --ignore-scripts` resolved the tree into `pnpm-lock.yaml` without installing. The first resolution picked two releases younger than the 14-day minimum (`discord-api-types@0.38.57`, published 2026-10-19, and `undici@6.29.1`, published 2026-10-15). The tree was re-resolved with `--config.minimum-release-age=20160` (14 days, this command only), which selected `discord-api-types@0.38.56` and `undici@6.29.0`. npm lists no advisories for either `undici` version, so the skipped release was not a security fix.

`pnpm-lock.yaml` changed only by additions: 22 new packages, 0 existing entries changed, 0 removed.

### Packages added

| Package | Published | Publisher | Maintainers |
|---|---|---|---|
| `discord.js@14.27.0` | 2026-07-15 | crawl | hydrabolt, crawl, spaceeec |
| `@discordjs/builders@1.14.1` | 2026-03-31 | crawl | crawl, hydrabolt |
| `@discordjs/collection@1.5.3` | 2023-08-17 | crawl | crawl, hydrabolt |
| `@discordjs/collection@2.1.1` | 2024-09-02 | crawl | crawl, hydrabolt |
| `@discordjs/formatters@0.6.2` | 2025-11-18 | crawl | crawl, hydrabolt |
| `@discordjs/rest@2.6.3` | 2026-07-19 | crawl | crawl, hydrabolt |
| `@discordjs/util@1.2.0` | 2025-11-18 | crawl | crawl, hydrabolt |
| `@discordjs/ws@1.2.3` | 2025-06-16 | crawl | crawl, hydrabolt |
| `discord-api-types@0.38.56` | 2026-09-28 | GitHub Actions | crawl, spaceeec, vladfrangu |
| `@sapphire/async-queue@1.5.5` | 2024-11-09 | vladfrangu | favna, vladfrangu, kyranet |
| `@sapphire/shapeshift@4.0.0` | 2024-05-20 | favna | favna, vladfrangu, kyranet |
| `@sapphire/snowflake@3.5.5` | 2024-11-09 | vladfrangu | favna, vladfrangu, kyranet |
| `@vladfrangu/async_event_emitter@2.4.7` | 2025-10-04 | vladfrangu | vladfrangu |
| `undici@6.29.0` | 2026-09-25 | GitHub Actions | matteo.collina, ronag, ethan_arrowood |
| `ws@8.22.0` | 2026-09-26 | lpinca | lpinca |
| `@types/ws@8.18.2` | 2026-09-29 | types | types |
| `magic-bytes.js@1.13.1` | 2026-07-24 | larskoelpin | larskoelpin |
| `ts-mixer@6.0.4` | 2024-02-20 | tannerntannern | tannerntannern |
| `tslib@2.8.1` | 2024-10-31 | typescript-bot | TypeScript team |
| `lodash@4.18.1` | 2026-04-01 | jdalton | mathias, jdalton, bnjmnt4n |
| `lodash.snakecase@4.1.1` | 2016-08-13 | jdalton | jdalton, mathias, phated |
| `fast-deep-equal@3.1.3` | 2020-06-08 | esp | esp |

For every package, `dist.integrity` from `registry.npmjs.org` equals the lockfile's `sha512` entry, and every package is at least 14 days old. None has a `preinstall`, `install`, or `postinstall` script, and none builds native code. `undici` and `magic-bytes.js` declare a `prepare` script, which does not run for registry installs and is blocked by `--ignore-scripts` regardless. `@sapphire/shapeshift@4.0.0` was published by a different Sapphire maintainer (favna) than its previous version (vladfrangu). Both are long-standing maintainers of the project, and the release is from 2024, so this is not treated as a takeover.

### Advisories

`pnpm audit --prod` reports 30 advisories, the same count with or without `discord.js`; none is on a path through the `discord.js` tree. All 30 are in the four package versions already classified as not reachable in §5 L2: `protobufjs@6.11.6` (1 critical, 5 high, 5 moderate), `protobufjs@7.5.6` (1 high, 3 moderate), `adm-zip@0.5.17` (5 high, 3 moderate), and `ip-address@10.2.0` (1 high, 6 moderate). `protobufjs@6.11.6` has one more high-severity advisory than when §5 was written. It is reached the same way (`steam-appticket`, never called), so the §5 verdict stands.

### Effect on the project

- **Node floor:** `undici@6.29.0` requires Node `>=18.17`, so `package.json` `engines.node` is now `>=18.17.0`. The VPS deployment uses Node 22.
- **New outbound destinations** (Discord Gateway, `discord.com/api/v10`) and the bot token as a new secret are covered in §16, with the bot itself.

### Validation

| Check | Outcome |
|---|---|
| `pnpm@10.34.6 install --frozen-lockfile --ignore-scripts` | Installed the 22 reviewed packages; lockfile left unchanged; no lifecycle scripts run |
| Installed versions | `discord.js@14.27.0`, `undici@6.29.0`, `discord-api-types@0.38.56`, `ws@8.22.0`, matching the review |
| Smoke check: `import('discord.js')` | `Client` is a function, `GatewayIntentBits.Guilds === 1`, `version === '14.27.0'` |
| `pnpm build` (`tsc`) | Passed, 0 errors |

**Data sent externally during this review:** package names and versions to `registry.npmjs.org`. No source code, credentials, or personal data.

## 16. Addendum — Discord bot control panel (2026-10-21)

The webhook notifier from §13 became a Discord bot the user creates for themselves. The bot posts the notifications and takes `/add`, `/remove` and `/status` from its owner. The webhook stays as an optional backup route. Design: `docs/superpowers/specs/2026-10-19-discord-control-panel-design.md`. Dependency: `discord.js` 14.27.0, reviewed in §15. Commits `48b0098` to `b916e80` on branch `discord-bot`.

### Files changed

| File | Change |
|---|---|
| `src/notifications/discord.ts` | **Deleted**; split into the modules below |
| `src/discord/config.ts` | `discord.json` load and save. Bot fields are all-or-nothing and validated on every load (token shape, numeric snowflake IDs); the webhook still goes through `parseWebhookUrl` |
| `src/discord/format.ts` | `escapeMarkdown`, `splitMessage` (moved from §13's module) |
| `src/discord/rest.ts` | REST calls through `fetch` with timeouts; `DiscordApiError` carries only a status and a caller-written message |
| `src/discord/setup.ts` | `--setup-discord`: token check, owner and server lookup, channel pick, optional webhook, test posts, command registration |
| `src/discord/notifier.ts` | `DiscordNotifier`: bot first, webhook fallback, offline and online notices |
| `src/discord/commands.ts` | Pure command logic and the owner check |
| `src/discord/health.ts` | `GatewayHealth`: 2-minute offline grace, fatal close codes |
| `src/discord/bot.ts` | discord.js Gateway client that answers the commands |
| `src/selection.ts` | Selection diff extracted from the `E` editor, shared with the commands |
| `src/index.ts` | `controlPanel`, bot start in `startIdling`, capped bot shutdown, redacted crash log |

### New secret: the bot token

- Stored in `~/.steam-idler/discord.json` next to the webhook URL, written with `writeFileAtomic(..., 0o600)` (enforced on Linux, a no-op on Windows, as M1).
- Whoever holds it controls the bot account: it can read and post wherever the bot has access. The exposure is narrowed by:
  - the invite, which asks only for View Channel and Send Messages (permissions `3072`, scopes `bot applications.commands`);
  - the `Guilds` Gateway intent only, with no privileged intents (message content, members, presence);
  - commands registered in one server only.
- The token does **not** let anyone change the idling: the owner check runs inside steamidler (below).
- Revocation: **Reset Token** in the Developer Portal. The running bot then reports itself offline through the webhook (REST 401, or Gateway close 4004), stops retrying, and asks for `--setup-discord` and a restart.

### Who can control the idler

- Every interaction, autocomplete included, is checked against the owner's user ID and the configured server ID before anything else. Other users, other servers and DMs get an ephemeral "not allowed" reply, or an empty suggestion list, and nothing changes. The owner ID comes from the application (`GET /oauth2/applications/@me`); for a team application, setup asks which member.
- Commands carry `default_member_permissions: "0"`, so Discord hides them from non-admins as a first layer.
- A client can send any string as the game value. It is accepted only as a plain digit string naming a game in the library (`/add`) or in the selection (`/remove`). `"1e3"`, `" 10 "` and `"-1"` are rejected.
- Commands change only the running session, through the same guards and selection diff as the local editor. They never write favorites and cannot stop the idler, log in, or change the exempt game. The 32-game cap is checked in the command and again in `controlPanel.add`.
- Replies are ephemeral, markdown-escaped, mention-free, and split at 2000 characters.

### Network destinations

The §7 table gains these rows. All of them are Discord, and the user opts in to each:

| Destination | Initiated by | Data sent | Auth |
|---|---|---|---|
| `https://discord.com/api/v10/...` (users, applications, guilds, channels, commands) | `src/discord/rest.ts`, `setup.ts` | Setup lookups, notification text, command definitions | Bot token header |
| Discord Gateway (`wss://`, URL from `GET /gateway/bot`) | `discord.js` in `src/discord/bot.ts` | Identify and heartbeats; receives interactions | Bot token |
| `https://discord.com/api/v10/interactions/<id>/<token>/callback` | `discord.js` | Command replies and autocomplete choices | Interaction token in the URL |
| `https://discord.com/api/webhooks/<id>/<token>` | `src/discord/notifier.ts` | Notification text when the bot is down or fails a post | Token in the URL (unchanged from §13) |

### Failure isolation

- **Fallback with a webhook:**
  - A bot post that fails is retried through the webhook, so no notification is lost.
  - A 401, 403 or 404 marks the bot down and sends one offline notice through the webhook. So do a fatal Gateway close (4004, 4010–4014) and a Gateway outage longer than 2 minutes.
  - An outage that later turns fatal (a rejected token) sends a second notice, since the owner must act.
  - When the Gateway is back, one online notice is posted through the bot. If that post fails, each later send tries the bot first and switches back on the first success, still within 8 s per part. A new fault cancels this, so a REST post that works during a Gateway outage never announces recovery.
- **Without a webhook:** a non-fatal fault keeps the bot route, since there is nowhere else to send. Undelivered text and a fatal notice go to the console.
- **Time bounds:** `send()` never rejects and is capped per part at 4 s for the bot and 4 s for the webhook. The bot is closed after the final notification, capped at 1 s, so `systemctl stop` stays within seconds.
- **No stray rejections:** every promise in `bot.ts` has a catch, and every client has an `error` listener. `@discordjs/ws` runs some reconnect work as fire-and-forget promises, so the process-wide `unhandledRejection` handler logs and ignores a rejection whose stack is inside `discord.js` or `@discordjs/*`. Every other rejection is still a crash. A failed login is retried with a fresh client every 30 s, backing off to 5 min. A rejected token or fatal close stops the retries. The failed client's listeners are removed, so it can never answer a command twice.
- **Logging:** every `[discord]` log line that carries error text, from the bot and from the notifier, goes through `redactSecrets`, which cuts the bot token and every URL. discord.js errors carry request URLs, and a callback URL embeds the interaction token. Some `fetch` errors quote the request URL, and a webhook URL embeds its token. `handleCrash` prints the stack text through the same helper instead of the whole error object, and the crash message posted to Discord is redacted the same way.

### Remaining risks

- An ignored library rejection can leave the Gateway connection without a reconnect in progress (for example, an `@discordjs/ws` reconnect that rejects). The bot then counts as offline after 2 minutes, notifications move to the webhook, and commands stay unavailable until steamidler restarts. Idling is not affected. The ignored error is logged with a redacted stack.
- The same filter also ignores a throw from our own Gateway event listeners (`health.ts`), since those run inside discord.js's call chain. Only Discord code can be affected; idling runs outside it.
- A synchronous exception thrown inside discord.js (as opposed to a rejection) would still reach `uncaughtException`, crash and exit with code 1, and systemd would restart it. Continuing after an uncaught exception is unsafe, so this stays a crash. Not observed.
- After a failed login, discord.js may keep reconnecting the failed client's shard on its own. That connection has no listeners, so it cannot act, and it ends when the process exits.
- Two steamidler processes with the same bot token would both answer every command. The README says to run one at a time.
- The token and webhook URL are plaintext on disk, as M1.

### Validation

| Check | Outcome |
|---|---|
| `pnpm build` (`tsc`, strict) | Passed, 0 errors |
| Offline tests: throwaway `node:test` files against `dist/`, with `fetch` mocked and discord.js replaced by a fake module, no network | 114/114 passed: config 19, rest 5, setup 14, notifier 24, commands 15, health 10, selection 7, bot 17, redaction 3 |
| What the tests cover | Tampered and partial config files; owner lock (other user, other server, DM); spoofed game values; hostile game names (`@everyone`, markdown, links, 300 characters); 32-game cap and last-game refusal; fallback routing for 401, 403, 404, 500, timeouts and hangs; `send()` timing; flapping Gateway (no notices) versus a 2-minute outage (one offline, one online notice); fatal close codes; login retry and backoff; destroy during setup; secrets absent from every log line |
| Independent review of `bot.ts` and the `index.ts` wiring | 2 should-fix findings (a failed client being reused for retries, and retries after a fatal close) and 2 nits; all fixed, verified against the discord.js source |
| Independent whole-branch review | 4 should-fix findings and 5 nits, all fixed: no-webhook and failed-recovery routing; library rejections crashing the idler; unredacted crash text sent to Discord; a game removed and re-added the same day reported as 0m; `/add` making the stored exempt game exempt; missing SUPPRESS_EMBEDS on replies; the offline notice's wording; a fatal turn of an outage going unannounced; an invalid `discord.json` overwritten by the first-run prompt. The `index.ts` parts are checked by reading the code only, since `index.ts` cannot be loaded offline |
| Independent review of those fixes | 2 should-fix findings in the new recovery logic (a stale recovery flag announcing "back online" during a later Gateway outage; a stale check after an `await` allowing a duplicate notice or overriding a fatal close) and a missing remaining risk; all fixed and covered by 3 tests |

**Not performed:** a real Discord connection, a real Steam session, and the systemd unit on a live server. These are on the user's live checklist.

**Found while writing the deployment guide:** `steam-user` keeps its own files under `~/.local/share/node-steamuser`. The README's systemd unit makes the system read-only (`ProtectSystem=strict`) and lists that directory in `ReadWritePaths`, so steam-user's writes, which it otherwise drops silently, keep working.

## 17. Addendum — Live status box (2026-10-23)

steamidler can keep one rich-embed message in a status channel the owner picks at setup, edited every minute and after state changes, and turned red on shutdown. Design: `docs/superpowers/specs/2026-10-22-discord-status-panel-design.md`. Plan: `docs/superpowers/plans/2026-10-23-discord-status-panel.md`. Branch `discord-status-panel`. No new dependency.

### Files changed

| File | Change |
|---|---|
| `src/discord/config.ts` | Optional `statusChannelId`, validated as a snowflake on every load like the other IDs; a malformed value invalidates the file |
| `src/discord/statusStore.ts` | **New.** `~/.steam-idler/discord-status.json` (`channelId`, `messageId`). No secret, written with `writeFileAtomic(..., 0o600)`, re-validated on load: anything but two snowflakes is ignored and a fresh box is posted |
| `src/discord/statusEmbed.ts` | **New.** Pure embed builder |
| `src/discord/statusPanel.ts` | **New.** `publishStatus` (edit, else post) and `StatusPanel` (timers, outcomes, shutdown) |
| `src/discord/rest.ts` | `PATCH` added; `postEmbedMessage`, `editEmbedMessage`; optional abort signal combined with the timeout |
| `src/discord/setup.ts` | Status channel prompt; placeholder box; invite permissions `3072` → `19456` |
| `src/index.ts` | Snapshot of the idling state, panel start in `startIdling`, nudge on repaint, `stop()` in both exit paths |

### Permissions

The invite gains **Embed Links** (`19456` = View Channel + Send Messages + Embed Links). Discord's documentation does not say whether a bot needs it to send rich embeds, so steamidler does not depend on either answer: a 403, or a returned message with an empty `embeds` array, means the box is not showing. Setup then refuses to save, and at runtime one log line names the fix. Embed Links also lets the bot's links unfurl, but every other message still sets `SUPPRESS_EMBEDS`, and the box contains no URL.

### Network destinations

No new destination. The box uses `POST` and `PATCH` on `https://discord.com/api/v10/channels/<status channel>/messages[/<id>]` with the bot token header, the same host and authentication as §16. The embed has no author, footer or thumbnail icon, so Discord fetches nothing on its behalf.

### Content

- Game names go into code blocks. Backticks become `ˋ` and control characters become spaces, so a name cannot close the block or break a row. Names are clipped to 24 characters, by code point, so an emoji is never cut in half.
- The waiting reason, the only other free text, is clipped to 200 characters and goes through `escapeMarkdown`.
- Every request carries `allowed_mentions: { parse: [] }`.
- Field values stay within 1024 characters (a long section continues in further fields). With at most 32 games, the whole embed stays far below Discord's 6000-character cap.

### Failure isolation

- `StatusPanel` never throws out of a public method. `stop()` never rejects, aborts a request in flight, and resolves within 4 s. Both exit paths add it to the `Promise.all` they already await, so `process.exit` is always reached.
- One request in flight at a time, 4 s timeout, edits at least 5 s apart, one per minute otherwise.
- **401:** the panel stops for the run, and the notifier and bot already announce the rejected token. **Any other 4xx except 429:** one log line when the problem starts, naming the fix for 403 (permissions), 404 (channel gone) and Discord code 50006 (an empty message, i.e. the embed was stripped: Embed Links). Only the numeric error code is read from a failed reply, never its text. **429, 5xx and network errors:** silent, retried on the next tick.
- A stored box that this bot may not edit (403 on the edit, e.g. left by an earlier bot application) is replaced by a new post; a real permission problem still surfaces, because the post fails too.
- **Duplicates:** posts carry a `nonce` with `enforce_nonce: true`, reused across retries, so a post that timed out but landed is returned by Discord instead of duplicated (within Discord's few-minute window).
- Log lines carry only owner-facing text or `redactSecrets(err.message, [token])`, never a response body.

### Remaining risks

- A post retried after Discord's nonce window could create a second box; the stored ID then follows the newer one and the older stays behind.
- The status file and `statusChannelId` can be edited by anyone who can already edit `discord.json`; validation keeps their values to numeric IDs on discord.com.

### Validation

| Check | Outcome |
|---|---|
| `pnpm build` (`tsc`, strict) | Passed, 0 errors |
| Offline tests, `fetch` mocked, no network | 166/166 passed: the 114 earlier tests (expectations updated for the new `statusChannelId` field and invite value) plus 52 new: status store 6, embed and REST 16, panel 19, setup 11 |
| What the new tests cover | Tampered status files and `statusChannelId` values; hostile names (fences, `@everyone`, markdown, URLs, 300 characters, 32 games) within every limit; nonce reuse on retry; 401/403/404/empty-embeds handling and log-once; in-flight skipping and nudge coalescing; `stop()` within its cap while `fetch` hangs; no timers after stop; no token or URL in any log line |
| `index.ts` wiring | Checked by reading the code: the panel is created only in `startIdling`, and both exit paths await it before `process.exit` |
| Independent whole-branch review | No critical findings. 2 important (a 400 such as code 50006 was silent; an edit refused with 403 never fell back to a post) and 3 minor ones upgraded by effect (unclipped waiting reason, emoji split by clipping, setup 403 naming no fix): all fixed, each with a test that failed first. 2 minor deferred: a deduped post at shutdown can leave the box green, and an unreadable success reply is read as a hidden box |

**Not performed:** a real Discord channel and a live run. These are on the owner's checklist.

## 18. Addendum — Saved selection, split index.ts, no forced status (2026-10-25)

The selected games are now saved and restored on every start; favorites, the randomizer and the forced Online status are gone; `src/index.ts` is split into modules; the tests live in the repo with a GitHub Actions check. Design: `docs/superpowers/specs/2026-10-25-saved-selection-design.md`. Plan: `docs/superpowers/plans/2026-10-25-saved-selection.md`. Branch `saved-selection`. No new dependency; `pnpm-lock.yaml` is unchanged.

### The selection file

- `~/.steam-idler/selection-<account>.json` holds a version, a time and the selected games (appid and name). No secret. It is written atomically with `writeFileAtomic` and the default file mode (no owner-only mode, since it holds no secret, like the favorites file before it), and a failed write is logged, never thrown.
- **Validated on every load** (`src/storage/selection.ts`): an unreadable, non-JSON, non-object or unknown-version file is renamed to `selection-<account>.json.invalid` (replacing an older one) and treated as absent; single bad entries (appid not a positive integer, repeated) are dropped with a console line; more than 32 entries are cut to the first 32. A hand-edited file therefore cannot crash steamidler or push the selection past the cap.
- The old `favorites-<account>.json` is read only when no selection file exists, its exempt field is ignored, and it is never written. A favorites game missing from the library at migration is saved with the placeholder name `App <id>` until the selection next changes.
- Saved names come from an owner-editable file and are printed to the terminal as they are (local trust, the same as library names). Any text sent to Discord still goes through the existing escaping (`escapeMarkdown`, mentions disabled, embeds suppressed; code blocks in the status box).
- `/add` and `/remove` now write this file. The guards (`busyReason`) and the 32-game cap are unchanged. The first failed write in a run sends one Discord notice.

### Forced Online status (§6.1) resolved

steamidler no longer calls `setPersona`, so the status the owner sets in the Steam app stands and an Invisible setting is no longer overridden. §6.1 recorded why the original author added the call (the account showed offline after a relog). Whether hours still count without it is **unverified**; it is item 4 of the "Saved selection" checklist in `docs/live-tests.md`.

### CI workflow

`.github/workflows/ci.yml` runs on GitHub, not in steamidler, so the app gains no outbound destination.

- Actions pinned by commit: `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2) and `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0).
- `permissions: contents: read`, `persist-credentials: false`, no secrets.
- Install with `npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts`, then the offline test suite (`fetch` mocked, a fake Steam client).

### Validation

| Check | Outcome |
|---|---|
| `pnpm build` (`tsc`, strict) | Passed, 0 errors |
| Offline tests (`npx pnpm@10.34.6 test`) | 253/253 passed |
| `pnpm-lock.yaml` | Unchanged |
| Grep for `favorite`, `exempt`, `cooldown`, `randomizer`, `setPersona` | Only the migration code and its tests, `CHANGELOG.md`, older specs and plans, and the history sections of this file remain |

**Not performed:** a live run against Steam and Discord. The "Saved selection" checklist in `docs/live-tests.md` is the owner's.
