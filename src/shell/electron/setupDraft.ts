import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, writeFileAtomic } from '../../core/store/atomicFile.ts';
import { CLI_PROVIDERS } from '../../core/providers/catalog.ts';
import { isBotAvatar } from '../../shared/avatars.ts';
import { botNameProblem, botPersonaProblem, normalizeBotName, normalizeBotPersona } from '../../shared/botText.ts';
import type { SetupDraft } from '../../shared/providerSetup.ts';

/**
 * SPEC-010 FR-13: when a helper's CLI cannot be found until Cats Bot restarts, the
 * page's input waits in this file for the next start, which reads it once and
 * removes it. It holds what the owner typed, so it gets the same care as their
 * profile; a file that does not follow the rules is dropped rather than shown.
 */

const fileIn = (home: string) => join(home, 'setup-draft.json');

/** A draft from anywhere, made safe, or null when no field of it can be trusted. */
export function parseSetupDraft(raw: unknown): SetupDraft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? normalizeBotName(record.name) : '';
  const instructions = typeof record.instructions === 'string' ? normalizeBotPersona(record.instructions) : '';
  const provider = typeof record.provider === 'string' ? record.provider : '';
  if (botNameProblem(name) || botPersonaProblem(instructions)) return null;
  if (!CLI_PROVIDERS.some((item) => item.id === provider)) return null;
  return { name, instructions, provider, ...(isBotAvatar(record.avatar) ? { avatar: record.avatar } : {}) };
}

export function writeSetupDraft(home: string, raw: unknown): boolean {
  const draft = parseSetupDraft(raw);
  if (!draft) return false;
  writeFileAtomic(fileIn(home), JSON.stringify(draft), { mode: 0o600 });
  return true;
}

/**
 * Reads the draft and removes the file, whatever it held. A file that cannot be removed
 * counts as no draft: a window opened for it would open again at every start.
 */
export function takeSetupDraft(home: string): SetupDraft | null {
  const path = fileIn(home);
  if (!existsSync(path)) return null;
  const read = readJsonFile<unknown>(path);
  try {
    rmSync(path, { force: true, recursive: true });
  } catch {
    return null;
  }
  return read.ok ? parseSetupDraft(read.value) : null;
}
