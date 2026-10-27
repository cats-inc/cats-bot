#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { BotCore, BotInstanceRunningError, BotNotInitializedError, initializeBot } from '../core/bot.ts';
import { readInstanceLock, writeHandoff } from '../core/store/lock.ts';
import { botPathsFor, resolveBotRoot, resolveBotsHome } from '../core/store/paths.ts';
import type { BotHostEvent, PermissionMode, WorkItem } from '../core/types.ts';

/**
 * `cats-bot`: the headless entry point of PLAN-001 Phase 1. `run` keeps the
 * core in the foreground and prints its events; `say` either hands a message
 * to the running instance or runs one turn itself; `status` and
 * `conversations` only read the data root.
 */

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const equals = body.indexOf('=');
      if (equals !== -1) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(body, next);
        index += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }
    if (command === undefined) command = arg;
    else positional.push(arg);
  }
  return { command, positional, flags };
}

function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

const USAGE = `Usage: cats-bot <command> [options]

Commands:
  init --name <name> --provider <provider> [--model <model>] [--id <id>] [--cwd <dir>]
       [--instructions <text>] [--permission-mode skip|whitelist|default]
  run [--id <id>] [--json]            run the bot core in the foreground
  say <conversation|home> <text...>   send an owner message (to the running bot, or one turn here)
  status [--id <id>]                  show profile, runtime and queue state
  conversations [--id <id>]           list conversations

Bots live under CATS_BOTS_HOME (default ~/.cats/bots); CATS_BOT_ID or --id selects one
when more than one exists.
`;

function listBotIds(botsHome: string): string[] {
  if (!existsSync(botsHome)) return [];
  return readdirSync(botsHome, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(botsHome, entry.name, 'profile.json')))
    .map((entry) => entry.name)
    .sort();
}

function resolveBotId(flags: ParsedArgs['flags'], env: NodeJS.ProcessEnv): string {
  const explicit = flagString(flags, 'id') ?? env.CATS_BOT_ID?.trim();
  if (explicit) return explicit;
  const ids = listBotIds(resolveBotsHome(env));
  if (ids.length === 1) return ids[0]!;
  if (ids.length === 0) throw new Error('No bot found; run `cats-bot init` first');
  throw new Error(`Several bots exist (${ids.join(', ')}); pass --id or set CATS_BOT_ID`);
}

/**
 * Development overrides: point the provider at another command (for example
 * the scripted fixture CLI) and its discovery directory, without editing the
 * generated providers.yaml. Production ignores both.
 */
function runtimeOverrides(env: NodeJS.ProcessEnv): { providerCommand?: string; instanceExtras?: Record<string, string> } {
  const command = env.CATS_BOTS_PROVIDER_COMMAND?.trim();
  const projectsDir = env.CATS_BOTS_PROVIDER_PROJECTS_DIR?.trim();
  return {
    ...(command ? { providerCommand: command } : {}),
    ...(projectsDir ? { instanceExtras: { projects_dir: projectsDir } } : {}),
  };
}

function describeEvent(event: BotHostEvent): string | null {
  switch (event.type) {
    case 'runtime.status':
      return `[runtime] ${event.state}${event.detail ? `: ${event.detail}` : ''}`;
    case 'work.updated':
      return `[work] ${event.workItem.id} ${event.workItem.kind} ${event.workItem.state}`
        + (event.workItem.error ? ` (${event.workItem.error})` : '');
    case 'turn.completed':
      return `[turn] ${event.workItem.id} ${event.workItem.state}`;
    case 'presence.changed':
      return `[presence] ${event.conversationId} ${event.presence} (${event.reason})`;
    case 'host.handoff':
      return `[handoff] ${event.message.kind}`;
    case 'work.awaitingOwner':
      return `[approval] ${event.workItem.id} awaits the owner`;
    default:
      return null;
  }
}

function printEvent(event: BotHostEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (event.type === 'turn.delta') {
    if (event.entry.kind === 'bot') process.stdout.write(event.entry.text);
    else if (event.entry.kind === 'tool_use') process.stdout.write(`\n[tool] ${event.entry.toolName ?? ''} ${event.entry.text}\n`);
    else if (event.entry.kind === 'error') process.stdout.write(`\n[error] ${event.entry.text}\n`);
    return;
  }
  if (event.type === 'turn.completed') {
    process.stdout.write(`\n${describeEvent(event)}\n`);
    return;
  }
  const line = describeEvent(event);
  if (line) process.stdout.write(`${line}\n`);
}

async function commandInit(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const name = flagString(parsed.flags, 'name');
  const provider = flagString(parsed.flags, 'provider');
  if (!name || !provider) {
    process.stderr.write('init needs --name and --provider\n');
    return 2;
  }
  const id = flagString(parsed.flags, 'id')
    ?? (name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'bot');
  const permissionMode = flagString(parsed.flags, 'permission-mode') as PermissionMode | undefined;
  const { profile, root } = initializeBot(resolveBotsHome(env), {
    id,
    name,
    provider,
    model: flagString(parsed.flags, 'model') ?? null,
    ...(flagString(parsed.flags, 'cwd') ? { cwd: flagString(parsed.flags, 'cwd') } : {}),
    ...(flagString(parsed.flags, 'instructions') ? { instructions: flagString(parsed.flags, 'instructions') } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  }, env);
  process.stdout.write(`Initialized bot ${profile.id} (${profile.name}) at ${root}\n`);
  process.stdout.write(`Provider: ${profile.executionTarget.provider}${profile.executionTarget.model ? ` / ${profile.executionTarget.model}` : ''}\n`);
  return 0;
}

async function commandRun(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const id = resolveBotId(parsed.flags, env);
  const json = parsed.flags.get('json') === true;
  const core = BotCore.open({
    root: resolveBotRoot(id, env),
    runtime: runtimeOverrides(env),
    log: (line) => { if (!json) process.stderr.write(`${line}\n`); },
  });
  core.subscribe((event) => printEvent(event, json));
  await core.start();
  const status = core.status();
  if (!json) process.stdout.write(`cats-bot ${status.id} running (pid ${process.pid}); press Ctrl+C to stop\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      void core.stop().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function commandSay(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const [conversation, ...words] = parsed.positional;
  const text = words.join(' ').trim();
  if (!conversation || !text) {
    process.stderr.write('say needs a conversation id (or home) and the text\n');
    return 2;
  }
  const id = resolveBotId(parsed.flags, env);
  const root = resolveBotRoot(id, env);
  const paths = botPathsFor(root);
  const owner = readInstanceLock(paths);
  if (owner) {
    writeHandoff(paths, { kind: 'say', conversationId: conversation, text });
    process.stdout.write(`Handed the message to the running bot (pid ${owner.pid}).\n`);
    return 0;
  }
  const core = BotCore.open({ root, runtime: runtimeOverrides(env), log: (line) => process.stderr.write(`${line}\n`) });
  await core.start();
  try {
    const finished = new Promise<WorkItem>((resolve) => {
      core.subscribe((event) => {
        if (event.type === 'turn.delta' && event.entry.kind === 'bot') process.stdout.write(event.entry.text);
        if (event.type === 'turn.completed' && event.workItem.id === pending?.id) resolve(event.workItem);
      });
    });
    let pending: WorkItem | undefined;
    pending = await core.sendOwnerMessage(conversation, text);
    const result = await finished;
    process.stdout.write(`\n[${result.state}]${result.error ? ` ${result.error}` : ''}\n`);
    return result.state === 'completed' ? 0 : 1;
  } finally {
    await core.stop();
  }
}

async function commandStatus(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const id = resolveBotId(parsed.flags, env);
  const root = resolveBotRoot(id, env);
  const core = BotCore.open({ root, log: () => {} });
  const profile = await core.getProfile();
  const lock = readInstanceLock(botPathsFor(root));
  const summary = {
    id: profile.id,
    name: profile.name,
    root,
    executionTarget: profile.executionTarget,
    configRevision: profile.configRevision,
    heartbeat: profile.heartbeat,
    running: lock ? { pid: lock.pid, since: lock.startedAt } : null,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

async function commandConversations(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const id = resolveBotId(parsed.flags, env);
  const core = BotCore.open({ root: resolveBotRoot(id, env), log: () => {} });
  const conversations = await core.listConversations();
  if (parsed.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(conversations, null, 2)}\n`);
    return 0;
  }
  if (conversations.length === 0) {
    process.stdout.write('No conversations yet; the home conversation is created on the first run.\n');
    return 0;
  }
  for (const record of conversations) {
    process.stdout.write(`${record.id}\t${record.role}\t${record.attachment.state}\tunread=${record.unreadCount}\t${record.title}\n`);
  }
  return 0;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(argv);
  try {
    switch (parsed.command) {
      case 'init':
        return await commandInit(parsed, env);
      case 'run':
        return await commandRun(parsed, env);
      case 'say':
        return await commandSay(parsed, env);
      case 'status':
        return await commandStatus(parsed, env);
      case 'conversations':
        return await commandConversations(parsed, env);
      case undefined:
      case 'help':
      case '--help':
        process.stdout.write(USAGE);
        return parsed.command === undefined ? 2 : 0;
      default:
        process.stderr.write(`Unknown command ${parsed.command}\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof BotNotInitializedError || error instanceof BotInstanceRunningError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && (import.meta.url.endsWith(process.argv[1].replace(/\\/gu, '/')) || process.argv[1].endsWith('main.js') || process.argv[1].endsWith('main.ts'));
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
