import Table from 'cli-table3';
import chalk from 'chalk';
import type { IdlingGame } from '../types/index.js';

// Width of the Game column, one character of padding on each side included
const GAME_COLUMN = 38;
const MINUTE_MS = 60_000;

export interface StatusOptions {
  waitingReason?: string | null; // disconnected, retrying with backoff
  playingBlocked?: boolean; // another device on the account is playing
  showKeyHints?: boolean; // false in headless mode, where no keys are read
}

// The title shown at start
export function showWelcome(version?: string): void {
  console.log(chalk.cyan.bold('\n  Steam Game Time Idler') + (version ? chalk.gray(` v${version}`) : '') + '\n');
  console.log(chalk.gray('  Idle your Steam games to collect playtime\n'));
}

// Minutes this run has added to a game. A frozen clock (paused, waiting or
// blocked) counts only what was banked, since Steam credits nothing meanwhile.
function gainedMinutes(game: IdlingGame, frozen: boolean): number {
  const running = frozen ? 0 : Date.now() - game.startTime.getTime();
  return Math.floor((game.accumulatedMs + running) / MINUTE_MS);
}

// "+1h 5m", or "+5m" under an hour
function gainedLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return h > 0 ? `+${h}h ${minutes % 60}m` : `+${minutes}m`;
}

// Whole hours of Steam playtime plus this run's gain
function totalLabel(game: IdlingGame, gained: number): string {
  return `${Math.floor((game.initialPlaytime + gained) / 60).toLocaleString()}h`;
}

// A name cut with "..." to fit the Game column
function fitName(name: string): string {
  const room = GAME_COLUMN - 2;
  return name.length > room ? `${name.slice(0, room - 3)}...` : name;
}

// The heading lines for the current state
function heading(waitingReason: string | null, blocked: boolean): string[] {
  if (waitingReason) {
    return [
      chalk.yellow.bold('\n  Steam Game Time Idler — WAITING TO RESUME\n'),
      chalk.yellow(`  ${waitingReason}. Auto-retrying with backoff.\n`),
    ];
  }
  if (blocked) {
    return [
      chalk.yellow.bold('\n  Steam Game Time Idler — BLOCKED\n'),
      chalk.yellow('  A game is being played on this account elsewhere. Idling resumes when it stops.\n'),
    ];
  }
  return [chalk.cyan.bold('\n  Steam Game Time Idler - Idling\n')];
}

// Redraws the idling screen: a table of every game with its total, its gain
// this run and its state, then a count line and the key help
export function showIdlingStatus(
  idlingGames: readonly IdlingGame[],
  pausedGames: readonly IdlingGame[] = [],
  options: StatusOptions = {}
): void {
  const waitingReason = options.waitingReason || null;
  const blocked = !!options.playingBlocked;
  // No playtime accrues while waiting or blocked, idling rows included
  const frozen = waitingReason !== null || blocked;
  const state = waitingReason ? chalk.yellow('Waiting') : blocked ? chalk.yellow('Blocked') : chalk.green('Idling');

  const table = new Table({
    head: ['Game', 'Total', 'Gained', 'Status'].map((h) => chalk.cyan(h)),
    colWidths: [GAME_COLUMN, 10, 12, 14],
    style: { head: [], border: ['gray'] },
  });
  for (const game of idlingGames) {
    const gained = gainedMinutes(game, frozen);
    table.push([fitName(game.name), totalLabel(game, gained), chalk.green(gainedLabel(gained)), state]);
  }
  for (const game of pausedGames) {
    const gained = gainedMinutes(game, true);
    table.push([
      chalk.gray(fitName(game.name)),
      chalk.gray(totalLabel(game, gained)),
      chalk.gray(gainedLabel(gained)),
      chalk.yellow('Paused'),
    ]);
  }

  console.clear();
  for (const line of heading(waitingReason, blocked)) console.log(line);
  console.log(table.toString());

  const n = idlingGames.length;
  const paused = pausedGames.length > 0 ? ` (${chalk.yellow(`${pausedGames.length} paused`)})` : '';
  console.log(chalk.green(`\n  Idling ${chalk.bold(n)} game${n === 1 ? '' : 's'}`) + paused + '\n');

  // Key help only where keys are actually read
  if (!process.stdout.isTTY || options.showKeyHints === false) return;
  console.log(
    chalk.gray(
      waitingReason ? "  Press 'Q' to quit — edit disabled while waiting\n" : "  Press 'E' to edit games | 'Q' to quit\n"
    )
  );
}

export function showLoginSuccess(accountName: string): void {
  console.log(chalk.green(`\n  Logged in as ${chalk.bold(accountName)}\n`));
}

export function showLoginError(error: string): void {
  console.log(chalk.red(`\n  Login failed: ${error}\n`));
}

// The last line of a clean exit
export function showGoodbye(): void {
  console.log(chalk.cyan('\n  Goodbye! Happy idling!\n'));
}

export function showError(message: string): void {
  console.log(chalk.red(`\n  Error: ${message}\n`));
}
