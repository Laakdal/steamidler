import { password as passwordPrompt, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { isBotTokenShape, loadDiscordConfig, parseWebhookUrl, saveDiscordConfig } from './config.js';
import type { BotConfig } from './config.js';
import { DiscordApiError, discordApi, postChannelMessage, postWebhook, registerCommands } from './rest.js';
import { buildStatusEmbed } from './statusEmbed.js';
import { STATUS_BOX_PROBLEMS, isHiddenBox, publishStatus } from './statusPanel.js';
import { loadStatusMessage, saveStatusMessage, type StatusMessageRef } from './statusStore.js';

const TEST_TIMEOUT_MS = 10_000;

export interface BotIdentity {
  applicationId: string;
  botName: string;
  owners: { id: string; name: string }[];
}

// GET helper: non-2xx becomes a DiscordApiError naming only what failed and the
// status, never the token or the response body
async function getJson<T>(token: string, path: string, what: string): Promise<T> {
  let res: Response;
  try {
    res = await discordApi(token, 'GET', path);
  } catch {
    throw new DiscordApiError(0, `Could not reach Discord while ${what}`);
  }
  if (!res.ok) throw new DiscordApiError(res.status, `Discord rejected ${what}: HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new DiscordApiError(res.status, `Discord sent an unreadable reply while ${what}`);
  }
}

// Confirms the token belongs to a bot and finds the application and who may own it
export async function fetchBotIdentity(token: string): Promise<BotIdentity> {
  const me = await getJson<{ id: string; username: string; bot?: boolean }>(token, '/users/@me', 'the bot token check');
  if (me.bot !== true) throw new Error('That token does not belong to a bot account — copy it from the Bot page of your application');
  const app = await getJson<{
    id: string;
    owner?: { id: string; username: string };
    team?: { members?: { user: { id: string; username: string } }[] } | null;
  }>(token, '/oauth2/applications/@me', 'the application lookup');
  const owners = app.team?.members?.length
    ? app.team.members.map((m) => ({ id: m.user.id, name: m.user.username }))
    : app.owner
      ? [{ id: app.owner.id, name: app.owner.username }]
      : [];
  return { applicationId: app.id, botName: me.username, owners };
}

// Servers the bot has been invited to
export async function listGuilds(token: string): Promise<{ id: string; name: string }[]> {
  const guilds = await getJson<{ id: string; name: string }[]>(token, '/users/@me/guilds', 'the server list');
  return guilds.map((g) => ({ id: g.id, name: g.name }));
}

// Used to warn when the picked owner may not be able to see admin-only commands
export async function guildOwnerId(token: string, guildId: string): Promise<string> {
  const guild = await getJson<{ owner_id: string }>(token, `/guilds/${guildId}`, 'the server lookup');
  return guild.owner_id;
}

// Text channels (type 0) in the order Discord shows them
export async function listTextChannels(token: string, guildId: string): Promise<{ id: string; name: string }[]> {
  const channels = await getJson<{ id: string; name: string; type: number; position: number }[]>(
    token,
    `/guilds/${guildId}/channels`,
    'the channel list'
  );
  return channels
    .filter((c) => c.type === 0)
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ id: c.id, name: c.name }));
}

// Minimal permissions: View Channel + Send Messages + Embed Links (19456).
// Embed Links is for the live status box; Discord may drop a bot's embed without it.
export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=19456`;
}

// Shows the status box's placeholder, editing the box a previous setup left
// in that channel instead of orphaning it. Throws a message safe to print when
// Discord refuses it or hides the embed (no Embed Links).
async function placeStatusBox(bot: BotConfig, channelId: string, version: string): Promise<StatusMessageRef> {
  const embed = buildStatusEmbed({ state: 'starting', waitingReason: null, games: [] }, new Date(), null, version);
  const nonce = `setup${Date.now().toString(36)}`;
  const result = await publishStatus(bot.token, channelId, loadStatusMessage(), embed, nonce, TEST_TIMEOUT_MS);
  if (isHiddenBox(result)) throw new Error(`${STATUS_BOX_PROBLEMS.hidden}, then run --setup-discord again`);
  if (!result.ok) {
    if (result.status === undefined) throw new DiscordApiError(0, 'Could not reach Discord while showing the status box');
    const hint = result.status === 403 ? ` — ${STATUS_BOX_PROBLEMS.forbidden}` : '';
    throw new DiscordApiError(result.status, `Discord rejected the status box: HTTP ${result.status}${hint}`);
  }
  return { channelId, messageId: result.messageId };
}

// Runs one network step, mapping a non-2xx or a network failure to a DiscordApiError that is safe to print
async function step(what: string, run: () => Promise<Response>): Promise<void> {
  let res: Response;
  try {
    res = await run();
  } catch {
    throw new DiscordApiError(0, `Could not reach Discord while ${what}`);
  }
  if (!res.ok) throw new DiscordApiError(res.status, `Discord rejected ${what}: HTTP ${res.status}`);
}

// Proves every piece works before anything is stored: a half-working setup is never saved
export async function finishSetup(bot: BotConfig, webhookUrl: string | null, version: string): Promise<void> {
  await step('the bot test message', () =>
    postChannelMessage(bot.token, bot.channelId, '✅ steamidler bot connected.', TEST_TIMEOUT_MS)
  );
  if (webhookUrl) {
    await step('the webhook test message', () =>
      postWebhook(webhookUrl, '✅ steamidler backup webhook connected.', TEST_TIMEOUT_MS)
    );
  }
  await step('the slash command registration', () => registerCommands(bot));
  const statusBox = bot.statusChannelId ? await placeStatusBox(bot, bot.statusChannelId, version) : null;
  if (!saveDiscordConfig({ bot, webhookUrl })) throw new Error('Could not save the Discord settings');
  // Losing this only means the first idling run posts a fresh box
  if (statusBox && !saveStatusMessage(statusBox)) {
    console.log(chalk.yellow('  The status box will be posted again when idling starts.'));
  }
}

// Interactive glue over the tested functions above (--setup-discord)
export async function runDiscordSetup(version: string): Promise<void> {
  console.log(chalk.cyan.bold('\n  Setup Discord bot\n'));
  console.log(chalk.gray('  1. Open https://discord.com/developers/applications and click New Application.'));
  console.log(chalk.gray('  2. On the Bot page, click Reset Token and copy it.'));
  console.log(chalk.gray('  3. Paste the token below.\n'));

  const token = (await passwordPrompt({ message: 'Bot token:', mask: '*' })).trim();
  if (!isBotTokenShape(token)) throw new Error('That does not look like a bot token (three parts separated by dots)');

  const identity = await fetchBotIdentity(token);
  console.log(chalk.green(`\n  ✓ Bot "${identity.botName}" recognised`));
  console.log(
    chalk.gray('\n  Invite the bot to your server with this link (only View Channel, Send Messages and Embed Links):')
  );
  console.log(`  ${inviteUrl(identity.applicationId)}\n`);

  if (identity.owners.length === 0) throw new Error('Could not find the owner of this application');
  const ownerId =
    identity.owners.length === 1
      ? identity.owners[0].id
      : await select({
          message: 'Who may control the bot?',
          choices: identity.owners.map((o) => ({ name: o.name, value: o.id })),
        });

  const guilds = await listGuilds(token);
  if (guilds.length === 0) {
    console.log(chalk.yellow('  The bot is not in any server yet. Invite the bot, then run --setup-discord again.'));
    return;
  }
  const guildId =
    guilds.length === 1
      ? guilds[0].id
      : await select({ message: 'Server:', choices: guilds.map((g) => ({ name: g.name, value: g.id })) });
  if ((await guildOwnerId(token, guildId)) !== ownerId) {
    console.log(
      chalk.yellow("  Warning: if you're not an admin of this server, Discord will hide the commands from you.")
    );
  }

  const channels = await listTextChannels(token, guildId);
  if (channels.length === 0) throw new Error('No text channels visible to the bot in that server');
  const channelId = await select({
    message: 'Notification channel:',
    choices: channels.map((c) => ({ name: `#${c.name}`, value: c.id })),
  });
  // A channel of its own keeps the box on screen; notifications would push it up
  const statusChannelId = await select<string | null>({
    message: 'Live status channel (a box edited every minute; best in its own channel):',
    choices: [{ name: 'None', value: null }, ...channels.map((c) => ({ name: `#${c.name}`, value: c.id }))],
  });

  const current = loadDiscordConfig()?.webhookUrl ?? null;
  const raw = (
    await passwordPrompt({
      message: current
        ? 'Backup webhook URL (Enter to keep the current one):'
        : 'Backup webhook URL (Enter to skip):',
      mask: '*',
    })
  ).trim();
  let webhookUrl: string | null = current;
  if (raw) {
    webhookUrl = parseWebhookUrl(raw);
    if (!webhookUrl) throw new Error('Not a Discord webhook URL (expected https://discord.com/api/webhooks/...)');
  } else if (!current) {
    console.log(chalk.yellow('  No backup webhook: if the bot goes down, notifications will go silent.'));
  }

  await finishSetup(
    { token, applicationId: identity.applicationId, ownerId, guildId, channelId, statusChannelId },
    webhookUrl,
    version
  );
  console.log(chalk.green('\n  ✓ Test messages sent and commands registered — check the channel'));
  if (statusChannelId) console.log(chalk.green('  ✓ Status box placed; it goes live when idling starts'));
  console.log(chalk.green('  ✓ Saved to ~/.steam-idler/discord.json\n'));
}
