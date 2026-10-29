import { mkdirSync } from 'node:fs';

import { botPathsFor, botRootIn } from '../store/paths.ts';
import type { BotProfile } from '../types.ts';
import { createProfile, loadProfile, saveProfile, type CreateProfileInput } from './profile.ts';

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

/** `cats-bot init`: writes the profile and the directory layout, never over an existing bot. */
export function initializeBot(
  botsHome: string,
  input: InitializeBotInput,
): { profile: BotProfile; root: string } {
  const root = botRootIn(botsHome, input.id);
  const paths = botPathsFor(root);
  const placeholder = createProfile({ id: input.id, name: input.name, provider: input.provider, cwd: root });
  const existing = loadProfile(paths, placeholder);
  if (existing.ok) {
    throw new Error(`Bot ${input.id} already exists at ${root}`);
  }
  if (existing.reason === 'corrupt') {
    throw new Error(`Bot ${input.id} has a corrupt profile at ${paths.profile}: ${existing.error}`);
  }
  for (const dir of [paths.root, paths.conversations, paths.transcripts, paths.runtime, paths.logs, paths.workspace]) {
    mkdirSync(dir, { recursive: true });
  }
  const profile = createProfile({ ...input, cwd: input.cwd ?? paths.workspace });
  saveProfile(paths, profile);
  return { profile, root };
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
