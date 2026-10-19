import type { BotConfig } from './config.js';

export const API_BASE = 'https://discord.com/api/v10';
const DEFAULT_TIMEOUT_MS = 10_000;
// SUPPRESS_EMBEDS: a URL inside an error message must not unfurl into a preview
const FLAG_SUPPRESS_EMBEDS = 1 << 2;

// Carries only the HTTP status and a caller-written message, never a response
// body or the token, so it is always safe to log.
export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

// One authenticated REST call through built-in fetch, aborted after timeoutMs
export function discordApi(
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bot ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// allowed_mentions with no parse types keeps a game name like "@everyone" from
// pinging the channel; embeds are suppressed so URLs stay plain text.
function messageBody(content: string): { content: string; allowed_mentions: { parse: never[] }; flags: number } {
  return { content, allowed_mentions: { parse: [] }, flags: FLAG_SUPPRESS_EMBEDS };
}

// Posts one message to the configured channel as the bot
export function postChannelMessage(
  token: string,
  channelId: string,
  content: string,
  timeoutMs: number
): Promise<Response> {
  return discordApi(token, 'POST', `/channels/${channelId}/messages`, messageBody(content), timeoutMs);
}

// Posts one message through a webhook URL (the URL itself is the credential)
export function postWebhook(webhookUrl: string, content: string, timeoutMs: number): Promise<Response> {
  return fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messageBody(content)),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// Slash commands; default_member_permissions "0" hides them from everyone but
// admins by default (the owner check in the handler is the real gate).
export const COMMANDS: readonly unknown[] = [
  {
    name: 'add',
    type: 1,
    description: 'Start idling a game',
    default_member_permissions: '0',
    options: [{ type: 3, name: 'game', description: 'Game name or app ID', required: true, autocomplete: true }],
  },
  {
    name: 'remove',
    type: 1,
    description: 'Stop idling a game',
    default_member_permissions: '0',
    options: [{ type: 3, name: 'game', description: 'Game name or app ID', required: true, autocomplete: true }],
  },
  {
    name: 'status',
    type: 1,
    description: 'Show what is being idled',
    default_member_permissions: '0',
  },
];

// Replaces the guild's command set (idempotent bulk overwrite)
export function registerCommands(bot: BotConfig): Promise<Response> {
  return discordApi(bot.token, 'PUT', `/applications/${bot.applicationId}/guilds/${bot.guildId}/commands`, COMMANDS);
}
