import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * SPEC-007 FR-3/FR-4: the Cats Bot root is `~/.catsbot/` unless
 * `CATS_BOT_HOME` says otherwise, and each bot keeps its SPEC-001 FR-2 data
 * root in `<root>/bots/<id>/`. Every path the core touches is derived from
 * here so tests can point every bot at a temporary directory.
 */

export interface BotPaths {
  root: string;
  profile: string;
  conversations: string;
  transcripts: string;
  journal: string;
  runtime: string;
  logs: string;
  workspace: string;
  lock: string;
  handoff: string;
  life: string;
  telegramState: string;
  /** SPEC-006 BDC-03: conversations whose desktop control switch is on. */
  desktopControl: string;
}

export function resolveCatsBotHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CATS_BOT_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.catsbot');
}

/** The parent of every bot root; the rest of the Cats Bot root belongs to the hub (SPEC-008). */
export function resolveBotsHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCatsBotHome(env), 'bots');
}

// SPEC-008 FR-27: one path segment, so no id names a path outside its own bot root.
const BOT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// Microsoft's naming rules also reserve com0 and lpt0.
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/u;
export const BOT_ID_RULE = 'A bot id is 1 to 64 lowercase letters, digits and single hyphens, '
  + 'such as "mochi" or "desk-cat", and not a Windows device name such as "con" or "nul".';

export class InvalidBotIdError extends Error {
  constructor(id: string) {
    super(`Invalid bot id ${JSON.stringify(id.length > 80 ? `${id.slice(0, 80)}…` : id)}. ${BOT_ID_RULE}`);
    this.name = 'InvalidBotIdError';
  }
}

export function isValidBotId(id: string): boolean {
  return id.length >= 1 && id.length <= 64 && BOT_ID.test(id) && !WINDOWS_DEVICE_NAME.test(id);
}

export function assertValidBotId(id: string): string {
  if (!isValidBotId(id)) throw new InvalidBotIdError(id);
  return id;
}

export function botRootIn(botsHome: string, botId: string): string {
  return join(resolve(botsHome), assertValidBotId(botId));
}

export function resolveBotRoot(botId: string, env: NodeJS.ProcessEnv = process.env): string {
  return botRootIn(resolveBotsHome(env), botId);
}

export function botPathsFor(root: string): BotPaths {
  return {
    root,
    profile: join(root, 'profile.json'),
    conversations: join(root, 'conversations'),
    transcripts: join(root, 'transcripts'),
    journal: join(root, 'journal.jsonl'),
    runtime: join(root, 'runtime'),
    logs: join(root, 'logs'),
    workspace: join(root, 'workspace'),
    lock: join(root, 'instance.lock.json'),
    handoff: join(root, 'handoff'),
    life: join(root, 'life.json'),
    telegramState: join(root, 'telegram-state.json'),
    desktopControl: join(root, 'desktop-control.json'),
  };
}

export function conversationFile(paths: BotPaths, conversationId: string): string {
  return join(paths.conversations, `${conversationId}.json`);
}

export function transcriptFile(paths: BotPaths, conversationId: string): string {
  return join(paths.transcripts, `${conversationId}.jsonl`);
}
