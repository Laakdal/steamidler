import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../storage/atomicWrite.js';
import { dataPath, ensureDataDir } from '../storage/paths.js';
import { isSnowflake } from './config.js';

export const STATUS_PATH = dataPath('discord-status.json');

export interface StatusMessageRef {
  channelId: string;
  messageId: string;
}

// Remembers which message is the live status box, so a restart edits it
// instead of posting another. Anything but two snowflakes is ignored, so a
// hand-edited file can never put odd values into a request path.
export function loadStatusMessage(): StatusMessageRef | null {
  if (!existsSync(STATUS_PATH)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(STATUS_PATH, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const file = raw as Record<string, unknown>;
  if (!isSnowflake(file.channelId) || !isSnowflake(file.messageId)) return null;
  return { channelId: file.channelId, messageId: file.messageId };
}

// Never throws: losing this file only means the next start posts a new box
export function saveStatusMessage(ref: StatusMessageRef): boolean {
  try {
    ensureDataDir();
    writeFileAtomic(STATUS_PATH, JSON.stringify({ channelId: ref.channelId, messageId: ref.messageId }, null, 2), 0o600);
    return true;
  } catch (err) {
    console.error(`Could not save ${STATUS_PATH}: ${(err as Error).message}`);
    return false;
  }
}
