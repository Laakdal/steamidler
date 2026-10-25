import { select } from '@inquirer/prompts';
import type { AuthMethod } from '../types/index.js';

type LoginChoice = AuthMethod | 'stored';

// The login menu, in the order shown; the saved login is offered only when one exists
const LOGIN_CHOICES: { value: LoginChoice; name: string; description: string }[] = [
  { value: 'stored', name: 'Use saved login', description: 'Login with your saved credentials' },
  { value: 'qr', name: 'QR Code', description: 'Scan QR code with Steam mobile app (recommended)' },
  { value: 'credentials', name: 'Username & Password', description: 'Login with your Steam credentials' },
];

// Asks how to log in
export function promptAuthMethod(hasStored: boolean): Promise<LoginChoice> {
  return select({
    message: 'How would you like to login?',
    choices: LOGIN_CHOICES.filter((c) => hasStored || c.value !== 'stored'),
  });
}
