// Steam accepts at most this many appids in one gamesPlayed call, so no
// selection may grow past it.
export const MAX_IDLE_GAMES = 32;

// Set once at start-up. In headless mode nothing may put stdin into raw mode:
// a process running in the background gets SIGTTOU for it and is stopped.
export const IS_HEADLESS = process.argv.includes('--headless');
