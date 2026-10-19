# Security Audit — steamidled v1.2.0

| | |
|---|---|
| **Repository** | https://github.com/louisraetz/steamidled |
| **Commit audited** | `9f2b1ab` (chore: release v1.2.0) |
| **Audit date** | 2026-10-18 |
| **Target platform** | Windows 11 |
| **Method** | Static analysis only — the application was never executed and no dependencies were installed |

> **Local modification (2026-10-18):** Telegram notifications were removed and replaced with Discord webhooks after this audit. Sections below describe upstream v1.2.0 as audited; see **§13 Addendum** for what changed, the new network destination, and the effect on findings. Docker support was removed on 2026-10-19 (**§14**). This local build is **no longer identical** to the published npm package.

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
