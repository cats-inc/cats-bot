import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { ChannelError, HostChannelClient, readChannelOwner, type ChannelHostIdentity, type ChannelHostServices } from '../../core/host-api/channel.ts';
import { remoteBotCore, type RemoteBotCore } from '../../core/host-api/remote.ts';
import { readInstanceLock } from '../../core/store/lock.ts';
import { botPathsFor } from '../../core/store/paths.ts';
import { rotateStderrLog } from '../../shared/stderrLog.ts';
import { processIsAlive } from './update/installation.ts';

/**
 * PLAN-009 1.3 (SPEC-008 FR-7, FR-10, FR-15): the shell runs its bot's core as
 * a process of its own and reaches it only through the host channel. Closing
 * or losing the shell leaves the core running, and the next shell of the same
 * installation reattaches to it; Quit stops it through the channel. No
 * Electron here, so tests run it with node.
 */

/** The bot's lock stayed held without a channel to attach to, for example by `cats-bot say` running a turn. */
export class CoreBusyError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`The bot is in use by another process (pid ${pid}); it starts once that ends.`);
    this.name = 'CoreBusyError';
    this.pid = pid;
  }
}

/** How long a stopping core may take to answer `quit` before only its process is watched. */
const QUIT_ANSWER_MS = 5_000;

export class CoreHostedElsewhereError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`Another instance of this bot is running (pid ${pid}).`);
    this.name = 'CoreHostedElsewhereError';
    this.pid = pid;
  }
}

export interface CoreLaunch {
  /** Runs the core: the shell's own executable as Node, or node itself in tests. */
  execPath: string;
  /** For an Electron executable (`ELECTRON_RUN_AS_NODE`, SPEC-008 FR-7). */
  runAsNode: boolean;
  /** The headless host entry: `dist/cli/main.js` in a build. */
  entry: string;
  catsBotHome: string;
  botId: string;
  manager: string;
  hostCipher?: string;
  runtimeEntry?: string;
  helperPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CoreHostOptions {
  host: ChannelHostIdentity;
  services?: ChannelHostServices;
  /** How long a new core may take to publish its channel. */
  startTimeoutMs?: number;
  /** How long to wait for a core that holds the bot's lock but has not published its channel yet. */
  lockWaitMs?: number;
}

export interface HostedCore {
  readonly core: RemoteBotCore;
  readonly client: HostChannelClient;
  readonly pid: number;
  /** False when the shell reattached to a core it started before. */
  readonly started: boolean;
  /** Where the core writes its log lines. */
  readonly logFile: string;
  /** Stops the core through the channel and waits for its process; after the timeout its process tree is killed. */
  stop(timeoutMs?: number): Promise<void>;
}

/** `--json` keeps the log lines out of stderr; the core writes them to its own log file. */
export function coreArguments(launch: CoreLaunch): string[] {
  return [
    launch.entry, 'run', '--id', launch.botId, '--manager', launch.manager, '--json',
    ...(launch.hostCipher ? ['--host-cipher', launch.hostCipher] : []),
    ...(launch.runtimeEntry ? ['--runtime-entry', launch.runtimeEntry] : []),
    ...(launch.helperPath ? ['--desktop-control-helper', launch.helperPath] : []),
  ];
}

/** SPEC-001 FR-5 hygiene: the core chooses its own Runtime settings and learns its bot from its arguments. */
export function coreEnvironment(launch: CoreLaunch): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(launch.env ?? process.env)) {
    if (/^CATS_RUNTIME_/iu.test(key) || /^(?:CATS_BOT_ID|CATS_BOT_HOME|CATS_BOT_MANAGED_STDERR|ELECTRON_RUN_AS_NODE)$/iu.test(key)) continue;
    env[key] = value;
  }
  env.CATS_BOT_HOME = launch.catsBotHome;
  env.CATS_BOT_MANAGED_STDERR = '1';
  if (launch.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

/** The log the core writes itself. */
export function coreLogFile(root: string): string {
  return join(botPathsFor(root).logs, 'core.log');
}

/** What the core's process printed to stderr, such as a crash before its log opened; kept per start. */
export function coreErrorFile(root: string): string {
  return join(botPathsFor(root).logs, 'core-stderr.log');
}

/** Reattaches to this installation's running core for the bot in `root`, or starts one. */
/**
 * Reattaches to this installation's running core for the bot in `root`, or
 * starts one. A process that holds the bot's lock without a channel (a core
 * starting or stopping, the CLI writing the profile) is waited for: the core
 * starts as soon as the lock is free, or attaches once the channel is up.
 */
export async function attachOrStartCore(root: string, launch: CoreLaunch, options: CoreHostOptions): Promise<HostedCore> {
  const paths = botPathsFor(root);
  const deadline = Date.now() + (options.lockWaitMs ?? 10_000);
  for (;;) {
    const owner = liveOwner(root);
    if (owner) {
      // SPEC-008 FR-11: a core another host started is never taken over.
      if (owner.manager !== launch.manager) throw new CoreHostedElsewhereError(owner.pid);
      try {
        return hosted(await connect(root, options), owner.pid, false, coreLogFile(root));
      } catch (error) {
        // A core that is stopping has closed its channel but still holds its lock.
        if (!isGone(error)) throw error;
      }
    } else if (!readInstanceLock(paths)) {
      return startCore(root, launch, options);
    }
    // A lock held without a channel past the wait is a busy bot, not another host's core:
    // the runner tries again later (review of #66).
    if (Date.now() >= deadline) throw new CoreBusyError(readInstanceLock(paths)?.pid ?? owner?.pid ?? 0);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'ECONNRESET'
    || (error instanceof ChannelError && (error.reason === 'closed' || error.reason === 'descriptor'));
}

/** The descriptor's process while it also holds the bot's lock; a stale descriptor names neither. */
function liveOwner(root: string): { pid: number; manager: string | null } | null {
  const owner = readChannelOwner(root);
  if (!owner) return null;
  const lock = readInstanceLock(botPathsFor(root));
  return lock?.pid === owner.pid ? owner : null;
}


function connect(root: string, options: CoreHostOptions): Promise<HostChannelClient> {
  return HostChannelClient.connect(root, { host: options.host, ...(options.services ? { services: options.services } : {}) });
}

async function startCore(root: string, launch: CoreLaunch, options: CoreHostOptions): Promise<HostedCore> {
  const logFile = coreLogFile(root);
  const errorFile = coreErrorFile(root);
  mkdirSync(join(errorFile, '..'), { recursive: true });
  const stderr = openSync(errorFile, 'a+', 0o600);
  rotateStderrLog(errorFile, stderr, true);
  let child: ChildProcess;
  try {
    child = spawn(launch.execPath, coreArguments(launch), {
      env: coreEnvironment(launch),
      detached: true,
      windowsHide: true,
      // stdout carries the events, conversation text included; it is never kept.
      stdio: ['ignore', 'ignore', stderr],
    });
  } finally {
    closeSync(stderr);
  }
  let ended: string | null = null;
  child.once('error', (error) => { ended = error.message; });
  child.once('exit', (code, signal) => { ended = `exit ${code ?? signal}`; });
  child.unref();
  const pid = child.pid;
  const published = await waitFor(() => {
    if (ended) return 'ended';
    return pid && readChannelOwner(root)?.pid === pid ? 'published' : null;
  }, options.startTimeoutMs ?? 60_000);
  if (published !== 'published') {
    if (pid && !ended) killTree(pid);
    throw new Error(`The Bot core did not start (${ended ?? 'timed out'}). See ${errorFile} and ${logFile}.`);
  }
  return hosted(await connect(root, options), pid!, true, logFile);
}

function hosted(client: HostChannelClient, pid: number, started: boolean, logFile: string): HostedCore {
  return {
    core: remoteBotCore(client),
    client,
    pid,
    started,
    logFile,
    async stop(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      // A core that no longer answers is not waited for beyond the deadline.
      if (!client.isClosed) {
        await Promise.race([
          client.call('quit').catch(() => { /* already stopping */ }),
          new Promise((resolveWait) => setTimeout(resolveWait, Math.min(QUIT_ANSWER_MS, timeoutMs)).unref?.()),
        ]);
      }
      if (!(await waitFor(() => !processIsAlive(pid), Math.max(0, deadline - Date.now())))) {
        killTree(pid);
        await waitFor(() => !processIsAlive(pid), 5_000);
      }
      client.close();
    },
  };
}

/** The core and the Runtime, CLI and helper it started (SPEC-008 FR-10). */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      spawnSync(taskkill, ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
    } else {
      // The core was started detached, so it leads its own process group.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

async function waitFor<T>(check: () => T | null | false, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}
