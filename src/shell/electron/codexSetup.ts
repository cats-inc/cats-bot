import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import type { CodexInitialization } from '../../shared/providerSetup.ts';
import { findOnPath } from '../../core/providers/catalog.ts';

let workspace: string | undefined;
/** An empty, owned folder: never initialize Codex in System32, the installation or the user's home. */
export function codexSetupWorkspace(): string {
  return workspace ??= mkdtempSync(join(tmpdir(), 'cats-bot-codex-setup-'));
}

export interface CodexSetupInvocation { command: string; args: string[]; env: NodeJS.ProcessEnv }

/** The npm launcher chooses by Node's architecture, which can differ from Electron's. */
function nodeArchitecture(file: string): 'x64' | 'arm64' | null {
  const descriptor = openSync(file, 'r');
  try {
    const header = Buffer.alloc(64), signature = Buffer.alloc(6);
    if (readSync(descriptor, header, 0, 64, 0) !== 64 || header.readUInt16LE(0) !== 0x5a4d) return null;
    const offset = header.readUInt32LE(60);
    if (readSync(descriptor, signature, 0, 6, offset) !== 6 || signature.readUInt32LE(0) !== 0x4550) return null;
    return signature.readUInt16LE(4) === 0x8664 ? 'x64' : signature.readUInt16LE(4) === 0xaa64 ? 'arm64' : null;
  } finally { closeSync(descriptor); }
}

/** Resolve the same official native executable used by Runtime, without a PowerShell shim. */
export function codexSetupInvocation(commandPath: string | undefined, env: NodeJS.ProcessEnv): CodexSetupInvocation | null {
  if (!commandPath) return null;
  if (extname(commandPath).toLowerCase() === '.exe') return { command: commandPath, args: ['app-server'], env };
  try {
    const base = dirname(commandPath);
    const packageRoot = join(base, 'node_modules', '@openai', 'codex');
    const script = join(packageRoot, 'bin', 'codex.js');
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== '@openai/codex' || resolve(packageRoot, manifest.bin?.codex ?? '') !== script) return null;
    const shim = readFileSync(commandPath, 'utf8').replaceAll('\\', '/');
    const extension = extname(commandPath).toLowerCase();
    const officialShim = extension === '.ps1'
      ? /&\s+"(?:\$basedir\/)?node\$exe"\s+"\$basedir\/node_modules\/@openai\/codex\/bin\/codex\.js"\s+\$args/u.test(shim)
      : ['.cmd', '.bat'].includes(extension) && /"%_prog%"\s+"%dp0%\/?node_modules\/@openai\/codex\/bin\/codex\.js"\s+%\*/u.test(shim);
    if (!officialShim) return null;
    const node = existsSync(join(base, 'node.exe')) ? join(base, 'node.exe') : findOnPath('node.exe', env, 'win32');
    const arch = node && nodeArchitecture(node);
    if (!arch) return null;
    let vendor = join(packageRoot, 'vendor');
    try { vendor = join(dirname(createRequire(script).resolve(`@openai/codex-win32-${arch}/package.json`)), 'vendor'); } catch { /* Older npm layout. */ }
    const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const executable = [join(vendor, triple, 'bin', 'codex.exe'), join(vendor, triple, 'codex', 'codex.exe')].find(existsSync);
    return executable ? { command: executable, args: ['app-server'], env: { ...env,
      CODEX_MANAGED_PACKAGE_ROOT: packageRoot, CODEX_MANAGED_BY_NPM: '1',
      CODEX_MANAGED_BY_BUN: undefined, CODEX_MANAGED_BY_PNPM: undefined, CODEX_MANAGED_BY_VITE_PLUS: undefined,
    } } : null;
  } catch { return null; }
}

interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  launch?: typeof spawn;
  timeoutMs?: number;
  invocation?: CodexSetupInvocation;
  onCommand?(command: string): void;
}

/** Public app-server preflight only. No auth files, setup/config writes, tools or model turns. */
export async function probeCodexInitialization(commandPath: string | undefined, signal?: AbortSignal, options: ProbeOptions = {}): Promise<CodexInitialization> {
  signal?.throwIfAborted();
  const env = { ...(options.env ?? process.env) };
  delete env.ELECTRON_RUN_AS_NODE;
  const invocation = options.invocation ?? codexSetupInvocation(commandPath, env);
  if (!invocation) return { status: 'unavailable' };
  let child: ChildProcessWithoutNullStreams | undefined;
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  let serial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let failed: Error | undefined;
  const fail = (error: Error) => {
    failed ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const abort = () => fail(new Error('Codex setup check stopped'));
  try {
    options.onCommand?.([invocation.command, ...invocation.args].map(value => `"${value}"`).join(' '));
    child = (options.launch ?? spawn)(invocation.command, invocation.args, {
      cwd: options.cwd ?? codexSetupWorkspace(), env: invocation.env,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.once('close', () => { closed = true; fail(new Error('Codex setup check ended')); });
    child.once('error', fail);
    child.stdin.on('error', fail);
    // Drain diagnostics but never expose configuration or account data to the renderer/log.
    child.stderr.on('data', () => {});
    let buffer = '', bytes = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) { fail(new Error('Codex setup check exceeded output limit')); return; }
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (typeof frame.id !== 'number' || frame.method || !pending.has(frame.id)) continue;
          const waiter = pending.get(frame.id)!; pending.delete(frame.id);
          if (frame.error || !frame.result || typeof frame.result !== 'object') waiter.reject(new Error('Codex setup check unavailable'));
          else waiter.resolve(frame.result);
        } catch { /* App-server may emit non-protocol diagnostics. */ }
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    timer = setTimeout(() => fail(new Error('Codex setup check timed out')), options.timeoutMs ?? 15_000);
    const rpc = (method: 'initialize' | 'windowsSandbox/readiness', params: object): Promise<Record<string, unknown>> => {
      if (failed) return Promise.reject(failed);
      const id = ++serial;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    };
    await rpc('initialize', { clientInfo: { name: 'cats-runtime', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const readiness = await rpc('windowsSandbox/readiness', {});
    if (readiness.status === 'notConfigured' || readiness.status === 'updateRequired') return { status: 'required' };
    // Even ephemeral thread/start can persist project trust in Codex 0.166.0.
    // This check never creates a thread; Runtime still verifies actual turn permissions.
    return readiness.status === 'ready' ? { status: 'ready' } : { status: 'unavailable' };
  } catch {
    signal?.throwIfAborted();
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (child && !closed) {
      // Kill the owned tree before EOF can let a wrapper exit and orphan its children.
      const owned = child;
      const close = new Promise<void>(done => owned.once('close', () => done()));
      if (owned.pid && process.platform === 'win32') {
        await new Promise<void>(done => {
          const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(owned.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
          const deadline = setTimeout(() => { owned.kill(); killer.kill(); }, 2000);
          killer.once('error', () => { owned.kill(); });
          killer.once('exit', code => { if (code !== 0) owned.kill(); });
          killer.once('close', () => { clearTimeout(deadline); done(); });
        });
      } else {
        try { if (owned.pid) process.kill(-owned.pid, 'SIGKILL'); else owned.kill(); } catch { owned.kill(); }
      }
      // Keep shutdown bounded even if a broken executable retains a pipe handle.
      await Promise.race([close, new Promise<void>(done => { const deadline = setTimeout(done, 2000); close.then(() => clearTimeout(deadline)); })]);
    }
  }
}
