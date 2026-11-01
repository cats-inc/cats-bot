import { execFile, spawn } from 'node:child_process';
import { join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { CLI_PROVIDERS } from '../../core/providers/catalog.ts';
import type { ProviderSetupState, SetupStep, SetupStepId } from '../../shared/providerSetup.ts';

const execute = promisify(execFile);

/** A check owns its whole process tree, including a CLI that stops answering. */
function executeCheck(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ stdout: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const output: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let stopping: Promise<void> | undefined;
    const stop = () => {
      if (stopping || !child.pid) return;
      const pid = child.pid;
      stopping = (async () => {
        if (process.platform === 'win32') {
          const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
          await execute(taskkill, ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 10_000 });
        } else {
          process.kill(-pid, 'SIGKILL');
        }
      })().catch(() => { child.kill('SIGKILL'); });
    };
    const timeout = setTimeout(() => {
      failure = new Error('The provider check timed out.');
      stop();
    }, 60_000);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        failure = new Error('The provider check returned too much output.');
        stop();
      } else output.push(chunk);
    });
    child.on('error', error => { failure = error; });
    child.on('close', () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', stop);
      void (async () => {
        await stopping;
        signal?.throwIfAborted();
        if (failure) throw failure;
        resolve({ stdout: Buffer.concat(output).toString('utf8') });
      })().catch(reject);
    });
  });
}
const FILES: Record<string, [string, string]> = {
  node: ['Install-Node.ps1', 'install-node.sh'],
  npm: ['Setup-NodeGlobalPrefix.ps1', 'setup-node-global-prefix.sh'],
  // Windows only: PowerShell may run npm's .ps1 shims, so `codex login` works there.
  shell: ['Setup-CliReadiness.ps1', ''],
  codex: ['Install-Codex.ps1', 'install-codex.sh'],
  claude: ['Install-ClaudeCode.ps1', 'install-claude-code.sh'],
  antigravity: ['Install-Antigravity.ps1', 'install-antigravity.sh'],
  grok: ['Install-Grok.ps1', 'install-grok.sh'],
  muse: ['Install-MetaCli.ps1', 'install-meta-cli.sh'],
};
export interface HelperResult {
  status: string;
  installed?: boolean;
  detectedVersion?: string;
  commandPath?: string;
  manualSteps?: string[];
  warnings?: string[];
  restartRequired?: boolean;
  interruptions?: Array<{ kind?: string }>;
}
export type SetupHelperRunner = (helper: string, apply: boolean, signal?: AbortSignal) => Promise<HelperResult>;

export function installedCommandPath(
  result: HelperResult,
  current: string,
  platform: NodeJS.Platform,
): string {
  if (!result.commandPath || !result.installed) return current;
  const paths = platform === 'win32' ? win32 : posix;
  if (!paths.isAbsolute(result.commandPath)) return current;
  return [
    ...new Set(
      [paths.dirname(result.commandPath), ...current.split(paths.delimiter)].filter(Boolean),
    ),
  ].join(paths.delimiter);
}

export function helperInvocation(
  assets: string,
  platform: NodeJS.Platform,
  helper: string,
  apply: boolean,
) {
  const file = FILES[helper];
  if (!file) throw new Error('Unknown setup helper');
  if (platform === 'win32')
    return {
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(assets, 'Invoke-SetupHelper.ps1'),
        '-Helper',
        helper,
        ...(apply ? ['-Apply'] : []),
      ],
    };
  if (platform !== 'darwin' && platform !== 'linux')
    throw new Error('Provider setup is unavailable on this platform');
  if (!file[1]) throw new Error('This setup step is for Windows only');
  return {
    command: '/bin/bash',
    args: [
      join(assets, platform === 'darwin' ? 'macos' : 'linux', file[1]),
      apply ? '-Apply' : '-CheckOnly',
      '-Json',
    ],
  };
}

/**
 * `onCommandDirectory` hears of each provider CLI directory a helper found, so
 * the shell can hand it to its core, which runs in another process.
 */
export function createHelperRunner(assets: string, onCommandDirectory?: (directory: string) => void): SetupHelperRunner {
  return async (helper, apply, signal) => {
    signal?.throwIfAborted();
    const invocation = helperInvocation(assets, process.platform, helper, apply);
    // Electron's bundled Node must never pretend to be the user's Node/npm.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let stdout: string;
    try {
      ({ stdout } = await (apply ? execute(invocation.command, invocation.args, {
        windowsHide: true,
        env,
        timeout: 15 * 60_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      }) : executeCheck(invocation.command, invocation.args, env, signal)));
    } catch (error) {
      signal?.throwIfAborted();
      const output = (error as { stdout?: string }).stdout;
      if (!output)
        throw new Error(
          'The provider helper could not complete. Check your installation and try again.',
        );
      stdout = output;
    }
    signal?.throwIfAborted();
    let result: HelperResult;
    try {
      result = JSON.parse(stdout.replace(/^\uFEFF/u, '').trim()) as HelperResult;
    } catch {
      throw new Error('The provider helper returned an unreadable result.');
    }
    if (!result || typeof result.status !== 'string')
      throw new Error('The provider helper returned no status.');
    // Check-only helpers resolve the actual installed binary. Make the same
    // directory available to Runtime without requiring the app to relaunch.
    process.env.PATH = installedCommandPath(result, process.env.PATH ?? process.env.Path ?? '', process.platform);
    const paths = process.platform === 'win32' ? win32 : posix;
    if (result.installed && result.commandPath && paths.isAbsolute(result.commandPath)) {
      onCommandDirectory?.(paths.dirname(result.commandPath));
    }
    return result;
  };
}

/** Provider-first setup. No helper path or shell argument crosses renderer IPC. */
export class ProviderSetup {
  private readonly runHelper: SetupHelperRunner;
  private selected: string | null = null;
  private active: { controller: AbortController; installing: boolean } | null = null;
  private waiters: Array<() => void> = [];
  private readonly windows: boolean;
  constructor(runHelper: SetupHelperRunner, options: { windows?: boolean } = {}) {
    this.runHelper = runHelper;
    this.windows = options.windows ?? process.platform === 'win32';
  }
  get busy(): boolean {
    return this.active !== null;
  }
  get installing(): boolean {
    return this.active?.installing === true;
  }
  /** Read-only probes must never keep a closing app alive. Installs drain normally. */
  cancelCheck(): void {
    if (this.active && !this.active.installing) this.active.controller.abort();
  }
  whenIdle(): Promise<void> {
    return this.active
      ? new Promise((resolve) => {
          this.waiters.push(resolve);
        })
      : Promise.resolve();
  }

  /** A GUI launch has no login-shell PATH. Re-resolve only the saved provider, without installing. */
  async prepareEnvironment(provider: string): Promise<void> {
    if (!CLI_PROVIDERS.some((item) => item.id === provider)) return;
    await this.exclusive(async (signal) => {
      if (provider === 'codex') await this.run('node', false, signal);
      await this.run(provider, false, signal);
    });
  }

  private assertProvider(provider: unknown): asserts provider is string {
    if (!CLI_PROVIDERS.some((item) => item.id === provider))
      throw new Error('Choose a supported provider');
  }
  private async run(helper: string, apply: boolean, signal: AbortSignal): Promise<HelperResult> {
    signal.throwIfAborted();
    const result = await this.runHelper(helper, apply, signal);
    signal.throwIfAborted();
    return result;
  }
  private async exclusive<T>(work: (signal: AbortSignal) => Promise<T>, installing = false, owner?: AbortSignal): Promise<T> {
    if (this.active) throw new Error('Wait for the current setup operation to finish');
    const controller = new AbortController();
    const signal = owner ? AbortSignal.any([controller.signal, owner]) : controller.signal;
    signal.throwIfAborted();
    this.active = { controller, installing };
    try {
      return await work(signal);
    } finally {
      this.active = null;
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }
  check(provider: unknown, signal?: AbortSignal): Promise<ProviderSetupState> {
    this.assertProvider(provider);
    return this.exclusive(async (signal) => {
      this.selected = provider;
      return this.inspect(provider, signal);
    }, false, signal);
  }
  install(provider: unknown, step: unknown): Promise<ProviderSetupState> {
    this.assertProvider(provider);
    if (provider !== this.selected) throw new Error('Check this provider before installing it');
    if (
      !['node', 'npm', 'shell', 'provider'].includes(String(step)) ||
      (step !== 'provider' && provider !== 'codex') ||
      (step === 'shell' && !this.windows)
    )
      throw new Error('This prerequisite is outside the selected provider');
    return this.exclusive(async (signal) => {
      if (provider === 'codex' && step !== 'node') {
        const before = await this.inspect(provider, signal);
        // Each step needs the ones above it, as the page shows them.
        const order = before.steps.map((item) => item.id);
        const needed = order.slice(0, order.indexOf(step as SetupStepId));
        if (before.steps.some((item) => needed.includes(item.id) && item.status !== 'ready'))
          throw new Error(step === 'npm' || (step === 'provider' && !this.windows)
            ? 'Complete Node.js and npm setup first'
            : 'Complete the steps above first');
      }
      const applied = await this.run(step === 'provider' ? provider : (step as string), true, signal);
      const checked = await this.inspect(provider, signal);
      const target = checked.steps.find((item) => item.id === step)!;
      // A failure or a refused elevation always stands. A restart or relaunch the helper
      // asks for stands only while the fresh probe cannot confirm the step: the runner
      // already hands a found CLI's folder to Runtime and every core.
      const done = stepDone(target);
      // Install-Node reports a declined UAC prompt as `changes_required` with an elevation interruption.
      const status =
        applied.status !== 'ready' &&
        applied.interruptions?.some((item) => item.kind === 'elevation_required')
          ? 'elevation_required'
          : applied.status;
      const interrupted =
        ['elevation_required', 'failed'].includes(status) ||
        (!done &&
          (applied.restartRequired === true ||
            ['restart_required', 'relaunch_required'].includes(status)));
      target.manualSteps = distinctLines([...target.manualSteps, ...(applied.manualSteps ?? [])]);
      // An installer's diagnostics explain a step that is not done; a finished step drops them.
      if (interrupted || !done)
        target.warnings = distinctLines([...target.warnings, ...(applied.warnings ?? [])]);
      if (interrupted) {
        target.status = status;
        target.restartRequired = applied.restartRequired === true;
        checked.canFinish = false;
      }
      return checked;
    }, true);
  }
  private async inspect(provider: string, signal: AbortSignal): Promise<ProviderSetupState> {
    const steps: SetupStep[] = [];
    const helpers: Array<[SetupStepId, string, string]> =
      provider === 'codex'
        ? [
            ['node', 'node', 'Node.js and npm'],
            ['npm', 'npm', 'npm installation folder'],
            ...(this.windows ? [['shell', 'shell', 'PowerShell scripts'] as [SetupStepId, string, string]] : []),
            ['provider', provider, 'Codex'],
          ]
        : [['provider', provider, CLI_PROVIDERS.find((item) => item.id === provider)!.label]];
    for (const [id, helper, label] of helpers) {
      if (id !== 'node' && steps.some((step) => step.status !== 'ready')) {
        steps.push({
          id,
          label,
          status: 'prerequisite_required',
          installed: false,
          version: null,
          warnings: [],
          manualSteps: [],
          restartRequired: false,
        });
        continue;
      }
      const result = await this.run(helper, false, signal);
      steps.push({
        id,
        label,
        status: result.status,
        installed: result.installed === true || result.status === 'ready',
        version: result.detectedVersion ?? null,
        warnings: result.warnings ?? [],
        manualSteps: result.manualSteps ?? [],
        restartRequired: result.restartRequired === true,
      });
    }
    return { provider, steps, canFinish: steps.every(stepDone) };
  }
}

/** Ready, or a provider that is installed and waits only for the owner's sign-in. */
function stepDone(step: SetupStep): boolean {
  return (
    !step.restartRequired &&
    (step.status === 'ready' ||
      (step.id === 'provider' && step.installed && step.status === 'auth_required'))
  );
}

/** A check and an install word the same help line with or without code quotes; it shows once. */
function distinctLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = line.replace(/`/gu, '').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
