# Runbook: steamidler on a Linux VPS

How to run, update and fix steamidler once it is installed as a systemd service. Installation is in the README's [Running 24/7 on a Linux VPS](../README.md#running-247-on-a-linux-vps); what each exit code means is in its [Headless mode](../README.md#headless-mode) section, and each Discord message in [Messages](../README.md#messages).

The commands below assume the README's setup: the service `steamidler`, the code in `/opt/steamidler`, and the service user `steamidler`. Adjust them if your unit file says otherwise. The unit file has not yet been tested on a live server; [live-tests.md](live-tests.md) has the checklist.

## Everyday commands

```bash
journalctl -u steamidler -f              # Follow the log
journalctl -u steamidler -n 200          # The last 200 lines
systemctl status steamidler              # Running or not, and the last exit status
sudo systemctl restart steamidler        # Restart (Discord /add and /remove changes reset to your favorites)
sudo systemctl stop steamidler           # Stop; "🛑 Idling stopped" is posted to Discord
```

## Log in to Steam again

Needed after a dead token, a `--logout`, or a leaked token.

1. Stop the service first. Two copies logged in at once keep taking each other's Steam session.

   ```bash
   sudo systemctl stop steamidler
   ```

2. Run it interactively as the service user over SSH: log in with the QR code, check your favorites (star with `F`), start idling with `Enter`, then quit with `Q`:

   ```bash
   sudo -u steamidler -H node /opt/steamidler/dist/index.js
   ```

3. Start the service again: `sudo systemctl start steamidler`.

## When it stops

Find the matching row by what Discord said and what `systemctl status steamidler` shows.

| Discord says | Exit status | Cause | Fix |
|---|---|---|---|
| 🛑 Headless start failed — No stored login found… | 2 | No saved Steam login: never logged in, `--logout`, or a dead token was cleared | [Log in to Steam again](#log-in-to-steam-again) |
| 🛑 Headless start failed — No favorites configured… or No matching games found for your favorites. | 2 | No starred games, or none of them are in the library any more | Run it interactively as the service user (step 2 above), star games with `F`, quit, start the service |
| 🛑 Headless start failed — *a Steam error* | 2 | Expired or revoked token, a banned or locked account, or a protocol mismatch (exit status 1 instead means a passing error: systemd retries on its own) | For a token: [log in again](#log-in-to-steam-again). For an account problem: check the account on the Steam website first. For a protocol mismatch: [update](#update-to-a-new-release) |
| 🛑 Idling stopped — *a Steam error*. Manual re-login required. | 0 | The running session hit an error retrying cannot fix. A dead token is cleared, so the next start fails with "No stored login found" | Same as the row above. The service exits cleanly here, so systemd does not restart it |
| 🛑 Idling stopped — failed to reconnect after 30× … | 1 | A long Steam or network outage | Nothing: systemd restarts it after 10 s. Check the log if it keeps happening |
| 🛑 Idling stopped — rate-limited 10× … | 1 | Steam is refusing logons for a while | Nothing: systemd restarts it, and the new start waits out the limit itself (⏸️ Headless start rate-limited by Steam). Restarting it by hand only extends Steam's lockout |
| 🛑 Headless start failed — No matching games found — library incomplete… | 1 | Steam was slow to send license data at boot | Nothing: systemd restarts it |

Exit status 0 after a plain "🛑 Idling stopped" is a normal stop (`systemctl stop`, a reboot).

## Discord problems

Discord problems never stop idling; they only stop the messages, commands or status box.

- **⚠️ Discord bot offline, token rejected:** reset the token in the Developer Portal, run `--setup-discord` as the service user with the new one, then restart the service.
- **⚠️ Discord bot offline, lost access to the channel:** give the bot its permissions back in that channel, or rerun `--setup-discord` and pick another one.
- **Status box missing or not updating:** the log names the fix. Usually the bot lacks Embed Links in the status channel.
- **No messages at all and no backup webhook:** they go to the journal instead, so look there.

Run setup as the service user, with the service stopped, then start it again:

```bash
sudo systemctl stop steamidler
sudo -u steamidler -H node /opt/steamidler/dist/index.js --setup-discord
sudo systemctl start steamidler
```

## A secret leaked

- **Steam refresh token** (`credentials.json`): on the Steam website, Account details → Manage Steam Guard → **Deauthorize all other devices**. Then stop the service, run `sudo -u steamidler -H node /opt/steamidler/dist/index.js --logout`, and [log in to Steam again](#log-in-to-steam-again).
- **Discord bot token** (`discord.json`): **Reset Token** in the Developer Portal, then rerun `--setup-discord` as above.
- **Backup webhook URL** (`discord.json`): delete the webhook in Discord, create a new one, then rerun `--setup-discord` as above.

## Update to a new release

Check [CHANGELOG.md](../CHANGELOG.md) for the new release, then switch to its tag (`v0.2.0` below is an example), rebuild and restart:

```bash
cd /opt/steamidler
sudo git fetch --tags
sudo git checkout v0.2.0
sudo npx pnpm@10.34.6 install --frozen-lockfile --ignore-scripts
sudo npx pnpm@10.34.6 build
sudo systemctl restart steamidler
```

Watch the log for a minute afterwards, and check that "▶️ Idling started" arrives.

## Roll back

Run the same commands with the previous tag in place of the new one. Your files in `~/.steam-idler/` carry over. Going back to v0.1.0 is safe: it ignores the status channel setting, so the status box simply stops updating.
