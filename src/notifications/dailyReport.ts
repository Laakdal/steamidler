import type { IdlingGame } from '../types/index.js';
import type { Runtime } from '../runtime.js';
import { isFrozen } from '../runtime.js';

// Delay until the next local midnight, so the report lands at the day boundary
function msUntilNextMidnight(): number {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime() - Date.now();
}

// The midnight Discord report and the day-start snapshot its "today" gain is
// measured from.
export class DailyReport {
  private dayStartAccumulatedMs = new Map<number, number>();

  // Takes the shared runtime the report reads the games from
  constructor(private readonly rt: Runtime) {}

  // Takes today's baseline and arms the midnight report; startIdling calls it once
  start(): void {
    this.snapshotDayStart();
    this.scheduleDailyReport();
  }

  // Arms the one-shot midnight timer; each firing sends the report, takes the
  // new day's baseline and re-arms itself for the next midnight
  private scheduleDailyReport(): void {
    const rt = this.rt;
    rt.timers.timeout('midnight', () => {
      // Fires just after midnight but reports on the day that ended
      const endedDay = new Date();
      endedDay.setDate(endedDay.getDate() - 1);
      const report = formatDailyReport(
        rt.session.idling,
        rt.session.paused,
        this.dayStartAccumulatedMs,
        endedDay,
        isFrozen(rt)
      );
      rt.discord.send(report);
      this.snapshotDayStart();
      this.scheduleDailyReport();
    }, msUntilNextMidnight());
  }

  // Captures each game's current accumulated playtime for tomorrow's "today gain"
  // calculation. Only idling games have a live delta; user-paused
  // games are frozen at accumulatedMs (their startTime is stale by design).
  snapshotDayStart(): void {
    const rt = this.rt;
    this.dayStartAccumulatedMs.clear();
    const now = Date.now();
    const frozen = isFrozen(rt);
    for (const game of rt.session.idling) {
      const live = frozen
        ? game.accumulatedMs
        : game.accumulatedMs + (now - game.startTime.getTime());
      this.dayStartAccumulatedMs.set(game.appid, live);
    }
    for (const game of rt.session.paused) {
      this.dayStartAccumulatedMs.set(game.appid, game.accumulatedMs);
    }
  }

  // Drops the day-start snapshot of games installSelection created
  forget(appids: number[]): void {
    for (const appid of appids) this.dayStartAccumulatedMs.delete(appid);
  }
}

// Builds the daily Discord report. Pure formatter — no side effects. `date`
// only labels the report (the day that ended); all arithmetic uses `nowMs`.
// isFrozen is true while idling games accrue nothing (waiting to resume, or
// blocked by another session), so the live delta must not be added.
export function formatDailyReport(
  idling: readonly IdlingGame[],
  paused: readonly IdlingGame[],
  dayStartAccumulatedMs: Map<number, number>,
  date: Date,
  isFrozen = false,
  nowMs = Date.now()
): string {
  const now = nowMs;
  const dateStr = date.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const lines: string[] = [];
  lines.push(`📊 Daily idling report — ${dateStr}`);

  const todayGain = (game: IdlingGame, accumulated: number): string =>
    formatHM(accumulated - (dayStartAccumulatedMs.get(game.appid) ?? 0));

  if (idling.length > 0) {
    lines.push('');
    lines.push(`Idling (${idling.length})${isFrozen ? ' — currently paused' : ''}:`);
    for (const game of idling) {
      const liveAccumulated = isFrozen
        ? game.accumulatedMs
        : game.accumulatedMs + (now - game.startTime.getTime());
      const totalMinutes = game.initialPlaytime + Math.floor(liveAccumulated / 60000);
      lines.push(
        `• ${game.name} — +${todayGain(game, liveAccumulated)} today, ${formatTotalH(totalMinutes)} total`
      );
    }
  }

  if (paused.length > 0) {
    lines.push('');
    lines.push(`User-paused (${paused.length}):`);
    for (const game of paused) {
      lines.push(`• ${game.name}`);
    }
  }

  return lines.join('\n');
}

function formatHM(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatTotalH(totalMinutes: number): string {
  return `${Math.floor(totalMinutes / 60).toLocaleString()}h`;
}

