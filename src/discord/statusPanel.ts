import { randomBytes } from 'node:crypto';
import { isSnowflake, type BotConfig } from './config.js';
import { redactSecrets } from './format.js';
import { editEmbedMessage, postEmbedMessage } from './rest.js';
import { buildStatusEmbed, type Embed, type StatusSnapshot } from './statusEmbed.js';
import { loadStatusMessage, saveStatusMessage, type StatusMessageRef } from './statusStore.js';

export type PublishResult = { ok: true; messageId: string; embedShown: boolean } | { ok: false; status: number | undefined };

export interface StatusPanelOptions {
  version: string;
  timeoutMs?: number;
  intervalMs?: number;
  minGapMs?: number;
  stopCapMs?: number;
}

// Owner-facing fixes, logged once each time the problem starts
const PROBLEMS = {
  forbidden:
    'no permission to post in the status channel: give the bot View Channel, Send Messages and Embed Links there',
  notFound: 'status channel not found: run --setup-discord',
  hidden: 'Discord hid the status box: give the bot Embed Links in the status channel',
};
type Problem = keyof typeof PROBLEMS | 'error';

// Reads the message Discord sent back. The id identifies the box from now on;
// an empty embeds array means Discord dropped the box (no Embed Links).
async function toResult(res: Response, knownId: string | null): Promise<PublishResult> {
  if (!res.ok) return { ok: false, status: res.status };
  let body: { id?: unknown; embeds?: unknown } = {};
  try {
    body = ((await res.json()) ?? {}) as { id?: unknown; embeds?: unknown };
  } catch {
    // An unreadable reply still succeeded; keep the id we already had
  }
  const messageId = isSnowflake(body.id) ? body.id : knownId;
  if (!messageId) return { ok: false, status: res.status };
  return { ok: true, messageId, embedShown: Array.isArray(body.embeds) && body.embeds.length > 0 };
}

// Edits the stored box when it belongs to this channel, and posts a new one
// when there is none or Discord no longer has it. Shared with setup; never
// throws, so callers only branch on the result.
export async function publishStatus(
  token: string,
  channelId: string,
  stored: StatusMessageRef | null,
  embed: Embed,
  nonce: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<PublishResult> {
  try {
    if (stored && stored.channelId === channelId) {
      const res = await editEmbedMessage(token, channelId, stored.messageId, embed, timeoutMs, signal);
      if (res.status !== 404) return await toResult(res, stored.messageId);
    }
    return await toResult(await postEmbedMessage(token, channelId, embed, nonce, timeoutMs, signal), null);
  } catch {
    return { ok: false, status: undefined };
  }
}

// Fits Discord's 25-character nonce limit
function newNonce(): string {
  return `sp${randomBytes(8).toString('hex')}`;
}

// Keeps the live status box current: every interval, soon after a nudge, and
// once more in the Stopped state at shutdown. Nothing here throws or rejects,
// so a Discord problem can never reach idling or delay the exit.
export class StatusPanel {
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly minGapMs: number;
  private readonly stopCapMs: number;
  private stored: StatusMessageRef | null;
  // Kept across retries until a post succeeds, so Discord dedupes a post that timed out but landed
  private nonce: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private pendingNudge = false;
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private lastStartedAt = 0;
  private nextUpdateAt: Date | null = null;
  private started = false;
  // Set on a rejected token: no further request this run
  private disabled = false;
  private stopping: Promise<void> | null = null;
  private problem: Problem | null = null;

  constructor(
    private readonly bot: BotConfig & { statusChannelId: string },
    private readonly snapshot: () => StatusSnapshot,
    private readonly options: StatusPanelOptions
  ) {
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.minGapMs = options.minGapMs ?? 5000;
    this.stopCapMs = options.stopCapMs ?? 4000;
    this.stored = loadStatusMessage();
  }

  // Publishes now and then every interval
  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.run();
  }

  // Asks for an update soon after a state change. Nudges inside the minimum gap
  // collapse into one edit; one landing mid-request runs after it.
  nudge(): void {
    if (!this.started || this.stopping || this.disabled || this.nudgeTimer) return;
    if (this.inFlight) {
      this.pendingNudge = true;
      return;
    }
    const wait = Math.max(0, this.lastStartedAt + this.minGapMs - Date.now());
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      this.run();
    }, wait);
  }

  // Shows the Stopped state. Aborts a request in flight so it cannot eat the
  // budget, resolves within stopCapMs, never rejects, and is safe to call twice.
  stop(): Promise<void> {
    if (!this.stopping) this.stopping = this.finish().catch(() => {});
    return this.stopping;
  }

  private async finish(): Promise<void> {
    this.clearTimers();
    if (!this.started || this.disabled) return;
    this.controller?.abort();
    let capTimer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => {
      capTimer = setTimeout(resolve, this.stopCapMs);
    });
    const final = (async () => {
      await this.inFlight;
      await this.publish(null, new AbortController().signal, Math.min(this.timeoutMs, this.stopCapMs), true);
    })();
    await Promise.race([final, cap]);
    clearTimeout(capTimer);
  }

  // One update now, unless one is already in flight; re-arms the interval
  // either way so "Next update" in the box stays truthful
  private run(): void {
    if (this.stopping || this.disabled) return;
    this.schedule();
    if (this.inFlight) return;
    const controller = new AbortController();
    this.controller = controller;
    this.lastStartedAt = Date.now();
    this.inFlight = this.publish(this.nextUpdateAt, controller.signal, this.timeoutMs).finally(() => {
      this.inFlight = null;
      this.controller = null;
      if (this.pendingNudge) {
        this.pendingNudge = false;
        this.nudge();
      }
    });
  }

  // The panel's own timer: the display loop stops while waiting for resume,
  // which is exactly when the box matters most
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.nextUpdateAt = new Date(Date.now() + this.intervalMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, this.intervalMs);
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.timer = null;
    this.nudgeTimer = null;
  }

  // Builds and sends one box; any failure is reported, never thrown
  private async publish(nextUpdateAt: Date | null, signal: AbortSignal, timeoutMs: number, final = false): Promise<void> {
    try {
      const snap = this.snapshot();
      const embed = buildStatusEmbed(final ? { ...snap, state: 'stopped' } : snap, new Date(), nextUpdateAt, this.options.version);
      this.nonce ??= newNonce();
      const result = await publishStatus(
        this.bot.token,
        this.bot.statusChannelId,
        this.stored,
        embed,
        this.nonce,
        timeoutMs,
        signal
      );
      this.handle(result);
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err), [this.bot.token]);
      this.report('error', `status box update failed: ${message}`);
    }
  }

  // 401 ends the panel for this run (the notifier announces the bad token);
  // 403/404 are logged once; 429, 5xx and network errors wait for the next tick.
  private handle(result: PublishResult): void {
    const channelId = this.bot.statusChannelId;
    if (result.ok) {
      if (this.stored?.messageId !== result.messageId || this.stored.channelId !== channelId) {
        this.stored = { channelId, messageId: result.messageId };
        saveStatusMessage(this.stored);
        this.nonce = null;
      }
      this.report(result.embedShown ? null : 'hidden');
      return;
    }
    if (result.status === 401) {
      this.disabled = true;
      this.clearTimers();
      console.error('[discord] status box stopped: the bot token was rejected');
      return;
    }
    if (result.status === 403) this.report('forbidden');
    else if (result.status === 404) this.report('notFound');
  }

  // Logs a problem when it starts, not on every tick; clearing it lets the same
  // problem be reported again if it comes back later
  private report(kind: Problem | null, text?: string): void {
    if (kind === this.problem) return;
    this.problem = kind;
    if (kind) console.error(`[discord] ${text ?? PROBLEMS[kind as keyof typeof PROBLEMS]}`);
  }
}
