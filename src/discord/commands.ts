import { MAX_IDLE_GAMES } from '../constants.js';

export type SelectedState = 'idling' | 'cooldown' | 'paused';
export interface SelectedGameView {
  appid: number;
  name: string;
  state: SelectedState;
  exempt: boolean;
  cooldownEndsAt: Date | null;
}
export interface ControlPanel {
  library(): { appid: number; name: string }[];
  selection(): SelectedGameView[];
  busyReason(): string | null;
  waitingReason(): string | null;
  add(appid: number): void;
  remove(appid: number): void;
}
export interface Choice {
  name: string;
  value: string;
}

export const NOT_ALLOWED_REPLY = "You're not allowed to control this steamidled.";

const MAX_CHOICES = 25;
const MAX_CHOICE_NAME = 100;

// Gates every interaction to the owner inside the configured server, so DMs and other servers are refused.
export function isAuthorized(
  ctx: { userId: string; guildId: string | null },
  bot: { ownerId: string; guildId: string },
): boolean {
  return ctx.guildId !== null && ctx.guildId === bot.guildId && ctx.userId === bot.ownerId;
}

// Keeps autocomplete names within Discord's 100-character choice limit.
function clip(name: string): string {
  return name.length > MAX_CHOICE_NAME ? `${name.slice(0, MAX_CHOICE_NAME - 1)}…` : name;
}

// Ranks prefix matches before substring matches, each alphabetical, capped at Discord's 25 choices.
function suggest(games: { appid: number; name: string }[], query: string): Choice[] {
  const q = query.trim().toLowerCase();
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  const prefix: { appid: number; name: string }[] = [];
  const contains: { appid: number; name: string }[] = [];
  for (const g of games) {
    const n = g.name.toLowerCase();
    if (n.startsWith(q)) prefix.push(g);
    else if (n.includes(q)) contains.push(g);
  }
  return [...prefix.sort(byName), ...contains.sort(byName)]
    .slice(0, MAX_CHOICES)
    .map((g) => ({ name: clip(g.name), value: String(g.appid) }));
}

// Offers library games that are not already being idled.
export function suggestAdd(panel: ControlPanel, query: string): Choice[] {
  const selected = new Set(panel.selection().map((g) => g.appid));
  return suggest(panel.library().filter((g) => !selected.has(g.appid)), query);
}

// Offers only the games currently being idled.
export function suggestRemove(panel: ControlPanel, query: string): Choice[] {
  return suggest(panel.selection(), query);
}

// Accepts only plain digit strings so autocomplete values cannot smuggle in anything else.
function parseAppid(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// Validates and applies an /add request, returning the reply text.
export function runAdd(panel: ControlPanel, rawAppid: string): string {
  const busy = panel.busyReason();
  if (busy !== null) return busy;
  const appid = parseAppid(rawAppid);
  const game = appid === null ? undefined : panel.library().find((g) => g.appid === appid);
  if (appid === null || !game) return 'Unknown game.';
  const selection = panel.selection();
  if (selection.some((g) => g.appid === appid)) return `Already idling ${game.name}.`;
  if (selection.length >= MAX_IDLE_GAMES) return `Already idling ${MAX_IDLE_GAMES} games — remove one first.`;
  panel.add(appid);
  return `▶️ Now idling ${game.name} (until steamidled restarts).`;
}

// Validates and applies a /remove request, returning the reply text.
export function runRemove(panel: ControlPanel, rawAppid: string): string {
  const busy = panel.busyReason();
  if (busy !== null) return busy;
  const appid = parseAppid(rawAppid);
  const selection = panel.selection();
  const game = appid === null ? undefined : selection.find((g) => g.appid === appid);
  if (appid === null || !game) {
    const inLibrary = appid !== null && panel.library().some((g) => g.appid === appid);
    return inLibrary ? `${panel.library().find((g) => g.appid === appid)!.name} isn't being idled.` : 'Unknown game.';
  }
  if (selection.length <= 1) return `${game.name} is the only game left — steamidled needs at least one.`;
  panel.remove(appid);
  return `⏹️ Stopped idling ${game.name} (until steamidled restarts).`;
}

// Mirrors the daemon's "2h 05m" duration style for cooldown countdowns.
function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

// Builds the plain-text /status reply; escaping is left to the send layer.
export function formatStatus(panel: ControlPanel, now: Date): string {
  const sel = panel.selection();
  const idling = sel.filter((g) => g.state === 'idling');
  const cooldown = sel.filter((g) => g.state === 'cooldown');
  const paused = sel.filter((g) => g.state === 'paused');
  const exempt = sel.filter((g) => g.exempt);
  const lines: string[] = [];
  const section = (title: string, rows: string[]) => {
    if (rows.length === 0) return;
    lines.push(`${title} (${rows.length})`, ...rows.map((r) => `• ${r}`), '');
  };
  section('Idling', idling.map((g) => g.name));
  section(
    'Cooldown',
    cooldown.map((g) =>
      g.cooldownEndsAt ? `${g.name} — ${formatDuration(g.cooldownEndsAt.getTime() - now.getTime())} left` : g.name,
    ),
  );
  section('Paused — playing elsewhere', paused.map((g) => g.name));
  if (exempt.length > 0) lines.push(`Exempt: ${exempt.map((g) => `${g.name} ∞`).join(', ')}`, '');
  const waiting = panel.waitingReason();
  if (waiting !== null) lines.push(`Steam: disconnected — ${waiting}`, '');
  lines.push('Changes made here last until steamidled restarts; favorites are unchanged.');
  return lines.join('\n');
}
