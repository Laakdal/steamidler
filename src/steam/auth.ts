import { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } from 'steam-session';
import qrcode from 'qrcode-terminal';
import { input, password as passwordPrompt } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Ora } from 'ora';
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

// How a round of Steam Guard code entry ended: Steam took a code, the prompt
// was closed because the login ended another way, or it failed (codes ran out, Ctrl+C)
type CodeOutcome = { kind: 'accepted' } | { kind: 'closed' } | { kind: 'failed'; error: string };

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

    // The catch also covers a throw while printing the code, which must end
    // the login like any other failure instead of escaping as a rejection
    session
      .startWithQR()
      .then(({ qrChallengeUrl }) => {
        if (!qrChallengeUrl) return;
        console.log(chalk.cyan('\nScan this QR code with your Steam mobile app:\n'));
        qrcode.generate(qrChallengeUrl, { small: true });
        console.log(chalk.gray('\nWaiting for approval...\n'));
      })
      .catch((err: Error) => fail(err.message));
  });
}

// Up to MAX_CODE_TRIES rounds of reading a Steam Guard code and handing it to
// Steam. `closed` is aborted once the login has ended another way (a phone
// approval, a timeout): the prompt closes, and a submission failing after
// that is noise.
async function enterGuardCodes(session: LoginSession, spinner: Ora, closed: AbortSignal): Promise<CodeOutcome> {
  let lastReason = '';
  for (let tryNo = 1; tryNo <= MAX_CODE_TRIES; tryNo++) {
    if (closed.aborted) return { kind: 'closed' };
    if (tryNo > 1) console.log(chalk.red(`  Code rejected (${lastReason}). Try again.`));
    let code: string;
    try {
      code = await input({ message: 'Enter Steam Guard code:' }, { signal: closed });
    } catch (err) {
      // AbortPromptError is our own close. Anything else is Ctrl+C, which has
      // to end the login here: with an email code nothing polls, so it would hang.
      if ((err as Error).name === 'AbortPromptError') return { kind: 'closed' };
      return { kind: 'failed', error: 'Login cancelled' };
    }
    spinner.start('Verifying code...');
    try {
      await session.submitSteamGuardCode(code);
      return { kind: 'accepted' };
    } catch (err) {
      spinner.stop();
      if (closed.aborted) return { kind: 'closed' };
      lastReason = (err as Error).message;
    }
  }
  return { kind: 'failed', error: `Steam Guard failed: ${lastReason}` };
}

// The line telling the owner how to confirm, from the confirmations Steam offers
function confirmHint(methods: ConfirmMethod[], canEnterCode: boolean): string | null {
  if (methods.some((m) => m.type === EAuthSessionGuardType.DeviceConfirmation)) {
    return canEnterCode
      ? '\nConfirm the login in your Steam mobile app, or enter the code below.'
      : '\nPlease confirm the login request on your Steam mobile app...';
  }
  if (methods.some((m) => m.type === EAuthSessionGuardType.EmailConfirmation)) {
    return '\nConfirm the login via the link Steam just emailed you...';
  }
  return null;
}

// Where Steam sent the code, for the prompt's heading
function codeSource(method: ConfirmMethod): string {
  if (method.type !== EAuthSessionGuardType.EmailCode) return 'mobile app';
  return method.detail ? `email to ${method.detail}` : 'email';
}

// Password login, with Steam Guard by phone approval, emailed link, or a code
// from the app or email. Several things can end it (approval, code, timeout,
// error, Ctrl+C); the first one settles the result and the others are ignored.
export async function loginWithCredentials(client: SteamClient): Promise<LoginResult> {
  const session = newSession();
  const typedName = await input({ message: 'Steam username:' });
  const password = await passwordPrompt({ message: 'Steam password:', mask: '*' });
  const spinner = createSpinner('Logging in...').start();
  // Closes an open code prompt, so two prompts never compete for stdin
  const closePrompt = new AbortController();

  let settle!: (result: LoginResult) => void;
  const result = new Promise<LoginResult>((resolve) => (settle = resolve));
  let settled = false;
  const end = (outcome: LoginResult): void => {
    if (settled) return;
    settled = true;
    spinner.stop();
    closePrompt.abort();
    // Stop steam-session polling: an approval arriving after we gave up must
    // not log the client on behind the next prompt
    session.cancelLoginAttempt();
    settle(outcome);
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

  let start: Awaited<ReturnType<LoginSession['startWithCredentials']>>;
  try {
    start = await session.startWithCredentials({ accountName: typedName, password });
  } catch (err) {
    end({ success: false, error: (err as Error).message });
    return result;
  }
  if (!start.actionRequired) return result;

  // Steam wants a confirmation: say how, then wait for a code or the approval
  spinner.stop();
  const methods = (start.validActions ?? []) as ConfirmMethod[];
  const codeMethod = methods.find(
    (m) => m.type === EAuthSessionGuardType.DeviceCode || m.type === EAuthSessionGuardType.EmailCode
  );
  const hint = confirmHint(methods, codeMethod !== undefined);
  if (hint) console.log(chalk.yellow(hint));
  if (codeMethod) {
    console.log(chalk.yellow(`\nSteam Guard code required (${codeSource(codeMethod)})`));
    void enterGuardCodes(session, spinner, closePrompt.signal).then((codes) => {
      if (codes.kind === 'failed') end({ success: false, error: codes.error });
    });
  } else {
    spinner.start('Waiting for confirmation...');
  }
  return result;
}

// Logs on with the token saved by an earlier login. Only a token Steam calls
// dead is deleted; a network fault, an outage or a rate limit keeps it, or one
// bad moment at boot would leave the headless service needing a manual login.
export async function loginWithStoredCredentials(client: SteamClient): Promise<LoginResult> {
  const saved = loadCredentials();
  if (!saved) return { success: false, error: 'No stored credentials' };

  const who = chalk.cyan(saved.accountName);
  const spinner = createSpinner(`Logging in as ${who}...`).start();
  const failure = await client.loginWithRefreshToken(saved.refreshToken, saved.accountName).then(
    () => null,
    (err: Error & { eresult?: number }) => err
  );
  if (!failure) {
    spinner.succeed(`Logged in as ${who}`);
    return { success: true, accountName: saved.accountName };
  }

  const { eresult } = failure;
  const tokenDead = eresult !== undefined && DEAD_TOKEN_ERESULTS.has(eresult);
  if (tokenDead) clearCredentials();
  const label = eresult === undefined ? failure.message : `${failure.message} (eresult ${eresult})`;
  spinner.fail(tokenDead ? 'Stored credentials expired' : `Login failed: ${label}`);
  const error = tokenDead ? 'Stored credentials expired — log in again' : `${label} — stored credentials kept, retry later`;
  return { success: false, error, eresult };
}

// True when a usable login is saved
export function hasStoredLogin(): boolean {
  return hasStoredCredentials();
}

export { clearCredentials };
