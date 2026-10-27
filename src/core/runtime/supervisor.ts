import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import { RuntimeClient } from './client.ts';
import { ensureProvidersConfig, type ProvidersConfigInput } from './providersConfig.ts';
import type { RuntimeState } from '../types.ts';

/**
 * SPEC-001 FR-5 to FR-8: the bot owns one app-managed cats-runtime child.
 * Start waits for `runtime.ready` on stdout and then for `GET /health` to say
 * ready; stop closes stdin and escalates to signals only after the grace
 * period. Restart timing is a pure function so the reconcile tick owns the
 * backoff.
 */

export const RUNTIME_RESTART_DELAYS_MS = [5_000, 30_000, 120_000, 300_000] as const;

export function runtimeRestartDelayMs(attempt: number): number {
  const index = Math.max(0, Math.min(attempt, RUNTIME_RESTART_DELAYS_MS.length - 1));
  return RUNTIME_RESTART_DELAYS_MS[index]!;
}

export type RuntimeSupervisorEvent =
  | { type: 'state'; state: RuntimeState; detail?: string }
  | { type: 'ready'; baseUrl: string }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null; expected: boolean }
  | { type: 'log'; line: string };

export interface RuntimeSupervisorOptions {
  runtimeDir: string;
  providers: ProvidersConfigInput;
  nodeExecPath?: string;
  runtimeEntry?: string;
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  fetch?: typeof fetch;
  onEvent?: (event: RuntimeSupervisorEvent) => void;
}

interface LifecycleLine {
  event?: string;
  healthUrl?: string;
  host?: string;
  port?: number;
  error?: string;
  reason?: string;
}

const require = createRequire(import.meta.url);

/** The pinned package's bin, run with the host's own Node (ADR-001 §1). */
export function resolveRuntimeEntry(): string {
  const packageJson = require.resolve('@cats-inc/cats-runtime/package.json');
  return join(dirname(packageJson), 'build', 'runtime', 'index.js');
}

/**
 * cats-runtime 0.6.1 rejects `--port 0`, so the core reserves a free loopback
 * port itself; `runtime.ready` still reports the port actually bound.
 */
export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('Could not reserve a loopback port'))));
    });
  });
}

function stripRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('CATS_RUNTIME_')) continue;
    clean[key] = value;
  }
  return clean;
}

export class RuntimeSupervisor {
  readonly runtimeDir: string;
  private readonly options: RuntimeSupervisorOptions;
  private child: ChildProcess | null = null;
  private stopping = false;
  private failed = false;
  private _state: RuntimeState = 'stopped';
  private _baseUrl: string | null = null;
  private _apiKey: string = '';
  private _client: RuntimeClient | null = null;
  private _pid: number | null = null;
  private exited: Promise<void> | null = null;

  constructor(options: RuntimeSupervisorOptions) {
    this.options = options;
    this.runtimeDir = options.runtimeDir;
  }

  get state(): RuntimeState {
    return this._state;
  }

  get baseUrl(): string | null {
    return this._baseUrl;
  }

  get pid(): number | null {
    return this._pid;
  }

  /** Available once `start()` resolved; null while stopped or failed. */
  get client(): RuntimeClient | null {
    return this._client;
  }

  private emit(event: RuntimeSupervisorEvent): void {
    this.options.onEvent?.(event);
  }

  private setState(state: RuntimeState, detail?: string): void {
    this._state = state;
    this.emit({ type: 'state', state, ...(detail ? { detail } : {}) });
  }

  async start(): Promise<RuntimeClient> {
    if (this._state === 'starting' || this._state === 'ready') {
      throw new Error(`Runtime is already ${this._state}`);
    }
    mkdirSync(this.runtimeDir, { recursive: true });
    ensureProvidersConfig(this.runtimeDir, this.options.providers);
    this.stopping = false;
    this.failed = false;
    this._apiKey = randomBytes(24).toString('base64url');
    this._baseUrl = null;
    this._client = null;
    this.setState('starting');

    const env: NodeJS.ProcessEnv = {
      ...stripRuntimeEnv(this.options.env ?? process.env),
      CATS_RUNTIME_DIR: this.runtimeDir,
      CATS_RUNTIME_API_KEY: this._apiKey,
      CATS_RUNTIME_NATIVE_DISCOVERY_INTERVAL_MS: '0',
      CATS_RUNTIME_WSL_DISCOVERY_POLICY: 'manual_only',
      CATS_RUNTIME_DOCKER_DISCOVERY_POLICY: 'manual_only',
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };
    const entry = this.options.runtimeEntry ?? resolveRuntimeEntry();
    let port: number;
    try {
      port = await reserveLoopbackPort();
    } catch (error) {
      this.setState('failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
    const child = spawn(
      this.options.nodeExecPath ?? process.execPath,
      [
        entry,
        '--startup-mode',
        'app-managed',
        '--managed-by',
        'cats-bots',
        '--ready-output',
        'json',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child = child;
    this._pid = child.pid ?? null;

    let settled = false;
    const ready = new Promise<RuntimeClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`cats-runtime did not become ready within ${this.options.readyTimeoutMs ?? 60_000}ms`));
      }, this.options.readyTimeoutMs ?? 60_000);
      timer.unref?.();
      const finish = (error: Error | null, client?: RuntimeClient) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(client!);
      };

      const stdout = createInterface({ input: child.stdout! });
      stdout.on('line', (line) => {
        this.emit({ type: 'log', line });
        let parsed: LifecycleLine | null = null;
        try {
          parsed = JSON.parse(line) as LifecycleLine;
        } catch {
          parsed = null;
        }
        if (!parsed || typeof parsed.event !== 'string') return;
        if (parsed.event === 'runtime.ready') {
          const baseUrl = parsed.healthUrl
            ? parsed.healthUrl.replace(/\/health\/?$/u, '')
            : `http://${parsed.host ?? '127.0.0.1'}:${parsed.port}`;
          void this.confirmReady(baseUrl).then(
            (client) => finish(null, client),
            (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
          );
        } else if (parsed.event === 'runtime.startup_error') {
          finish(new Error(parsed.error ?? 'cats-runtime failed to start'));
        }
      });
      const stderr = createInterface({ input: child.stderr! });
      stderr.on('line', (line) => this.emit({ type: 'log', line: `[stderr] ${line}` }));

      child.once('error', (error) => {
        finish(error);
      });
      this.exited = new Promise<void>((resolveExit) => {
        child.once('exit', (code, signal) => {
          const expected = this.stopping && !this.failed;
          if (this.child === child) {
            this.child = null;
            this._client = null;
            this._pid = null;
            this.setState(expected ? 'stopped' : 'failed', expected ? undefined : `exited with ${code ?? signal}`);
          }
          this.emit({ type: 'exit', code, signal, expected });
          finish(new Error(`cats-runtime exited with ${code ?? signal} before becoming ready`));
          resolveExit();
        });
      });
    });

    try {
      const client = await ready;
      return client;
    } catch (error) {
      if (this.child === child) {
        this.failed = true;
        this.stopping = true;
        this.setState('failed', error instanceof Error ? error.message : String(error));
        child.kill('SIGTERM');
      }
      throw error;
    }
  }

  private async confirmReady(baseUrl: string): Promise<RuntimeClient> {
    const client = new RuntimeClient({
      baseUrl,
      apiKey: this._apiKey,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 60_000);
    let lastError = 'health not ready';
    while (Date.now() < deadline) {
      try {
        const health = await client.health();
        if (health.readiness?.ready === true || health.startup?.phase === 'ready') {
          this._baseUrl = baseUrl;
          this._client = client;
          this.setState('ready');
          this.emit({ type: 'ready', baseUrl });
          return client;
        }
        lastError = `health phase ${health.startup?.phase ?? health.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`cats-runtime health never reported ready: ${lastError}`);
  }

  /** SPEC-001 FR-7: stdin first, then SIGTERM after the grace period, then SIGKILL. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      if (this._state !== 'stopped') this.setState('stopped');
      return;
    }
    this.stopping = true;
    const timeoutMs = this.options.stopTimeoutMs ?? 10_000;
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    const exited = this.exited ?? Promise.resolve();
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref?.()),
    ]);
    if (!graceful) {
      child.kill('SIGTERM');
      const terminated = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000).unref?.()),
      ]);
      if (!terminated) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    this.child = null;
    this._client = null;
    this._baseUrl = null;
    this._pid = null;
    if (this._state !== 'stopped') this.setState('stopped');
  }
}
