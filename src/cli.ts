import { hasStoredLogin, clearCredentials } from './steam/auth.js';
import { showError } from './ui/display.js';
import { runDiscordSetup } from './discord/setup.js';
import { type App, packageVersion, runHeadless, runInteractive } from './start.js';

const KNOWN_FLAGS = ['--headless', '--setup-discord', '--logout', '--help', '-h', '--version', '-v'];

// Reads the command-line flags; anything not in KNOWN_FLAGS is listed in unknown
export function parseArgs(argv: string[]): {
  headless: boolean;
  setupDiscord: boolean;
  logout: boolean;
  help: boolean;
  version: boolean;
  unknown: string[];
} {
  return {
    headless: argv.includes('--headless'),
    setupDiscord: argv.includes('--setup-discord'),
    logout: argv.includes('--logout'),
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version') || argv.includes('-v'),
    unknown: argv.filter((a) => !KNOWN_FLAGS.includes(a)),
  };
}

// Prints CLI usage
function showHelp(): void {
  console.log(`steamidler — Steam game idler CLI and daemon

Usage:
  steamidler                   Interactive mode (login, pick games, idle)
  steamidler --headless        Headless mode: auto-login and idle your saved selection
  steamidler --setup-discord   (Re)configure the Discord bot and backup webhook
  steamidler --logout          Forget the saved Steam login
  steamidler --version, -v     Print version
  steamidler --help, -h        Show this help

Config lives in ~/.steam-idler/ (credentials, selection, discord).`);
}

// Main entry point that orchestrates the application flow
export async function main(app: App, argv: string[]): Promise<void> {
  const { rt } = app;
  const args = parseArgs(argv);
  if (args.help) {
    showHelp();
    rt.exit(0);
  }
  if (args.version) {
    console.log(packageVersion());
    rt.exit(0);
  }
  if (args.unknown.length > 0) {
    showError(`Unknown option: ${args.unknown.join(' ')}`);
    showHelp();
    rt.exit(2);
  }

  if (args.logout) {
    const had = hasStoredLogin();
    clearCredentials();
    console.log(had ? 'Saved Steam login removed.' : 'No saved Steam login to remove.');
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

  if (rt.isHeadless) {
    await runHeadless(app);
  } else {
    await runInteractive(app);
  }

  await new Promise<void>(() => {});
}
