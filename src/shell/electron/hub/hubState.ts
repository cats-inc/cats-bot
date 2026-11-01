import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { readJsonFile, writeJsonAtomic } from '../../../core/store/atomicFile.ts';
import { acquireLockFile } from '../../../core/store/lock.ts';
import { hubPathsFor, isValidBotId } from '../../../core/store/paths.ts';
import {
  HUB_REPLY_LANGUAGE_DEFAULT,
  isHubReplyLanguage,
  isLanguagePreference,
  type HubReplyLanguage,
  type LanguagePreference,
} from '../../../shared/language.ts';

/**
 * SPEC-008 FR-1, FR-18, FR-23 and FR-28: what the hub keeps for itself. Its
 * preferences (display language, reply language, start at login) are shared by every bot and
 * live in `<CATS_BOT_HOME>/hub-state.json`; its installation id lives in its
 * Electron user data; its root lock keeps a second installation away from the
 * same bots.
 */

export interface HubState {
  schemaVersion: 1;
  language: LanguagePreference;
  /** FR-28: absent in files from before it, which reads as the default. */
  replyLanguage: HubReplyLanguage;
  openAtLogin: boolean;
  /** SPEC-008 FR-22: the bots that ran when an update began, started again after it. */
  resume?: string[];
}

export function readHubState(home: string): HubState | null {
  const read = readJsonFile<Partial<HubState>>(hubPathsFor(home).state);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) return null;
  return {
    schemaVersion: 1,
    language: isLanguagePreference(read.value.language) ? read.value.language : 'system',
    replyLanguage: isHubReplyLanguage(read.value.replyLanguage) ? read.value.replyLanguage : HUB_REPLY_LANGUAGE_DEFAULT,
    openAtLogin: read.value.openAtLogin === true,
    ...(Array.isArray(read.value.resume)
      ? { resume: read.value.resume.filter((id): id is string => typeof id === 'string' && isValidBotId(id)) }
      : {}),
  };
}

export function writeHubState(home: string, state: HubState): void {
  writeJsonAtomic(hubPathsFor(home).state, state);
}

/** FR-12: a random id for this installation, kept in its user data. */
export function readOrCreateInstallationId(userData: string): string {
  const file = join(userData, 'installation.json');
  const read = readJsonFile<{ id?: unknown }>(file);
  if (read.ok && typeof read.value?.id === 'string' && /^[0-9a-f-]{36}$/u.test(read.value.id)) return read.value.id;
  const id = randomUUID();
  writeJsonAtomic(file, { schemaVersion: 1, id });
  return id;
}

export interface HubLockOwner {
  pid: number;
  host: string;
  installationId: string;
  executable: string;
  startedAt: string;
}

/** FR-1: one hub per Cats Bot root; a later hub learns which installation holds it. */
export function acquireHubLock(home: string, installationId: string, executable: string, pid = process.pid) {
  return acquireLockFile<HubLockOwner>(hubPathsFor(home).lock, {
    pid, host: hostname(), installationId, executable, startedAt: new Date().toISOString(),
  });
}
