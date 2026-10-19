import { loadDiscordConfig, type BotConfig, type DiscordConfig } from './config.js';
import { escapeMarkdown, splitMessage } from './format.js';
import { postChannelMessage, postWebhook } from './rest.js';

export interface NotifierOptions {
  botTimeoutMs?: number;
  webhookTimeoutMs?: number;
}

// Why the bot is offline, worded for the owner; shared with the Gateway code
export const BOT_DOWN_REASONS = {
  tokenRejected: 'token rejected — reset it in the Developer Portal, run --setup-discord, then restart steamidled',
  noPermission:
    "no permission to post in the notification channel — fix the bot's channel permissions, then restart steamidled",
  channelNotFound: 'notification channel not found — run --setup-discord, then restart steamidled',
  gatewayUnreachable: "can't reach Discord for 2 min",
  intentsRejected: 'gateway intents rejected by Discord',
  gatewayRejected: (code: number): string => `gateway connection rejected (code ${code})`,
};

type BotRoute = 'up' | 'down' | 'fatal' | 'none';

const DEFAULT_TIMEOUT_MS = 4000;

// Carries the HTTP status of a failed post (undefined for network errors/timeouts)
class PostFailure extends Error {
  constructor(
    public readonly status: number | undefined,
    message: string
  ) {
    super(message);
  }
}

// Routes notifications through the bot, falling back to the webhook (or the
// console) so a bot outage never swallows a message. Nothing here rejects.
export class DiscordNotifier {
  private config: DiscordConfig | null = null;
  private route: BotRoute = 'none';
  private readonly botTimeoutMs: number;
  private readonly webhookTimeoutMs: number;

  constructor(options: NotifierOptions = {}) {
    this.botTimeoutMs = options.botTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.webhookTimeoutMs = options.webhookTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.reload();
  }

  // Re-reads the config file (after first-run setup) and resets the bot route
  reload(): void {
    this.config = loadDiscordConfig();
    this.route = this.config?.bot && !this.config.disabled ? 'up' : 'none';
  }

  // A config file exists and loaded; the first-run prompt keys off its absence
  hasFile(): boolean {
    return this.config !== null;
  }

  // Something to deliver to: a bot or a webhook, and not switched off
  isConfigured(): boolean {
    return !!this.config && !this.config.disabled && (!!this.config.bot || !!this.config.webhookUrl);
  }

  // The bot settings, or null when there are none or Discord is disabled
  botConfig(): BotConfig | null {
    return this.config && !this.config.disabled ? this.config.bot : null;
  }

  // Never rejects and is time-bounded (each part: bot timeout + webhook timeout),
  // so shutdown paths can await it. Parts go out sequentially to keep order.
  async send(text: string): Promise<void> {
    try {
      if (!this.isConfigured()) return;
      for (const part of splitMessage(escapeMarkdown(text))) {
        await this.deliver(part);
      }
    } catch (err) {
      console.error(`[discord] send failed: ${(err as Error).message}`);
    }
  }

  // Called when the bot cannot work; announces once per outage via the webhook
  async botDown(reason: string, fatal: boolean): Promise<void> {
    try {
      if (!this.isConfigured() || !this.botConfig()) return;
      if (this.route === 'fatal') return;
      if (this.route === 'down') {
        // Already announced; a later fatal cause only changes whether botUp may restore it
        if (fatal) this.route = 'fatal';
        return;
      }
      this.route = fatal ? 'fatal' : 'down';
      await this.send(
        `⚠️ Discord bot offline (${reason}). Notifications are coming through the backup webhook. /add, /remove and /status won't work until the bot is back.`
      );
    } catch (err) {
      console.error(`[discord] send failed: ${(err as Error).message}`);
    }
  }

  // Called when the Gateway reconnects after a non-fatal outage
  async botUp(): Promise<void> {
    try {
      const bot = this.botConfig();
      if (!bot || this.route !== 'down') return;
      for (const part of splitMessage(escapeMarkdown('✅ Discord bot back online. Commands work again.'))) {
        await this.postBot(bot, part);
      }
      this.route = 'up';
    } catch {
      // Stay down silently; the next botUp gets another chance
    }
  }

  // One bot post; throws PostFailure on timeout, network error or non-2xx
  private async postBot(bot: BotConfig, part: string): Promise<void> {
    let res: Response;
    try {
      res = await postChannelMessage(bot.token, bot.channelId, part, this.botTimeoutMs);
    } catch (err) {
      throw new PostFailure(undefined, (err as Error).message);
    }
    if (!res.ok) throw new PostFailure(res.status, `HTTP ${res.status}`);
  }

  // Sends one part along the current route, failing over to the webhook
  private async deliver(part: string): Promise<void> {
    const bot = this.botConfig();
    if (this.route === 'up' && bot) {
      try {
        await this.postBot(bot, part);
        return;
      } catch (err) {
        const failure = err as PostFailure;
        console.error(`[discord] bot post failed: ${failure.message}`);
        const reason = failure.status === undefined ? null : this.reasonForStatus(failure.status);
        if (reason) await this.botDown(reason.text, reason.fatal);
      }
    }
    await this.deliverViaWebhook(part);
  }

  // Maps an HTTP status that means "the bot is unusable" to its owner-facing reason
  private reasonForStatus(status: number): { text: string; fatal: boolean } | null {
    if (status === 401) return { text: BOT_DOWN_REASONS.tokenRejected, fatal: true };
    if (status === 403) return { text: BOT_DOWN_REASONS.noPermission, fatal: false };
    if (status === 404) return { text: BOT_DOWN_REASONS.channelNotFound, fatal: false };
    return null;
  }

  // Last-resort delivery: the webhook if there is one, else the console. Logs
  // carry only a status or error message, never the URL or token.
  private async deliverViaWebhook(part: string): Promise<void> {
    const webhookUrl = this.config?.webhookUrl;
    if (!webhookUrl) {
      console.error(`[discord] undelivered (no webhook): ${part}`);
      return;
    }
    try {
      const res = await postWebhook(webhookUrl, part, this.webhookTimeoutMs);
      if (!res.ok) console.error(`[discord] send rejected: HTTP ${res.status} — check the webhook URL`);
    } catch (err) {
      console.error(`[discord] send failed: ${(err as Error).message}`);
    }
  }
}
