import { escapeMarkdown } from './format.js';

export type PanelState = 'starting' | 'idling' | 'waiting' | 'blocked' | 'stopped';

export interface PanelGame {
  name: string;
  state: 'idling' | 'cooldown' | 'paused';
  exempt: boolean;
  totalMinutes: number;
  gainedMs: number;
  cooldownEndsAt: Date | null;
}

export interface StatusSnapshot {
  state: PanelState;
  waitingReason: string | null;
  games: PanelGame[];
}

export interface Embed {
  title: string;
  description: string;
  color: number;
  fields: { name: string; value: string }[];
  footer: { text: string };
  timestamp: string;
}

const COLORS: Record<PanelState, number> = {
  idling: 0x57f287,
  waiting: 0xfee75c,
  blocked: 0xfee75c,
  stopped: 0xed4245,
  starting: 0x99aab5,
};
const FENCE = '```';
const MAX_FIELD_VALUE = 1024;
const NAME_WIDTH = 24;
const EXEMPT_SUFFIX = ' ∞';
// A field continuing a section needs a name, and Discord rejects an empty one
const CONTINUED = '​';
// The waiting reason quotes Steam's error text, which has no length bound of its own
const MAX_REASON = 200;

// Clips by code point, not UTF-16 unit, so an emoji is never cut in half
// (a lone surrogate can make Discord reject the whole box)
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

// Code blocks show text literally, but a backtick could close the block and a
// newline would break the row, so both are neutralised instead of escaped.
function rowName(game: PanelGame): string {
  const clean = game.name.replace(/`/g, 'ˋ').replace(/[\r\n\t\u0000-\u001f]/g, ' ');
  const width = game.exempt ? NAME_WIDTH - EXEMPT_SUFFIX.length : NAME_WIDTH;
  const clipped = clip(clean, width);
  const padding = Math.max(0, NAME_WIDTH - Array.from(clipped).length - (game.exempt ? EXEMPT_SUFFIX.length : 0));
  return (game.exempt ? clipped + EXEMPT_SUFFIX : clipped) + ' '.repeat(padding);
}

// "1,234h", like the terminal table's Total column
function formatTotal(totalMinutes: number): string {
  return `${Math.floor(totalMinutes / 60).toLocaleString('en-US')}h`;
}

// "+2h 05m" / "+7m": time gained this session
function formatGained(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h > 0 ? `+${h}h ${String(minutes % 60).padStart(2, '0')}m` : `+${minutes}m`;
}

// "3d 4h" past a day, else "5h 12m" / "12m"; an end already passed reads 0m
// until the next randomizer tick moves the game back
function formatLeft(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${h}h`;
  return h > 0 ? `${h}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

// Turns a section's rows into code-block fields of at most 1024 characters;
// a section too long for one field continues in the next.
function sectionFields(title: string, rows: string[]): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = [];
  const wrap = (chunk: string[]) => `${FENCE}\n${chunk.join('\n')}\n${FENCE}`;
  let chunk: string[] = [];
  for (const row of rows) {
    if (chunk.length > 0 && wrap([...chunk, row]).length > MAX_FIELD_VALUE) {
      fields.push({ name: fields.length === 0 ? title : CONTINUED, value: wrap(chunk) });
      chunk = [];
    }
    chunk.push(row);
  }
  if (chunk.length > 0) fields.push({ name: fields.length === 0 ? title : CONTINUED, value: wrap(chunk) });
  return fields;
}

// First description line: what steamidler is doing, worded for a phone glance
function stateLine(snap: StatusSnapshot, idlingCount: number): string {
  switch (snap.state) {
    case 'idling':
      return `🟢 Idling ${idlingCount} game${idlingCount === 1 ? '' : 's'}`;
    case 'waiting':
      return `🟡 Waiting to resume — ${escapeMarkdown(clip(snap.waitingReason ?? 'disconnected', MAX_REASON))}`;
    case 'blocked':
      return '🟡 Paused — a game is being played on this account elsewhere';
    case 'stopped':
      return '🛑 Stopped';
    case 'starting':
      return '⏳ Waiting for idling to start';
  }
}

// Builds the live status box. Pure, so the layout and Discord's size limits
// are tested without a network; with at most 32 games, clipped rows and a
// clipped reason the whole embed stays far below Discord's 6000-character cap.
export function buildStatusEmbed(snap: StatusSnapshot, now: Date, nextUpdateAt: Date | null, version: string): Embed {
  const idling = snap.games.filter((g) => g.state === 'idling');
  const cooldown = snap.games.filter((g) => g.state === 'cooldown');
  const paused = snap.games.filter((g) => g.state === 'paused');

  let description = stateLine(snap, idling.length);
  // A relative timestamp counts down on the viewer's device and flips to
  // "x minutes ago" by itself if updates stop, so staleness shows
  if (nextUpdateAt && snap.state !== 'stopped') {
    description += `\nNext update <t:${Math.floor(nextUpdateAt.getTime() / 1000)}:R>`;
  }

  const fields = [
    ...sectionFields(
      `🎮 Idling (${idling.length})`,
      idling.map((g) => `${rowName(g)}  ${formatTotal(g.totalMinutes).padStart(8)}  ${formatGained(g.gainedMs)}`)
    ),
    ...sectionFields(
      `❄️ Cooldown (${cooldown.length})`,
      cooldown.map(
        (g) => `${rowName(g)}  ${formatLeft(g.cooldownEndsAt ? g.cooldownEndsAt.getTime() - now.getTime() : 0)} left`
      )
    ),
    ...sectionFields(
      `⏸️ Paused (${paused.length})`,
      paused.map((g) => `${rowName(g)}  ${formatTotal(g.totalMinutes).padStart(8)}`)
    ),
  ];

  return {
    title: 'Steam Idler',
    description,
    color: COLORS[snap.state],
    fields,
    footer: { text: `steamidler v${version}` },
    timestamp: now.toISOString(),
  };
}
