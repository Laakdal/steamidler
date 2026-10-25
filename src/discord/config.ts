import { existsSync, readFileSync, chmodSync } from 'node:fs';
import { writeFileAtomic } from '../storage/atomicWrite.js';
import { dataPath, ensureDataDir } from '../storage/paths.js';

export const CONFIG_PATH = dataPath('discord.json');

export interface BotConfig {
  token: string;
  applicationId: string;
  ownerId: string;
  guildId: string;
  channelId: string;
  // Channel holding the live status box; null when the owner chose none
  statusChannelId: string | null;
}

export interface DiscordConfig {
  bot: BotConfig | null;
  webhookUrl: string | null;
  disabled: boolean;
}

const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
const WEBHOOK_PATH = /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+\/?$/;

// Guards every ID field so a hand-edited file cannot smuggle odd values into URLs
export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

// Shape check only (three dot-separated segments); Discord is the real validator
export function isBotTokenShape(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{18,}\.[\w-]{4,}\.[\w-]{25,}$/.test(value);
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

// Reports an unusable file by path only, never by value (it holds secrets)
function invalid(reason: string): null {
  console.error(`Ignoring ${CONFIG_PATH}: ${reason} — run --setup-discord again.`);
  return null;
}

// Loads and re-validates the file on every call: a hand-edited file must never
// redirect notifications to another host, and the bot fields are all-or-nothing.
// Invalid counts as "no config" so the next interactive run offers setup again.
export function loadDiscordConfig(): DiscordConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  // Tokens inside: tighten a file left readable by others (no effect on Windows)
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Without POSIX permissions there is nothing to tighten
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return invalid('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('not a JSON object');
  const file = raw as Record<string, unknown>;

  const botKeys = ['botToken', 'applicationId', 'ownerId', 'guildId', 'channelId'];
  const present = botKeys.filter((k) => file[k] !== undefined).length;
  let bot: BotConfig | null = null;
  if (present > 0) {
    if (
      present !== botKeys.length ||
      !isBotTokenShape(file.botToken) ||
      !isSnowflake(file.applicationId) ||
      !isSnowflake(file.ownerId) ||
      !isSnowflake(file.guildId) ||
      !isSnowflake(file.channelId) ||
      // Optional, but a present value must be an ID like the others
      (file.statusChannelId !== undefined && !isSnowflake(file.statusChannelId))
    ) {
      return invalid('bot settings are incomplete or malformed');
    }
    bot = {
      token: file.botToken,
      applicationId: file.applicationId,
      ownerId: file.ownerId,
      guildId: file.guildId,
      channelId: file.channelId,
      statusChannelId: file.statusChannelId ?? null,
    };
  }

  let webhookUrl: string | null = null;
  if (file.webhookUrl !== undefined) {
    webhookUrl = typeof file.webhookUrl === 'string' ? parseWebhookUrl(file.webhookUrl) : null;
    if (!webhookUrl) return invalid('not a Discord webhook URL');
  }
  return { bot, webhookUrl, disabled: file.disabled === true };
}

// Writes the file; a read-only config dir is reported and returns false, never throws
function writeConfigFile(contents: Record<string, unknown>): boolean {
  try {
    ensureDataDir();
    writeFileAtomic(CONFIG_PATH, JSON.stringify(contents, null, 2), 0o600);
    return true;
  } catch (err) {
    console.error(`Could not save ${CONFIG_PATH}: ${(err as Error).message}`);
    return false;
  }
}

// Persists the bot and/or webhook settings in the flat on-disk format
export function saveDiscordConfig(config: { bot: BotConfig | null; webhookUrl: string | null }): boolean {
  const out: Record<string, unknown> = {};
  if (config.bot) {
    out.botToken = config.bot.token;
    out.applicationId = config.bot.applicationId;
    out.ownerId = config.bot.ownerId;
    out.guildId = config.bot.guildId;
    out.channelId = config.bot.channelId;
    if (config.bot.statusChannelId) out.statusChannelId = config.bot.statusChannelId;
  }
  if (config.webhookUrl) out.webhookUrl = config.webhookUrl;
  return writeConfigFile(out);
}

// Marks Discord as explicitly skipped so we don't re-prompt on next interactive run
export function saveDiscordDisabled(): boolean {
  return writeConfigFile({ disabled: true });
}
