import { loadDiscordConfig, type BotConfig, type DiscordConfig } from './config.js';
import { escapeMarkdown, redactSecrets, splitMessage } from './format.js';
import { postChannelMessage, postWebhook } from './rest.js';

export interface NotifierOptions {
  botTimeoutMs?: number;
  webhookTimeoutMs?: number;
}

// Why the bot is offline, worded for the owner; shared with the Gateway code
export const BOT_DOWN_REASONS = {
  tokenRejected: 'token rejected — reset it in the Developer Portal, run --setup-discord, then restart steamidler',
  noPermission:
    "no permission to post in the notification channel — fix the bot's channel permissions, then restart steamidler",
  channelNotFound: 'notification channel not found — run --setup-discord, then restart steamidler',
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
  // The Gateway is back but the online notice failed: sends try the bot first
  private recoveryPending = false;
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
    this.recoveryPending = false;
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

  // Never rejects and is time-bounded (each part: bot timeout + one shared webhook timeout),
  // so shutdown paths can await it. Parts go out sequentially to keep order.
  async send(text: string): Promise<void> {
    try {
      if (!this.isConfigured()) return;
      for (const part of splitMessage(escapeMarkdown(text))) {
        await this.deliver(part);
      }
    } catch (err) {
      console.error(`[discord] send failed: ${this.errorText(err)}`);
    }
  }

  // Called when the bot cannot work (Gateway outage, rejected token); commands
  // stop working too, since they arrive over the Gateway.
  async botDown(reason: string, fatal: boolean): Promise<void> {
    await this.markDown(reason, fatal, true);
  }

  // Shared by botDown and the failover path; deadline (ms epoch) caps the
  // webhook time so the notice and the failed part share one webhook budget.
  // Announces once per outage, plus once more if the outage turns fatal, since
  // a fatal cause (token rejected) needs the owner to act.
  private async markDown(reason: string, fatal: boolean, commandsAffected: boolean, deadline?: number): Promise<void> {
    try {
      if (!this.isConfigured() || !this.botConfig()) return;
      if (this.route === 'fatal') return;
      // A new fault cancels any recovery left over from the previous outage, so a
      // working REST post during a Gateway outage never claims commands are back
      this.recoveryPending = false;
      const hasWebhook = !!this.config?.webhookUrl;
      if (!fatal && !hasWebhook) {
        // Nowhere else to send: keep trying the bot, which may recover by itself
        console.error(`[discord] bot problem: ${reason} (no backup webhook)`);
        return;
      }
      if (this.route === 'down' && !fatal) return;
      this.route = fatal ? 'fatal' : 'down';
      const route = hasWebhook
        ? 'Notifications are coming through the backup webhook.'
        : "Notifications can't reach Discord until this is fixed.";
      const commands = commandsAffected ? " /add, /remove and /status won't work until the bot is back." : '';
      const notice = `⚠️ Discord bot offline (${reason}). ${route}${commands}`;
      for (const part of splitMessage(escapeMarkdown(notice))) {
        await this.deliverViaWebhook(part, deadline);
      }
    } catch (err) {
      console.error(`[discord] send failed: ${this.errorText(err)}`);
    }
  }

  // Called when the Gateway reconnects after a non-fatal outage. If the online
  // notice cannot be posted yet, the next send retries the bot instead of
  // staying on the webhook until another outage.
  async botUp(): Promise<void> {
    try {
      const bot = this.botConfig();
      if (!bot || this.route !== 'down') return;
      try {
        await this.postOnlineNotice(bot);
      } catch {
        // Only if nothing changed the route meanwhile (a new fault, a fatal close)
        if (this.route === 'down') this.recoveryPending = true;
        return;
      }
      if (this.route !== 'down') return;
      this.route = 'up';
      this.recoveryPending = false;
    } catch (err) {
      console.error(`[discord] send failed: ${this.errorText(err)}`);
    }
  }

  // Posts the recovery notice through the bot; throws PostFailure like postBot
  private async postOnlineNotice(bot: BotConfig): Promise<void> {
    for (const part of splitMessage(escapeMarkdown('✅ Discord bot back online. Commands work again.'))) {
      await this.postBot(bot, part);
    }
  }

  // One bot post; throws PostFailure on timeout, network error or non-2xx
  private async postBot(bot: BotConfig, part: string): Promise<void> {
    let res: Response;
    try {
      res = await postChannelMessage(bot.token, bot.channelId, part, this.botTimeoutMs);
    } catch (err) {
      throw new PostFailure(undefined, this.errorText(err));
    }
    if (!res.ok) throw new PostFailure(res.status, `HTTP ${res.status}`);
  }

  // Sends one part along the current route, failing over to the webhook.
  // Worst case per part is one bot timeout plus one webhook timeout.
  private async deliver(part: string): Promise<void> {
    const bot = this.botConfig();
    const recovering = this.route === 'down' && this.recoveryPending;
    if ((this.route === 'up' || recovering) && bot) {
      try {
        await this.postBot(bot, part);
      } catch (err) {
        const failure = err as PostFailure;
        console.error(`[discord] bot post failed: ${failure.message}`);
        const reason = failure.status === undefined ? null : this.reasonForStatus(failure.status);
        // A definite refusal ends the recovery attempts; a timeout or 5xx retries next send
        if (recovering && reason) this.recoveryPending = false;
        // One webhook budget covers the offline notice and this part
        const deadline = Date.now() + this.webhookTimeoutMs;
        if (reason) await this.markDown(reason.text, reason.fatal, reason.commandsAffected, deadline);
        await this.deliverViaWebhook(part, deadline);
        return;
      }
      // Re-read after the await: a concurrent send may have switched back already,
      // or a new fault or fatal close may have landed during the post
      if (recovering && this.route === 'down' && this.recoveryPending) {
        // The bot works again: switch back, then announce it (one bot timeout)
        this.route = 'up';
        this.recoveryPending = false;
        try {
          await this.postOnlineNotice(bot);
        } catch (err) {
          console.error(`[discord] bot post failed: ${(err as PostFailure).message}`);
        }
      }
      return;
    }
    await this.deliverViaWebhook(part);
  }

  // A fetch error can quote the request URL (the webhook URL embeds its token),
  // so logged error text has the bot token and every URL cut out.
  private errorText(err: unknown): string {
    const token = this.config?.bot?.token;
    return redactSecrets(err instanceof Error ? err.message : String(err), token ? [token] : []);
  }

  // Maps an HTTP status that means "the bot is unusable" to its owner-facing
  // reason. A lost channel leaves commands working: they need no channel access.
  private reasonForStatus(status: number): { text: string; fatal: boolean; commandsAffected: boolean } | null {
    if (status === 401) return { text: BOT_DOWN_REASONS.tokenRejected, fatal: true, commandsAffected: true };
    if (status === 403) return { text: BOT_DOWN_REASONS.noPermission, fatal: false, commandsAffected: false };
    if (status === 404) return { text: BOT_DOWN_REASONS.channelNotFound, fatal: false, commandsAffected: false };
    return null;
  }

  // Last-resort delivery: the webhook if there is one, else the console. Logs
  // carry only a status or error message, never the URL or token.
  private async deliverViaWebhook(part: string, deadline?: number): Promise<void> {
    const webhookUrl = this.config?.webhookUrl;
    if (!webhookUrl) {
      console.error(`[discord] undelivered (no webhook): ${part}`);
      return;
    }
    const remaining = deadline === undefined ? this.webhookTimeoutMs : deadline - Date.now();
    if (remaining < 1) {
      console.error('[discord] send failed: webhook time budget exhausted');
      return;
    }
    try {
      const res = await postWebhook(webhookUrl, part, remaining);
      if (!res.ok) console.error(`[discord] send rejected: HTTP ${res.status} — check the webhook URL`);
    } catch (err) {
      console.error(`[discord] send failed: ${this.errorText(err)}`);
    }
  }
}
