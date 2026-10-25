import type { IdlingGame } from '../types/index.js';

// Builds the daily Discord report. Pure formatter — no side effects. `date`
// only labels the report (the day that ended); all arithmetic uses `nowMs`.
// isFrozen is true while idling games accrue nothing (waiting to resume, or
// blocked by another session), so the live delta must not be added.
export function formatDailyReport(
  idling: IdlingGame[],
  paused: IdlingGame[],
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

