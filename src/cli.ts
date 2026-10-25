import { hasStoredLogin, clearCredentials } from './steam/auth.js';
import { showError } from './ui/display.js';
import { runDiscordSetup } from './discord/setup.js';
import { type App, packageVersion, runHeadless, runInteractive } from './start.js';

const KNOWN_FLAGS = ['--headless', '--setup-discord', '--logout', '--help', '-h', '--version', '-v'];

const USAGE = `steamidler — Steam game idler CLI and daemon

Usage:
  steamidler                   Interactive mode (login, pick games, idle)
  steamidler --headless        Headless mode: auto-login and idle your saved selection
  steamidler --setup-discord   (Re)configure the Discord bot and backup webhook
  steamidler --logout          Forget the saved Steam login
  steamidler --version, -v     Print version
  steamidler --help, -h        Show this help

Config lives in ~/.steam-idler/ (credentials, selection, discord).`;

// The flags given; anything not in KNOWN_FLAGS lands in unknown
export function parseArgs(argv: string[]): {
  headless: boolean;
  setupDiscord: boolean;
  logout: boolean;
  help: boolean;
  version: boolean;
  unknown: string[];
} {
  const has = (...flags: string[]): boolean => flags.some((f) => argv.includes(f));
  return {
    headless: has('--headless'),
    setupDiscord: has('--setup-discord'),
    logout: has('--logout'),
    help: has('--help', '-h'),
    version: has('--version', '-v'),
    unknown: argv.filter((a) => !KNOWN_FLAGS.includes(a)),
  };
}

// Runs the one-shot flags (help, version, logout, Discord setup), each of
// which exits; otherwise installs the process handlers and starts idling,
// headless or interactive, and never returns
export async function main(app: App, argv: string[]): Promise<void> {
  const { rt } = app;
  const args = parseArgs(argv);

  if (args.help) {
    console.log(USAGE);
    rt.exit(0);
  }
  if (args.version) {
    console.log(packageVersion());
    rt.exit(0);
  }
  if (args.unknown.length > 0) {
    showError(`Unknown option: ${args.unknown.join(' ')}`);
    console.log(USAGE);
    rt.exit(2);
  }
  if (args.logout) {
    const existed = hasStoredLogin();
    clearCredentials();
    console.log(existed ? 'Saved Steam login removed.' : 'No saved Steam login to remove.');
    rt.exit(0);
  }
  if (args.setupDiscord) {
    try {
      await runDiscordSetup(packageVersion());
      rt.exit(0);
    } catch (err) {
      showError((err as Error).message);
      rt.exit(1);
    }
  }

  app.installHandlers();
  await (rt.isHeadless ? runHeadless(app) : runInteractive(app));
  // Idling runs on timers and events from here; the process ends through shutdown
  await new Promise<void>(() => {});
}
