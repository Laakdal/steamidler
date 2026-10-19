import { existsSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { password as passwordPrompt } from '@inquirer/prompts';
import chalk from 'chalk';
import { writeFileAtomic } from '../storage/atomicWrite.js';

const CONFIG_DIR = join(homedir(), '.steam-idler');
const CONFIG_PATH = join(CONFIG_DIR, 'discord.json');

export interface DiscordConfig {
  webhookUrl?: string;
  disabled?: boolean;
}

// Discord rejects message content longer than this
const MAX_CONTENT_LENGTH = 2000;
const SEND_TIMEOUT_MS = 5000;
const SETUP_FETCH_TIMEOUT_MS = 10_000;
// SUPPRESS_EMBEDS: a URL inside an error message must not unfurl into a preview
const FLAG_SUPPRESS_EMBEDS = 1 << 2;
const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
const WEBHOOK_PATH = /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+\/?$/;

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function loadDiscordConfig(): DiscordConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  // The webhook URL embeds its token; keep the file owner-only where supported.
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Platforms without POSIX perms (or a perms error) — best effort only.
  }
  let config: DiscordConfig;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as DiscordConfig;
  } catch {
    return null;
  }
  // Re-validated on every load, not just at setup: a hand-edited file must
  // never redirect notifications to another host. An invalid URL counts as
  // "no config" so the next interactive run offers setup again.
  if (config.webhookUrl !== undefined) {
    const webhookUrl = typeof config.webhookUrl === 'string' ? parseWebhookUrl(config.webhookUrl) : null;
    if (!webhookUrl) {
      console.error(`Ignoring ${CONFIG_PATH}: not a Discord webhook URL — run --setup-discord again.`);
      return null;
    }
    config.webhookUrl = webhookUrl;
  }
  return config;
}

// Writes the config file; a read-only config dir is reported, not fatal
function writeDiscordConfig(config: DiscordConfig): void {
  try {
    ensureConfigDir();
    writeFileAtomic(CONFIG_PATH, JSON.stringify(config, null, 2), 0o600);
  } catch (err) {
    console.error(`Could not save ${CONFIG_PATH}: ${(err as Error).message}`);
  }
}

// Marks Discord as explicitly skipped so we don't re-prompt on next interactive run
export function saveDiscordDisabled(): void {
  writeDiscordConfig({ disabled: true });
}

// Accepts only https Discord webhook URLs, so a typo or a pasted lookalike can
// never send idling updates to another host. Returns a URL rebuilt from the
// validated parts (only thread_id survives from the query, for forum channels),
// or null when the input is not a webhook URL.
export function parseWebhookUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (!WEBHOOK_HOSTS.has(url.hostname) || !WEBHOOK_PATH.test(url.pathname)) return null;
  const threadId = url.searchParams.get('thread_id');
  if (threadId !== null && !/^\d+$/.test(threadId)) return null;
  const base = `https://${url.hostname}${url.pathname.replace(/\/$/, '')}`;
  return threadId ? `${base}?thread_id=${threadId}` : base;
}

// Every message is meant as plain text, but Discord renders markdown and masked
// links, so a game name or error string could otherwise format or link itself.
// Inline markers are escaped everywhere; heading, list and quote markers only
// act at the start of a line, so they are escaped only there.
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|[\]]/g, '\\$&').replace(/^(\s*)([#>-])/gm, '$1\\$2');
}

// Splits text into chunks Discord accepts, breaking at line boundaries where
// possible so a long daily report arrives as consecutive readable messages.
export function splitMessage(text: string, max = MAX_CONTENT_LENGTH): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > max) {
      if (current) chunks.push(current);
      current = '';
      chunks.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    const candidate = current ? `${current}\n${rest}` : rest;
    if (candidate.length > max) {
      chunks.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  // Discord rejects empty or whitespace-only content
  return chunks.filter((c) => c.trim().length > 0);
}

// One webhook post. allowed_mentions with no parse types keeps a game name
// like "@everyone" from pinging the channel.
function postContent(webhookUrl: string, content: string, timeoutMs: number): Promise<Response> {
  return fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: FLAG_SUPPRESS_EMBEDS }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export class DiscordNotifier {
  private config: DiscordConfig | null = null;

  constructor() {
    this.reload();
  }

  reload(): void {
    this.config = loadDiscordConfig();
  }

  isConfigured(): boolean {
    return !!this.config?.webhookUrl && !this.config?.disabled;
  }

  hasFile(): boolean {
    return this.config !== null;
  }

  // Fire-and-forget — never throws, never blocks the idler. The returned
  // promise settles once every part is done (never rejects, even if one part
  // fails) so shutdown can give the final message a chance to land. A non-2xx
  // reply (deleted webhook) is logged so it does not fail silently. The URL
  // is never logged: it embeds the webhook token.
  send(text: string): Promise<void> {
    if (!this.isConfigured()) return Promise.resolve();
    const webhookUrl = this.config!.webhookUrl!;
    // Sequential so a multi-part message arrives in order
    return splitMessage(escapeMarkdown(text)).reduce<Promise<void>>(
      (prev, chunk) =>
        prev.then(() =>
          postContent(webhookUrl, chunk, SEND_TIMEOUT_MS)
            .then((res) => {
              if (!res.ok) {
                console.error(`[discord] send rejected: HTTP ${res.status} — check the webhook URL`);
              }
            })
            .catch((err) => {
              console.error(`[discord] send failed: ${(err as Error).message}`);
            })
        ),
      Promise.resolve()
    );
  }
}

interface WebhookInfo {
  name?: string;
}

export async function runDiscordSetup(): Promise<void> {
  console.log(chalk.cyan.bold('\n  Setup Discord notifications\n'));
  console.log(chalk.gray('  1. In Discord: Server Settings → Integrations → Webhooks → New Webhook.'));
  console.log(chalk.gray('  2. Pick the channel for notifications, then Copy Webhook URL.'));
  console.log(chalk.gray('  3. Paste the URL below.\n'));

  const raw = await passwordPrompt({ message: 'Webhook URL:', mask: '*' });
  const webhookUrl = parseWebhookUrl(raw);
  if (!webhookUrl) {
    throw new Error('Not a Discord webhook URL (expected https://discord.com/api/webhooks/...)');
  }

  // GET on a webhook URL returns its metadata without posting anything. The
  // reply also carries the token, so only the name is ever printed.
  const infoRes = await fetch(webhookUrl, { signal: AbortSignal.timeout(SETUP_FETCH_TIMEOUT_MS) });
  if (!infoRes.ok) {
    throw new Error(`Discord rejected the webhook: HTTP ${infoRes.status}`);
  }
  const info = (await infoRes.json()) as WebhookInfo;

  // Saved only after a real post lands, so a broken webhook is never stored
  const testRes = await postContent(
    webhookUrl,
    '✅ steamidled notifications enabled.',
    SETUP_FETCH_TIMEOUT_MS
  );
  if (!testRes.ok) {
    throw new Error(`Test message rejected by Discord: HTTP ${testRes.status}`);
  }

  writeDiscordConfig({ webhookUrl });

  console.log(chalk.green(`\n  ✓ Webhook "${info.name ?? 'webhook'}" works — check the channel for the test message`));
  console.log(chalk.green('  ✓ Saved to ~/.steam-idler/discord.json\n'));
}
