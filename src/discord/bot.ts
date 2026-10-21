import {
  Client,
  DiscordjsErrorCodes,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { BotConfig } from './config.js';
import { escapeMarkdown, redactSecrets, splitMessage } from './format.js';
import { FATAL_CLOSE_CODES, GatewayHealth } from './health.js';
import { BOT_DOWN_REASONS, type DiscordNotifier } from './notifier.js';
import { registerCommands } from './rest.js';
import {
  NOT_ALLOWED_REPLY,
  formatStatus,
  isAuthorized,
  runAdd,
  runRemove,
  suggestAdd,
  suggestRemove,
  type ControlPanel,
} from './commands.js';

export interface BotHandle {
  destroy(): Promise<void>;
}

// discord.js never retries a login that failed before the Gateway opened (e.g.
// the VPS network not up yet at boot), so we do, slowly enough to never hammer.
const LOGIN_RETRY_MIN_MS = 30_000;
const LOGIN_RETRY_MAX_MS = 5 * 60_000;

// discord.js errors can quote interaction callback URLs, which carry the
// interaction token, so only the redacted message is ever logged.
function safeMessage(err: unknown, token: string): string {
  return redactSecrets(err instanceof Error ? err.message : String(err), [token]);
}

// Ephemeral, mention-free, markdown-escaped reply, split so a long /status
// still fits Discord's 2000-character limit.
async function replyPrivately(interaction: ChatInputCommandInteraction, text: string): Promise<void> {
  const [first, ...rest] = splitMessage(escapeMarkdown(text));
  await interaction.reply({ content: first, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  for (const part of rest) {
    await interaction.followUp({ content: part, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
}

// Owner check first, for autocomplete too, so nobody else can even list the library.
async function handleInteraction(interaction: Interaction, bot: BotConfig, panel: ControlPanel): Promise<void> {
  const allowed = isAuthorized({ userId: interaction.user.id, guildId: interaction.guildId }, bot);

  if (interaction.isAutocomplete()) {
    if (!allowed) return interaction.respond([]);
    const query = String(interaction.options.getFocused());
    if (interaction.commandName === 'add') return interaction.respond(suggestAdd(panel, query));
    if (interaction.commandName === 'remove') return interaction.respond(suggestRemove(panel, query));
    return interaction.respond([]);
  }

  if (!interaction.isChatInputCommand()) return;
  if (!allowed) return replyPrivately(interaction, NOT_ALLOWED_REPLY);

  let text: string;
  if (interaction.commandName === 'add') text = runAdd(panel, interaction.options.getString('game', true));
  else if (interaction.commandName === 'remove') text = runRemove(panel, interaction.options.getString('game', true));
  else if (interaction.commandName === 'status') text = formatStatus(panel, new Date());
  else text = 'Unknown command.';
  await replyPrivately(interaction, text);
}

// Connects the bot to the Gateway and answers commands. Runs in the background
// and never throws or rejects: process-level handlers would treat a stray
// Discord rejection as a crash and stop idling.
export function startBot(bot: BotConfig, panel: ControlPanel, notifier: DiscordNotifier): BotHandle {
  let destroyed = false;
  // Set once Discord has refused the token or the connection for good; no retry can help
  let fatal = false;
  let client: Client | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryDelayMs = LOGIN_RETRY_MIN_MS;

  const log = (what: string, err: unknown): void => {
    console.error(`[discord] ${what}: ${safeMessage(err, bot.token)}`);
  };

  const health = new GatewayHealth(
    (reason, isFatal) => void notifier.botDown(reason, isFatal),
    () => void notifier.botUp()
  );

  // Marks the bot permanently down so no further login is attempted this run.
  const reportFatal = (reason: string): void => {
    fatal = true;
    void notifier.botDown(reason, true);
  };

  // A Client whose login failed has destroyed itself and cannot be fully
  // revived (discord.js never clears its destroyed flag), so every attempt
  // gets a fresh one with the full set of listeners.
  const createClient = (): Client => {
    const c = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
    // discord.js emits shardDisconnect only for close codes it will not recover
    // from; every other close shows up as shardReconnecting.
    c.on(Events.ShardDisconnect, (event) => {
      if (FATAL_CLOSE_CODES.has(event.code)) fatal = true;
      health.disconnected(event.code);
    });
    c.on(Events.ShardReconnecting, () => health.disconnected(null));
    c.on(Events.ShardReady, () => {
      retryDelayMs = LOGIN_RETRY_MIN_MS;
      health.ready();
    });
    c.on(Events.ShardResume, () => health.ready());
    // Without an error listener an EventEmitter 'error' would throw
    c.on(Events.Error, (err) => log('client error', err));
    c.on(Events.ShardError, (err) => log('gateway error', err));
    c.on(Events.InteractionCreate, (interaction) => {
      handleInteraction(interaction, bot, panel).catch((err: unknown) => log('command reply failed', err));
    });
    return c;
  };

  // A rejected token or fatal close is final; anything else retries with
  // backoff and counts toward the 2 min offline grace like a dropped connection.
  const login = (): void => {
    if (destroyed || fatal) return;
    const attempt = createClient();
    client = attempt;
    attempt.login(bot.token).catch((err: unknown) => {
      // The failed Client may still emit late: silence it so it can never
      // answer a command twice, but keep an 'error' sink so nothing throws.
      attempt.removeAllListeners();
      attempt.on(Events.Error, () => {});
      if (client === attempt) client = null;
      if (destroyed) return;
      if ((err as { code?: unknown }).code === DiscordjsErrorCodes.TokenInvalid) {
        reportFatal(BOT_DOWN_REASONS.tokenRejected);
        return;
      }
      // A fatal close code was already reported through shardDisconnect
      if (fatal) return;
      log('gateway login failed', err);
      health.disconnected(null);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        login();
      }, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, LOGIN_RETRY_MAX_MS);
    });
  };

  // Registration is an idempotent overwrite; only a 401 stops the bot, since
  // setup already registered the commands once.
  void (async () => {
    try {
      const res = await registerCommands(bot);
      if (res.status === 401) {
        reportFatal(BOT_DOWN_REASONS.tokenRejected);
        return;
      }
      if (!res.ok) console.error(`[discord] command registration rejected: HTTP ${res.status}`);
    } catch (err) {
      log('command registration failed', err);
    }
    login();
  })().catch((err: unknown) => log('bot start failed', err));

  return {
    // Health stops first: the normal close from destroy() would otherwise read as an outage.
    async destroy(): Promise<void> {
      destroyed = true;
      health.stop();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      try {
        await client?.destroy();
      } catch (err) {
        log('disconnect failed', err);
      }
    },
  };
}
