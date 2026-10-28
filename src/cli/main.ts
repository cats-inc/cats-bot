#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { BotCore, BotInstanceRunningError, BotNotInitializedError, initializeBot } from '../core/bot.ts';
import { readProviderOverrides } from '../core/hostEnv.ts';
import { callHostControl } from '../core/host-api/control.ts';
import { describeSchedule, type CreateScheduleInput } from '../core/life/schedules.ts';
import { FileSecretStore, SECRET_TELEGRAM_TOKEN } from '../core/secrets.ts';
import { readInstanceLock, writeHandoff } from '../core/store/lock.ts';
import { botPathsFor, resolveBotRoot, resolveBotsHome } from '../core/store/paths.ts';
import type { BotHostEvent, HandoffMessage, MissedPolicy, PermissionMode, WorkItem } from '../core/types.ts';

/**
 * `cats-bot`: the headless entry point. `run` keeps the core in the
 * foreground and prints its events; every other command either hands its
 * request to the running instance through the handoff directory or, when no
 * instance holds the lock, applies it to the data root directly.
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
  run [--json]                           run the bot core in the foreground
  say <conversation|home> <text...>      send an owner message
  status                                 show profile, runtime, queue and life state
  conversations [--json]                 list conversations
  schedule add <conversation|home> --prompt <text> (--at <iso> | --in <minutes> | --cron "<expr>" [--tz <zone>])
               [--missed skip|coalesce|run_once]
  schedule list [--json]
  schedule cancel <id>
  approve <workItemId> <approve|deny>    answer a question the bot asked
  interactions [conversation|home]      list live provider requests as JSON
  respond <conversation|home> <request>  read typed response JSON from stdin
  capabilities [conversation|home] [--refresh]  inspect the current session without a model turn
  heartbeat <pause|resume>               stop or restart the hidden heartbeat turns
  tick                                   run one reconcile pass (only when no instance is running)
  quit                                   ask the running instance (CLI or shell) to stop
  telegram set-token <token> | clear-token | enable | disable | status
                                         bind the bot to a Telegram bot token (long polling)
  open [conversation|home]               ask the running shell to show a note window

Every command except init and run takes --id <id>. Bots live under CATS_BOTS_HOME
(default ~/.cats/bots); CATS_BOT_ID or --id selects one when more than one exists.
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

/** Development overrides shared with the shell: see `src/core/hostEnv.ts`. */
function runtimeOverrides(env: NodeJS.ProcessEnv) {
  return readProviderOverrides(env);
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
      return `[approval] ${event.workItem.id} awaits the owner: ${event.workItem.prompt}`;
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

interface Target {
  id: string;
  root: string;
  running: ReturnType<typeof readInstanceLock>;
}

function resolveTarget(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Target {
  const id = resolveBotId(parsed.flags, env);
  const root = resolveBotRoot(id, env);
  return { id, root, running: readInstanceLock(botPathsFor(root)) };
}

function handOff(target: Target, message: Omit<HandoffMessage, 'id' | 'at'>): void {
  writeHandoff(botPathsFor(target.root), message);
  process.stdout.write(`Handed ${message.kind} to the running bot (pid ${target.running?.pid}).\n`);
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
  const target = resolveTarget(parsed, env);
  const json = parsed.flags.get('json') === true;
  const core = BotCore.open({
    root: target.root,
    runtime: runtimeOverrides(env),
    log: (line) => { if (!json) process.stderr.write(`${line}\n`); },
  });
  core.subscribe((event) => printEvent(event, json));
  await core.start();
  const status = core.status();
  if (!json) process.stdout.write(`cats-bot ${status.id} running (pid ${process.pid}); press Ctrl+C or run cats-bot quit to stop\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      void core.stop().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    core.subscribe((event) => {
      if (event.type === 'host.handoff' && event.message.kind === 'quit') stop();
    });
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
  const target = resolveTarget(parsed, env);
  if (target.running) {
    handOff(target, { kind: 'say', conversationId: conversation, text });
    return 0;
  }
  const core = BotCore.open({ root: target.root, runtime: runtimeOverrides(env), log: (line) => process.stderr.write(`${line}\n`) });
  await core.start();
  try {
    let pending: WorkItem | undefined;
    const finished = new Promise<WorkItem>((resolve) => {
      core.subscribe((event) => {
        if (event.type === 'turn.delta' && event.entry.kind === 'bot') process.stdout.write(event.entry.text);
        if (event.type === 'turn.completed' && event.workItem.id === pending?.id) resolve(event.workItem);
      });
    });
    pending = await core.sendOwnerMessage(conversation, text);
    const result = await finished;
    process.stdout.write(`\n[${result.state}]${result.error ? ` ${result.error}` : ''}\n`);
    return result.state === 'completed' ? 0 : 1;
  } finally {
    await core.stop();
  }
}

async function commandStatus(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const target = resolveTarget(parsed, env);
  const core = BotCore.open({ root: target.root, log: () => {}, tools: false });
  const profile = await core.getProfile();
  const status = core.status();
  const summary = {
    id: profile.id,
    name: profile.name,
    root: target.root,
    executionTarget: profile.executionTarget,
    configRevision: profile.configRevision,
    heartbeat: profile.heartbeat,
    idleSleepMinutes: profile.idleSleepMinutes,
    schedules: status.schedules,
    lastTickAt: status.lastTickAt,
    awaitingOwner: core.listWorkItems().filter((item) => item.state === 'awaiting_owner').map((item) => ({ id: item.id, question: item.prompt })),
    running: target.running ? { pid: target.running.pid, since: target.running.startedAt } : null,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

async function commandConversations(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const target = resolveTarget(parsed, env);
  const core = BotCore.open({ root: target.root, log: () => {}, tools: false });
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

async function commandSchedule(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const [action, ...rest] = parsed.positional;
  const target = resolveTarget(parsed, env);
  if (action === 'list') {
    const core = BotCore.open({ root: target.root, log: () => {}, tools: false });
    const schedules = await core.listSchedules();
    if (parsed.flags.get('json') === true) {
      process.stdout.write(`${JSON.stringify(schedules, null, 2)}\n`);
      return 0;
    }
    const active = schedules.filter((schedule) => schedule.state === 'active');
    if (active.length === 0) {
      process.stdout.write('No active schedules.\n');
      return 0;
    }
    for (const schedule of active) {
      process.stdout.write(`${describeSchedule(schedule)}\tnext=${schedule.nextAt ?? 'never'}\tconversation=${schedule.conversationId}\n`);
    }
    return 0;
  }
  if (action === 'cancel') {
    const id = rest[0];
    if (!id) {
      process.stderr.write('schedule cancel needs the schedule id\n');
      return 2;
    }
    if (target.running) {
      handOff(target, { kind: 'schedule_cancel', payload: { id } });
      return 0;
    }
    const core = BotCore.open({ root: target.root, log: () => {}, tools: false });
    await core.cancelSchedule(id);
    process.stdout.write(`Cancelled ${id}.\n`);
    return 0;
  }
  if (action === 'add') {
    const conversation = rest[0];
    const prompt = flagString(parsed.flags, 'prompt');
    const at = flagString(parsed.flags, 'at');
    const inMinutes = flagString(parsed.flags, 'in');
    const cron = flagString(parsed.flags, 'cron');
    if (!conversation || !prompt || (!at && !inMinutes && !cron)) {
      process.stderr.write('schedule add needs a conversation, --prompt and one of --at, --in or --cron\n');
      return 2;
    }
    const missedPolicy = flagString(parsed.flags, 'missed') as MissedPolicy | undefined;
    const input: Omit<CreateScheduleInput, 'at'> & { at?: Date } = {
      conversationId: conversation,
      prompt,
      kind: cron ? 'cron' : 'once',
      ...(cron ? { cron } : {}),
      ...(flagString(parsed.flags, 'tz') ? { timezone: flagString(parsed.flags, 'tz') } : {}),
      ...(missedPolicy ? { missedPolicy } : {}),
      createdBy: 'owner',
    };
    if (!cron) {
      input.at = at ? new Date(at) : new Date(Date.now() + Number(inMinutes) * 60_000);
    }
    if (target.running) {
      const { at: when, ...payload } = input;
      handOff(target, {
        kind: 'schedule_create',
        conversationId: conversation,
        payload: { ...payload, ...(when ? { at: when.toISOString() } : {}) },
      });
      return 0;
    }
    const core = BotCore.open({ root: target.root, log: () => {}, tools: false });
    const schedule = core.createSchedule(input as CreateScheduleInput);
    process.stdout.write(`Created ${describeSchedule(schedule)}; next ${schedule.nextAt}\n`);
    return 0;
  }
  process.stderr.write('schedule needs add, list or cancel\n');
  return 2;
}

async function commandApprove(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const [workItemId, decision] = parsed.positional;
  if (!workItemId || (decision !== 'approve' && decision !== 'deny')) {
    process.stderr.write('approve needs a work item id and approve|deny\n');
    return 2;
  }
  const target = resolveTarget(parsed, env);
  if (target.running) {
    handOff(target, { kind: 'approve', payload: { workItemId, decision } });
    return 0;
  }
  const core = BotCore.open({ root: target.root, log: () => {}, tools: false });
  await core.resolveApproval(workItemId, decision);
  process.stdout.write(`Recorded ${decision} for ${workItemId}; the bot continues on its next run.\n`);
  return 0;
}

async function commandHeartbeat(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const [action] = parsed.positional;
  if (action !== 'pause' && action !== 'resume') {
    process.stderr.write('heartbeat needs pause or resume\n');
    return 2;
  }
  const enabled = action === 'resume';
  const target = resolveTarget(parsed, env);
  if (target.running) {
    handOff(target, { kind: 'heartbeat', payload: { enabled } });
    return 0;
  }
  const core = BotCore.open({ root: target.root, log: () => {}, tools: false });
  await core.updateProfile({ heartbeat: { enabled } });
  process.stdout.write(`Heartbeat ${enabled ? 'enabled' : 'paused'}.\n`);
  return 0;
}

async function commandOpen(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const conversation = parsed.positional[0] ?? 'home';
  const target = resolveTarget(parsed, env);
  if (!target.running) {
    process.stderr.write('No running instance; start the shell or cats-bot run first.\n');
    return 1;
  }
  handOff(target, { kind: 'open', conversationId: conversation });
  return 0;
}

async function commandTelegram(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const [action, value] = parsed.positional;
  const target = resolveTarget(parsed, env);
  if (action === 'set-token' || action === 'clear-token') {
    if (action === 'set-token' && !value) {
      process.stderr.write('telegram set-token needs the token\n');
      return 2;
    }
    // The CLI has no OS credential facility: the token is stored as a file with owner-only
    // permissions where the platform supports them. A shell with OS encryption re-stores it
    // encrypted: a running one on the handoff below, otherwise on its next start.
    const store = new FileSecretStore(target.root, { warn: (line) => process.stderr.write(`${line}\n`) });
    if (action === 'set-token') store.set(SECRET_TELEGRAM_TOKEN, value!);
    else store.delete(SECRET_TELEGRAM_TOKEN);
    process.stdout.write(action === 'set-token'
      ? 'Telegram token stored with file protection. The shell re-stores it with OS encryption where the OS '
        + 'offers it (now if it is running, otherwise on its next start); `telegram status` shows the actual protection.\n'
      : 'Telegram token cleared.\n');
    if (target.running) handOff(target, { kind: 'telegram', payload: { reloadToken: true } });
    return 0;
  }
  if (action === 'enable' || action === 'disable') {
    const enabled = action === 'enable';
    if (target.running) {
      handOff(target, { kind: 'telegram', payload: { enabled } });
      return 0;
    }
    const core = BotCore.open({ root: target.root, log: () => {}, tools: false });
    await core.updateProfile({ telegram: { enabled } });
    process.stdout.write(`Telegram ${enabled ? 'enabled' : 'disabled'}; it polls while the bot runs.\n`);
    return 0;
  }
  if (action === 'status') {
    const core = BotCore.open({ root: target.root, log: () => {}, tools: false });
    process.stdout.write(`${JSON.stringify(core.telegramStatus(), null, 2)}\n`);
    return 0;
  }
  process.stderr.write('telegram needs set-token, clear-token, enable, disable or status\n');
  return 2;
}

async function commandQuit(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const target = resolveTarget(parsed, env);
  if (!target.running) {
    process.stdout.write('No running instance.\n');
    return 0;
  }
  handOff(target, { kind: 'quit' });
  return 0;
}

async function commandTick(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const target = resolveTarget(parsed, env);
  if (target.running) {
    process.stderr.write(`The bot is running (pid ${target.running.pid}); it ticks on its own.\n`);
    return 1;
  }
  const core = BotCore.open({ root: target.root, runtime: runtimeOverrides(env), log: (line) => process.stderr.write(`${line}\n`) });
  await core.start();
  try {
    const report = await core.tick();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } finally {
    await core.stop();
  }
}

async function commandProviderControl(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const target = resolveTarget(parsed, env);
  if (!target.running) throw new Error('Start the bot before inspecting or answering a live provider request.');
  const conversationId = parsed.positional[0] ?? 'home';
  const operation = parsed.command;
  const body: Record<string, unknown> = { operation, conversationId, refresh: parsed.flags.has('refresh') };
  if (operation === 'respond') {
    const interactionId = parsed.positional[1];
    if (!interactionId || parsed.positional.length > 2 || process.stdin.isTTY) {
      throw new Error('respond needs a conversation, request ID and typed JSON on stdin; answers must not be passed in argv.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += Buffer.byteLength(chunk);
      if (size > 36_864) throw new Error('Provider response exceeds its size limit.');
      chunks.push(Buffer.from(chunk));
    }
    try { body.response = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Expected typed JSON on stdin.'); }
    body.interactionId = interactionId;
  }
  const result = await callHostControl(target.root, body);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
      case 'schedule':
        return await commandSchedule(parsed, env);
      case 'approve':
        return await commandApprove(parsed, env);
      case 'interactions':
      case 'respond':
      case 'capabilities':
        return await commandProviderControl(parsed, env);
      case 'heartbeat':
        return await commandHeartbeat(parsed, env);
      case 'tick':
        return await commandTick(parsed, env);
      case 'quit':
        return await commandQuit(parsed, env);
      case 'open':
        return await commandOpen(parsed, env);
      case 'telegram':
        return await commandTelegram(parsed, env);
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
