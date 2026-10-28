import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * SPEC-001 FR-2: one data root per bot, `~/.cats/bots/<id>/` unless
 * `CATS_BOTS_HOME` says otherwise. Every path the core touches is derived
 * from here so tests can point the whole bot at a temporary directory.
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

export function resolveBotsHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CATS_BOTS_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.cats', 'bots');
}

export function resolveBotRoot(botId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveBotsHome(env), botId);
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
