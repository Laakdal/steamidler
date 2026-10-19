import { BOT_DOWN_REASONS } from './notifier.js';

export const GATEWAY_DOWN_GRACE_MS = 120_000;
// Close codes Discord documents as non-recoverable: retrying cannot help.
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

// Maps a fatal gateway close code to the user-facing down reason.
function fatalReason(code: number): string {
  if (code === 4004) return BOT_DOWN_REASONS.tokenRejected;
  if (code === 4013 || code === 4014) return BOT_DOWN_REASONS.intentsRejected;
  return BOT_DOWN_REASONS.gatewayRejected(code);
}

export class GatewayHealth {
  private timer: NodeJS.Timeout | null = null;
  private down = false;
  private fatal = false;
  private stopped = false;

  constructor(
    private readonly onDown: (reason: string, fatal: boolean) => void,
    private readonly onUp: () => void,
    private readonly graceMs: number = GATEWAY_DOWN_GRACE_MS,
  ) {}

  // Reports fatal codes at once; otherwise arms a single grace timer so brief
  // gateway flaps never produce a notification.
  disconnected(closeCode: number | null): void {
    if (this.stopped || this.fatal) return;
    if (closeCode !== null && FATAL_CLOSE_CODES.has(closeCode)) {
      this.clearTimer();
      this.fatal = true;
      this.down = true;
      this.onDown(fatalReason(closeCode), true);
      return;
    }
    if (this.timer || this.down) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.down = true;
      this.onDown(BOT_DOWN_REASONS.gatewayUnreachable, false);
    }, this.graceMs);
  }

  // Cancels a pending grace timer and announces recovery if we had reported down.
  ready(): void {
    if (this.stopped || this.fatal) return;
    this.clearTimer();
    if (this.down) {
      this.down = false;
      this.onUp();
    }
  }

  // Clears timers and ignores everything afterwards, for shutdown.
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  // Drops the pending grace timer, if any.
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
