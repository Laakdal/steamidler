import type { IdlingGame } from '../types/index.js';
import type { Runtime } from '../runtime.js';
import { isFrozen } from '../runtime.js';

const MINUTE_MS = 60_000;

// Time to the next local midnight, when the report goes out
function untilMidnight(): number {
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - Date.now();
}

// A game's banked idle time plus, while its clock runs, the time since the
// clock last started. A frozen clock (waiting, blocked, paused) adds nothing.
function idleMsNow(game: IdlingGame, frozen: boolean, now: number): number {
  return frozen ? game.accumulatedMs : game.accumulatedMs + (now - game.startTime.getTime());
}

// The report sent to Discord at local midnight. "today" for each game is its
// idle time now minus a snapshot taken at the start of the day.
export class DailyReport {
  // Idle time per appid when the day started
  private atDayStart = new Map<number, number>();

  constructor(private readonly rt: Runtime) {}

  // Called once by startIdling: today's snapshot, then the first midnight
  start(): void {
    this.snapshotDayStart();
    this.armMidnight();
  }

  // One-shot timer to the next midnight. When it fires it reports the day
  // that just ended, takes the new day's snapshot and arms itself again.
  private armMidnight(): void {
    const rt = this.rt;
    rt.timers.timeout(
      'midnight',
      () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        rt.discord.send(formatDailyReport(rt.session.idling, rt.session.paused, this.atDayStart, yesterday, isFrozen(rt)));
        this.snapshotDayStart();
        this.armMidnight();
      },
      untilMidnight()
    );
  }

  // Records each game's idle time now, as the base for the next "today"
  snapshotDayStart(): void {
    const { session } = this.rt;
    const frozen = isFrozen(this.rt);
    const now = Date.now();
    this.atDayStart.clear();
    for (const game of session.idling) this.atDayStart.set(game.appid, idleMsNow(game, frozen, now));
    // A paused game's clock is stopped, whatever its startTime says
    for (const game of session.paused) this.atDayStart.set(game.appid, game.accumulatedMs);
  }

  // Forgets the snapshot of games installSelection has just recreated
  forget(appids: number[]): void {
    for (const appid of appids) this.atDayStart.delete(appid);
  }
}

// "2h 5m", "5m", or "0m" for nothing (or less)
function hoursMinutes(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

// Builds the report text without side effects. `date` is only the label (the
// day that ended); the arithmetic uses `nowMs`. `frozen` means the idling
// games are accruing nothing right now (waiting to resume, or blocked).
export function formatDailyReport(
  idling: readonly IdlingGame[],
  paused: readonly IdlingGame[],
  dayStartAccumulatedMs: Map<number, number>,
  date: Date,
  frozen = false,
  nowMs = Date.now()
): string {
  // en-CA formats as YYYY-MM-DD
  const lines = [`📊 Daily idling report — ${date.toLocaleDateString('en-CA')}`];

  if (idling.length > 0) {
    lines.push('', `Idling (${idling.length})${frozen ? ' — currently paused' : ''}:`);
    for (const game of idling) {
      const idleMs = idleMsNow(game, frozen, nowMs);
      const today = hoursMinutes(idleMs - (dayStartAccumulatedMs.get(game.appid) ?? 0));
      const totalHours = Math.floor((game.initialPlaytime + Math.floor(idleMs / MINUTE_MS)) / 60);
      lines.push(`• ${game.name} — +${today} today, ${totalHours.toLocaleString()}h total`);
    }
  }

  if (paused.length > 0) {
    lines.push('', `User-paused (${paused.length}):`, ...paused.map((g) => `• ${g.name}`));
  }
  return lines.join('\n');
}
