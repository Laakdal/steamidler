import ora, { type Ora } from 'ora';
import { IS_HEADLESS } from '../constants.js';

// A spinner for slow steps. In headless mode it must not touch stdin: ora's
// discardStdin switches a TTY stdin to raw mode even when the spinner is not
// shown, and a background process that does that is stopped with SIGTTOU.
export function createSpinner(text: string): Ora {
  return ora({ text, discardStdin: !IS_HEADLESS });
}
