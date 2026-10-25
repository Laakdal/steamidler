import { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } from 'steam-session';
import qrcode from 'qrcode-terminal';
import { input, password as passwordPrompt } from '@inquirer/prompts';
import chalk from 'chalk';
import type { SteamClient } from './client.js';
import { createSpinner } from '../ui/spinner.js';
import { saveCredentials, loadCredentials, clearCredentials, hasStoredCredentials } from '../storage/credentials.js';
import type { LoginResult } from '../types/index.js';
import { DEAD_TOKEN_ERESULTS } from './eresults.js';

// steam-session polls for 30 s by default, not enough time to find the phone
// and approve the login
const APPROVAL_WINDOW_MS = 120_000;
// Wrong Steam Guard codes accepted before the login is given up
const MAX_CODE_TRIES = 3;

// One way Steam offers to confirm a password login
interface ConfirmMethod {
  type: number;
  detail?: string;
}

// A login session with the longer approval window
function newSession(): LoginSession {
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
  session.loginTimeout = APPROVAL_WINDOW_MS;
  return session;
}

// Shared last step of the QR and password logins: keep the token for next
// time, then open the Steam session with it
async function completeLogin(client: SteamClient, refreshToken: string, accountName: string): Promise<LoginResult> {
  saveCredentials({ accountName, refreshToken });
  try {
    await client.loginWithRefreshToken(refreshToken, accountName);
    return { success: true, accountName };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// QR login: the owner scans the code with the Steam mobile app and approves
export function loginWithQR(client: SteamClient): Promise<LoginResult> {
  const session = newSession();
  return new Promise((resolve) => {
    const fail = (error: string): void => resolve({ success: false, error });

    session.on('remoteInteraction', () => {
      console.log(chalk.gray('  QR scanned — approve the login in the Steam app...'));
    });
    session.on('authenticated', () => {
      const { refreshToken, accountName } = session;
      if (!refreshToken || !accountName) {
        fail('Failed to get credentials from QR login');
        return;
      }
      void completeLogin(client, refreshToken, accountName).then(resolve);
    });
    session.on('timeout', () => fail('QR code timed out'));
    session.on('error', (err) => fail(err.message));

    session.startWithQR().then(
      ({ qrChallengeUrl }) => {
        if (!qrChallengeUrl) return;
        console.log(chalk.cyan('\nScan this QR code with your Steam mobile app:\n'));
        qrcode.generate(qrChallengeUrl, { small: true });
        console.log(chalk.gray('\nWaiting for approval...\n'));
      },
      (err: Error) => fail(err.message)
    );
  });
}

// Password login, with Steam Guard by phone approval, emailed link, or a code
// from the app or email. A phone approval can land while the code prompt is
// open, so whichever finishes first ends the login and closes the other.
export async function loginWithCredentials(client: SteamClient): Promise<LoginResult> {
  const session = newSession();
  const typedName = await input({ message: 'Steam username:' });
  const password = await passwordPrompt({ message: 'Steam password:', mask: '*' });

  const spinner = createSpinner('Logging in...').start();
  // Closes the code prompt once the login is decided some other way, so two
  // prompts never compete for stdin
  const closePrompt = new AbortController();

  return new Promise((resolve) => {
    let over = false;
    const end = (result: LoginResult): void => {
      if (over) return;
      over = true;
      spinner.stop();
      closePrompt.abort();
      // Stops steam-session polling: an approval arriving after we gave up must
      // not log the client on behind the next prompt
      session.cancelLoginAttempt();
      resolve(result);
    };

    // Reads a Steam Guard code and submits it, up to MAX_CODE_TRIES times.
    // Returns quietly when the prompt was closed because the login ended.
    const askForCode = async (method: ConfirmMethod): Promise<void> => {
      const where =
        method.type === EAuthSessionGuardType.EmailCode
          ? `email${method.detail ? ` to ${method.detail}` : ''}`
          : 'mobile app';
      console.log(chalk.yellow(`\nSteam Guard code required (${where})`));

      for (let tryNo = 1; tryNo <= MAX_CODE_TRIES && !over; tryNo++) {
        let code: string;
        try {
          code = await input({ message: 'Enter Steam Guard code:' }, { signal: closePrompt.signal });
        } catch (err) {
          // An AbortPromptError means the login already ended. Anything else is
          // Ctrl+C, which has to end it here: with an email code nothing polls,
          // so the login would otherwise hang
          if ((err as Error).name !== 'AbortPromptError') end({ success: false, error: 'Login cancelled' });
          return;
        }
        spinner.start('Verifying code...');
        try {
          await session.submitSteamGuardCode(code);
          return;
        } catch (err) {
          spinner.stop();
          // An approval that landed meanwhile cancels the attempt and makes
          // this submission fail; that failure means nothing
          if (over || closePrompt.signal.aborted) return;
          const reason = (err as Error).message;
          if (tryNo < MAX_CODE_TRIES) {
            console.log(chalk.red(`  Code rejected (${reason}). Try again.`));
          } else {
            end({ success: false, error: `Steam Guard failed: ${reason}` });
          }
        }
      }
    };

    // Picks how to wait from the confirmations Steam offers: a code prompt when
    // a code is possible, otherwise a spinner while the owner approves
    const waitForConfirmation = (methods: ConfirmMethod[]): void => {
      const offers = (type: number): boolean => methods.some((m) => m.type === type);
      const codeMethod = methods.find(
        (m) => m.type === EAuthSessionGuardType.DeviceCode || m.type === EAuthSessionGuardType.EmailCode
      );
      if (offers(EAuthSessionGuardType.DeviceConfirmation)) {
        console.log(
          chalk.yellow(
            codeMethod
              ? '\nConfirm the login in your Steam mobile app, or enter the code below.'
              : '\nPlease confirm the login request on your Steam mobile app...'
          )
        );
      } else if (offers(EAuthSessionGuardType.EmailConfirmation)) {
        console.log(chalk.yellow('\nConfirm the login via the link Steam just emailed you...'));
      }
      if (codeMethod) {
        void askForCode(codeMethod);
      } else {
        spinner.start('Waiting for confirmation...');
      }
    };

    session.on('authenticated', () => {
      // Steam accepted the login: close the code prompt before anything else
      closePrompt.abort();
      const { refreshToken } = session;
      if (!refreshToken) {
        end({ success: false, error: 'Failed to get refresh token' });
        return;
      }
      // Steam's spelling of the account name keys the selection file; the
      // typed one can differ in case and would split it across two files
      void completeLogin(client, refreshToken, session.accountName || typedName).then(end);
    });
    session.on('timeout', () => end({ success: false, error: 'Login timed out' }));
    session.on('error', (err) => end({ success: false, error: err.message }));

    session.startWithCredentials({ accountName: typedName, password }).then(
      (start) => {
        if (!start.actionRequired) return;
        spinner.stop();
        waitForConfirmation((start.validActions ?? []) as ConfirmMethod[]);
      },
      (err: Error) => end({ success: false, error: err.message })
    );
  });
}

// Logs on with the token saved by an earlier login. Only a token Steam calls
// dead is deleted; a network fault, an outage or a rate limit keeps it, or one
// bad moment at boot would leave the headless service needing a manual login.
export async function loginWithStoredCredentials(client: SteamClient): Promise<LoginResult> {
  const saved = loadCredentials();
  if (!saved) return { success: false, error: 'No stored credentials' };

  const who = chalk.cyan(saved.accountName);
  const spinner = createSpinner(`Logging in as ${who}...`).start();
  try {
    await client.loginWithRefreshToken(saved.refreshToken, saved.accountName);
    spinner.succeed(`Logged in as ${who}`);
    return { success: true, accountName: saved.accountName };
  } catch (err) {
    const { message, eresult } = err as Error & { eresult?: number };
    if (eresult !== undefined && DEAD_TOKEN_ERESULTS.has(eresult)) {
      spinner.fail('Stored credentials expired');
      clearCredentials();
      return { success: false, error: 'Stored credentials expired — log in again', eresult };
    }
    const label = eresult === undefined ? message : `${message} (eresult ${eresult})`;
    spinner.fail(`Login failed: ${label}`);
    return { success: false, error: `${label} — stored credentials kept, retry later`, eresult };
  }
}

// True when a usable login is saved
export function hasStoredLogin(): boolean {
  return hasStoredCredentials();
}

export { clearCredentials };
