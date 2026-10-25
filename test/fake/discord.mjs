// Stand-in for discord.js: records what bot.ts does and lets tests emit events.
import { EventEmitter } from 'node:events';
export const Events = { ShardDisconnect: 'shardDisconnect', ShardReconnecting: 'shardReconnecting', ShardReady: 'shardReady', ShardResume: 'shardResume', Invalidated: 'invalidated', Error: 'error', ShardError: 'shardError', InteractionCreate: 'interactionCreate' };
export const GatewayIntentBits = { Guilds: 1 };
export const MessageFlags = { Ephemeral: 64, SuppressEmbeds: 4 };
export const DiscordjsErrorCodes = { TokenInvalid: 'TokenInvalid' };
export const control = { clients: [], loginImpl: async () => 'ok', destroyImpl: async () => {} };
export class Client extends EventEmitter {
  constructor(options) { super(); this.options = options; this.logins = 0; this.destroyed = 0; control.clients.push(this); }
  login(token) { this.logins++; this.lastToken = token; return control.loginImpl(token); }
  destroy() { this.destroyed++; return control.destroyImpl(); }
}
