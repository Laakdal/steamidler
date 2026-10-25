// Offline stand-in for process.stdin as a TTY: the picker and the keyboard
// handler read keypresses from it, and tests emit them by hand. The real stdin
// is never touched, so no listener or raw mode is left behind.
import { EventEmitter } from 'node:events';

const original = Object.getOwnPropertyDescriptor(process, 'stdin');

// Replaces process.stdin with a fake TTY that records setRawMode calls
export function installFakeStdin() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.rawModes = [];
  stdin.setRawMode = (on) => {
    stdin.rawModes.push(on);
    return stdin;
  };
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  // Emits one keypress the way readline does: a key object always, str for printable keys
  stdin.press = (name, str = undefined, mods = {}) => {
    stdin.emit('keypress', str, { name, ctrl: false, meta: false, shift: false, sequence: str ?? '', ...mods });
  };
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true, writable: true, enumerable: original.enumerable });
  return stdin;
}

// Puts the real process.stdin back
export function restoreStdin() {
  Object.defineProperty(process, 'stdin', original);
}
