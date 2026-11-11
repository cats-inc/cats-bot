import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { nextBotAvatar, type BotAvatar } from '../../shared/avatars.ts';
import { botPathsFor, botRootIn, hubPathsFor } from '../store/paths.ts';
import type { BotProfile } from '../types.ts';
import { writeJsonAtomic } from '../store/atomicFile.ts';
import { createProfile, loadProfile, PROFILE_SCHEMA_VERSION, saveProfile, type CreateProfileInput } from './profile.ts';
import { assertBotDataResetNotPending } from '../store/dataResetGuard.ts';
import { acquireInstanceLock } from '../store/lock.ts';
import { createNewBotDatabase, version1Items } from '../store/version1Migration.ts';

/**
 * Creating a bot and reading whether one exists, without opening its core.
 * A host decides between first-run setup and starting the core from this
 * (PLAN-009 1.3), so it lives apart from `BotCore`.
 */

export class BotNotInitializedError extends Error {
  constructor(root: string) {
    super(`No bot profile at ${root}; run init first`);
    this.name = 'BotNotInitializedError';
  }
}

export interface InitializeBotInput extends Omit<CreateProfileInput, 'cwd' | 'id'> {
  id: string;
  cwd?: string;
}

/** The looks of the bots in a directory. A look is never worth failing over: what cannot be read has none. */
function avatarsIn(dir: string): BotAvatar[] {
  const avatars: BotAvatar[] = [];
  try {
    if (!existsSync(dir)) return avatars;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const profile = readBotProfile(join(dir, entry.name));
        if (profile) avatars.push(profile.avatar);
      } catch {
        // A corrupt profile keeps no look.
      }
    }
  } catch {
    // An unreadable directory holds no looks to avoid.
  }
  return avatars;
}

/**
 * SPEC-008 FR-29: the look a new bot gets unless the owner chooses another:
 * one no bot uses yet, and when it can, one no archived bot would bring back.
 */
export function suggestBotAvatar(botsHome: string): BotAvatar {
  const { archive } = hubPathsFor(dirname(resolve(botsHome)));
  return nextBotAvatar(avatarsIn(botsHome), avatarsIn(archive));
}

/** `cats-bot init`: writes the profile and the directory layout, never over an existing bot. */
export function initializeBot(
  botsHome: string,
  input: InitializeBotInput,
): { profile: BotProfile; root: string } {
  const root = botRootIn(botsHome, input.id);
  const paths = botPathsFor(root);
  assertBotDataResetNotPending(root);
  const placeholder = createProfile({ id: input.id, name: input.name, provider: input.provider, cwd: root });
  const existing = loadProfile(paths, placeholder);
  if (existing.ok) {
    throw new Error(`Bot ${input.id} already exists at ${root}`);
  }
  if (existing.reason === 'corrupt') {
    throw new Error(`Bot ${input.id} has a corrupt profile at ${paths.profile}: ${existing.error}`);
  }
  const lock = acquireInstanceLock(paths);
  if (!lock.held) throw new Error('Another program is initializing this cat bot.');
  try {
    // A competing initializer may have finished after the first read.
    if (existsSync(paths.profile)) throw new Error(`Bot ${input.id} already exists at ${root}`);
    for (const dir of [paths.root, paths.runtime, paths.logs, paths.workspace]) {
      mkdirSync(dir, { recursive: true });
    }
    const profile = createProfile({ ...input, avatar: input.avatar ?? suggestBotAvatar(botsHome), cwd: input.cwd ?? paths.workspace });
    if (version1Items(paths).some((item) => existsSync(item))) {
      // SPEC-014 FR-11: version-1 files from before are migrated at the first start, as a
      // bot of 0.5's are, so the profile is written at the version the migration raises.
      writeJsonAtomic(paths.profile, { ...profile, schemaVersion: 2 });
      return { profile, root };
    }
    // SPEC-014: the database first, so that the profile at the raised version is never on a
    // root whose database is not finished.
    createNewBotDatabase(paths);
    saveProfile(paths, profile);
    return { profile, root };
  } finally { lock.release(); }
}

/**
 * SPEC-014 FR-11: whether the bot's next start migrates its version-1 files, which can take
 * minutes for a large bot: its profile is still at a version before the state database.
 */
export function stateMigrationPending(root: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(botPathsFor(root).profile, 'utf8')) as { schemaVersion?: unknown };
    return typeof raw.schemaVersion === 'number' && raw.schemaVersion < PROFILE_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

/** The bot's profile, or null when it was never set up; a corrupt profile throws. */
export function readBotProfile(root: string): BotProfile | null {
  const paths = botPathsFor(root);
  const placeholder = createProfile({ id: 'bot', name: 'bot', provider: 'claude', cwd: paths.workspace });
  const loaded = loadProfile(paths, placeholder);
  if (loaded.ok) return loaded.profile;
  if (loaded.reason === 'missing') return null;
  throw new Error(`Corrupt profile at ${paths.profile}: ${loaded.error}`);
}
