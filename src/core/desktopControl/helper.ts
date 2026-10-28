import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * SPEC-006 BDC-01 / SPEC-133 R7: the Node side of the Bot's native desktop control helper
 * (`native/windows-desktop-control/`). It starts the helper on first use, speaks protocol 1
 * (one JSON object per line), ends it after five idle minutes and stops restarting it after
 * more than three crashes within five minutes (DC-16). A helper that answers `hello` with
 * another protocol stays unavailable until the owner turns the feature off and on.
 */

export const DESKTOP_CONTROL_PROTOCOL = 1;
export const HELPER_BINARY = 'cats-desktop-control-windows.exe';
const IDLE_EXIT_MS = 5 * 60_000;
const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_CRASHES = 3;

export class DesktopControlHelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DesktopControlHelperError';
    this.code = code;
  }
}

/** The subset of a child process the client needs; tests pass a fake. */
export interface DesktopControlHelperProcess {
  stdin: { write(chunk: string): boolean; end(): void };
  stdout: NodeJS.ReadableStream;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

export type DesktopControlSpawn = (path: string) => DesktopControlHelperProcess;

export interface DesktopControlHelperOptions {
  path: string;
  selfProcessIds: number[];
  selfExecutables: string[];
  spawn?: DesktopControlSpawn;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: unknown;
}

export interface DesktopControlHelperClient {
  call<T = Record<string, unknown>>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** Starts the helper and completes `hello` unless that already succeeded once (BDC-01). */
  handshake(): Promise<void>;
  /** null while usable; otherwise why the helper cannot be used. */
  unavailableReason(): string | null;
  /** Ends the process and forgets crash and handshake history, for example when the owner turns the feature off. */
  reset(): void;
  close(): void;
}

export function createDesktopControlHelperClient(options: DesktopControlHelperOptions): DesktopControlHelperClient {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  });
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  // stderr is ignored: the helper never needs to report there, and nothing it says reaches the logs.
  const spawn = options.spawn ?? ((path: string) => spawnProcess(path, [], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  }) as unknown as DesktopControlHelperProcess);

  let child: DesktopControlHelperProcess | null = null;
  let ready: Promise<void> | null = null;
  let verified = false;
  let handshakeFailed: string | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let crashes: number[] = [];
  let idleTimer: unknown = null;
  let closed = false;

  function failAll(code: string, message: string): void {
    for (const [id, entry] of pending) {
      clearTimer(entry.timer);
      entry.reject(new DesktopControlHelperError(code, message));
      pending.delete(id);
    }
  }

  function stop(): void {
    const current = child;
    child = null;
    ready = null;
    if (current) {
      try { current.stdin.end(); } catch { /* already gone */ }
      current.kill();
    }
  }

  function armIdle(): void {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (pending.size === 0) stop();
    }, IDLE_EXIT_MS);
  }

  function send(op: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const target = child;
    if (!target) return Promise.reject(new DesktopControlHelperError('executor_failed', 'The helper is not running.'));
    const id = nextId++;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimer(() => {
        pending.delete(id);
        rejectCall(new DesktopControlHelperError('executor_failed', `The helper did not answer ${op} in time.`));
      }, timeoutMs);
      pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      try {
        target.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
      } catch {
        pending.delete(id);
        clearTimer(timer);
        rejectCall(new DesktopControlHelperError('executor_failed', 'The helper stopped.'));
      }
    });
  }

  function start(): Promise<void> {
    let process: DesktopControlHelperProcess;
    try {
      process = spawn(options.path);
    } catch {
      return Promise.reject(new DesktopControlHelperError('unavailable', 'The desktop control helper could not start.'));
    }
    child = process;
    createInterface({ input: process.stdout }).on('line', (line) => {
      let message: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
      try { message = JSON.parse(line) as typeof message; } catch { return; }
      if (typeof message.id !== 'number') return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimer(entry.timer);
      if (message.ok === true) entry.resolve(message.result);
      else entry.reject(new DesktopControlHelperError(
        typeof message.error?.code === 'string' ? message.error.code : 'executor_failed',
        typeof message.error?.message === 'string' ? message.error.message : 'The helper failed.',
      ));
    });
    process.once('exit', () => {
      if (child !== process) return;
      child = null;
      ready = null;
      crashes = [...crashes.filter((at) => now() - at < CRASH_WINDOW_MS), now()];
      failAll('executor_failed', 'The desktop control helper stopped.');
    });
    return send('hello', {
      protocol: DESKTOP_CONTROL_PROTOCOL,
      selfProcessIds: options.selfProcessIds,
      selfExecutables: options.selfExecutables,
    }, 15_000).then((result) => {
      const hello = result as { protocol?: unknown; platform?: unknown };
      if (hello.protocol !== DESKTOP_CONTROL_PROTOCOL || hello.platform !== 'win32') {
        handshakeFailed = 'handshake_failed';
        stop();
        throw new DesktopControlHelperError('unavailable', 'The desktop control helper speaks another protocol.');
      }
      verified = true;
    }, (error: unknown) => {
      // `hello` itself was refused (for example an unsupported protocol): the helper is not usable.
      if (error instanceof DesktopControlHelperError && error.code !== 'executor_failed') {
        handshakeFailed = 'handshake_failed';
        stop();
      }
      throw error;
    });
  }

  function unavailableReason(): string | null {
    if (closed) return 'closed';
    if (handshakeFailed) return handshakeFailed;
    const recent = crashes.filter((at) => now() - at < CRASH_WINDOW_MS);
    return recent.length > MAX_CRASHES ? 'helper_crashed' : null;
  }

  async function ensureStarted(): Promise<void> {
    const reason = unavailableReason();
    if (reason) throw new DesktopControlHelperError('unavailable', `Desktop control is unavailable (${reason}).`);
    if (!ready) {
      ready = start();
      ready.catch(() => { ready = null; });
    }
    await ready;
    armIdle();
  }

  return {
    async call<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
      await ensureStarted();
      return await send(op, params, timeoutMs) as T;
    },
    async handshake(): Promise<void> {
      if (verified && !unavailableReason()) return;
      await ensureStarted();
    },
    unavailableReason,
    reset() {
      failAll('stopped', 'Desktop control was stopped.');
      stop();
      crashes = [];
      handshakeFailed = null;
      verified = false;
    },
    close() {
      closed = true;
      if (idleTimer) clearTimer(idleTimer);
      failAll('unavailable', 'Desktop control closed.');
      stop();
    },
  };
}

/** The development build of the helper in this checkout (`dotnet build -c Release`). */
export function developmentHelperPath(repoRoot = resolve(import.meta.dirname, '..', '..', '..')): string {
  return join(repoRoot, 'native', 'windows-desktop-control', 'bin', 'Release', 'net8.0-windows10.0.19041.0', HELPER_BINARY);
}

/** Where a packaged Windows build carries the helper (`resources/native/windows-desktop-control/`). */
export function packagedHelperPath(resourcesPath: string): string {
  return join(resourcesPath, 'native', 'windows-desktop-control', HELPER_BINARY);
}

/**
 * Cats Desktop's default per-user and per-machine install locations. The helper matches
 * `selfExecutables` on the full path, so these make an installed Cats Desktop never grantable
 * (BDC-08); the service also refuses `Cats.exe` by file name wherever it is installed.
 */
export function catsDesktopExecutables(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : null,
    env.ProgramFiles ?? null,
    env['ProgramFiles(x86)'] ?? null,
  ].filter((root): root is string => Boolean(root));
  return roots.map((root) => join(root, 'Cats', 'Cats.exe'));
}

export interface DesktopControlHelperResolution {
  /** null when this host cannot run the helper (BDC-01). */
  path: string | null;
  unavailableReason: string | null;
}

/** BDC-01: Windows only, and only when the helper file exists. */
export function resolveDesktopControlHelper(options: {
  platform?: NodeJS.Platform;
  /** An explicit path; null means this host offers no helper. Defaults to the development build. */
  helperPath?: string | null;
  /** Tests pass a fake process, so no file needs to exist. */
  skipExistenceCheck?: boolean;
} = {}): DesktopControlHelperResolution {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { path: null, unavailableReason: 'not_windows' };
  if (options.helperPath === null) return { path: null, unavailableReason: 'no_helper' };
  const path = options.helperPath ?? developmentHelperPath();
  if (!options.skipExistenceCheck && !existsSync(path)) return { path: null, unavailableReason: 'helper_missing' };
  return { path, unavailableReason: null };
}
