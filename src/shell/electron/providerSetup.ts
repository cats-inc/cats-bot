import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { CLI_PROVIDERS } from '../../core/providers/catalog.ts';
import { signInCommand } from './setupTerminal.ts';
import {
  isSetupChange,
  isSetupHelperId,
  isUpdatableHelper,
  type ComputerSetupState,
  type ProviderSetupState,
  type SetupChange,
  type SetupHelperId,
  type SetupLogEntry,
  type SetupScript,
  type SetupSignIn,
  type SetupStep,
  type SetupStepId,
  type SetupUpdateResult,
  type CodexInitialization,
} from '../../shared/providerSetup.ts';

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
  // Windows only and optional: PowerShell may run npm's .ps1 shims, so `codex login` works there.
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
  interruptions?: Array<{ kind?: string; requiresRestart?: boolean }>;
  /** What the helper would do. Each helper uses one of these two names. */
  plannedActions?: string[];
  plannedChanges?: string[];
  appliedChanges?: string[];
}
/**
 * What a helper run does: `false` checks, `true` applies, and `'upgrade'` installs a newer
 * release of something that already works (SPEC-013 FR-8).
 */
export type HelperChange = boolean | 'upgrade';
export type SetupHelperRunner = (helper: string, change: HelperChange, signal?: AbortSignal) => Promise<HelperResult>;

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
  change: HelperChange,
) {
  const file = FILES[helper];
  if (!file) throw new Error('Unknown setup helper');
  // SPEC-013 FR-8: only these helpers' -Upgrade installs a newer release.
  if (change === 'upgrade' && !isUpdatableHelper(helper)) throw new Error('This setup step has no update');
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
        ...(change === 'upgrade' ? ['-Upgrade'] : change ? ['-Apply'] : []),
      ],
    };
  if (platform !== 'darwin' && platform !== 'linux')
    throw new Error('Provider setup is unavailable on this platform');
  if (!file[1]) throw new Error('This setup step is for Windows only');
  return {
    command: '/bin/bash',
    args: [
      join(assets, platform === 'darwin' ? 'macos' : 'linux', file[1]),
      change === 'upgrade' ? '-Upgrade' : change ? '-Apply' : '-CheckOnly',
      '-Json',
    ],
  };
}

function argumentForDisplay(value: string): string {
  return /\s/u.test(value) ? `"${value}"` : value;
}

/** SPEC-010 FR-14: the command a helper runs under, as the page's log shows it. */
export function describeHelperRun(assets: string, platform: NodeJS.Platform, helper: string, change: HelperChange): { command: string; file: string } {
  const invocation = helperInvocation(assets, platform, helper, change);
  const names = FILES[helper]!;
  return {
    command: [invocation.command, ...invocation.args].map(argumentForDisplay).join(' '),
    file: (platform === 'win32' ? names[0] : names[1]) || helper,
  };
}

interface ProvenanceFile {
  path?: unknown;
  sha256?: unknown;
}

/** SPEC-010 FR-10: which copy of a script this is, from the record the sync tool keeps beside them. */
export function createScriptIdentity(assets: string, platform: NodeJS.Platform): (helper: string) => SetupScript | null {
  let provenance: { repository?: unknown; commit?: unknown; files?: ProvenanceFile[] } = {};
  try {
    provenance = JSON.parse(readFileSync(join(assets, 'provenance.json'), 'utf8')) as typeof provenance;
  } catch {
    // Without the record a row still names its script, only without a hash.
  }
  const folder = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  const repository = typeof provenance.repository === 'string' ? provenance.repository.split('/').at(-1) : null;
  const source = repository && typeof provenance.commit === 'string' ? `${repository} ${provenance.commit.slice(0, 7)}` : null;
  return (helper) => {
    const names = FILES[helper];
    const file = names && (platform === 'win32' ? names[0] : names[1]);
    if (!file) return null;
    const record = provenance.files?.find((item) => item.path === `${folder}/${file}`);
    return { file, sha256: typeof record?.sha256 === 'string' ? record.sha256 : null, source: record ? source : null };
  };
}

/**
 * SPEC-010 FR-14: a run as the hub's diagnostics record it. Fixed words only: ADR-013
 * keeps arguments out of those files, and a helper's own text can hold home paths.
 */
export function setupRunDiagnostic(entry: SetupLogEntry): string | null {
  if (entry.phase !== 'end') return null;
  const status = entry.error ? 'failed' : /^[a-z_]{1,40}$/u.test(entry.status ?? '') ? entry.status : 'unknown';
  const changes = entry.applied?.length ? `, ${entry.applied.length} change(s)` : '';
  return `setup ${entry.kind} ${entry.helper}: ${status}${changes} in ${entry.durationMs ?? 0} ms`;
}

/**
 * `onCommandDirectory` hears of each provider CLI directory a helper found, so
 * the shell can hand it to its core, which runs in another process.
 */
export function createHelperRunner(assets: string, onCommandDirectory?: (directory: string) => void): SetupHelperRunner {
  return async (helper, change, signal) => {
    signal?.throwIfAborted();
    const invocation = helperInvocation(assets, process.platform, helper, change);
    // Electron's bundled Node must never pretend to be the user's Node/npm.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let stdout: string;
    try {
      ({ stdout } = await (change ? execute(invocation.command, invocation.args, {
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

export interface ProviderSetupOptions {
  windows?: boolean;
  codexInitialization?(commandPath: string | undefined, signal: AbortSignal, onCommand: (command: string) => void): Promise<CodexInitialization>;
  /** How a helper's run reads in the log. */
  describe?(helper: string, change: HelperChange): { command: string; file: string };
  /** Which copy of a helper's script this is. */
  identify?(helper: string): SetupScript | null;
  /** Hears every run, for the hub's diagnostics. */
  onRun?(entry: SetupLogEntry): void;
}

export type SetupLogListener = (entry: SetupLogEntry) => void;

interface SetupLink<Id extends string = SetupStepId> {
  id: Id;
  helper: string;
  label: string;
  /** Its plan cannot be known until Node.js works. */
  needsNode: boolean;
  optional: boolean;
}

/** SPEC-013 FR-4: how many read-only checks run together, so a check does not start eight PowerShells. */
const CHECKS_AT_ONCE = 3;

/** Provider-first setup. No helper path or shell argument crosses renderer IPC. */
export class ProviderSetup {
  private readonly runHelper: SetupHelperRunner;
  private selected: string | null = null;
  private active: { controller: AbortController; installing: boolean } | null = null;
  private waiters: Array<() => void> = [];
  private readonly windows: boolean;
  private readonly options: ProviderSetupOptions;
  private runs = 0;
  // Keep machine-restart advice through later checks/installs in this Hub session.
  private systemRestartReported = false;
  private systemRestartWarnings: string[] = [];
  /** SPEC-013 FR-3: the Agent CLIs tab's last results, for this hub session. */
  private computerState: ComputerSetupState | null = null;
  /** SPEC-013 FR-9: what each helper's last update found, shown while that version is still the one there. */
  private updates = new Map<string, SetupUpdateResult>();
  constructor(runHelper: SetupHelperRunner, options: ProviderSetupOptions = {}) {
    this.runHelper = runHelper;
    this.windows = options.windows ?? process.platform === 'win32';
    this.options = options;
  }
  get busy(): boolean {
    return this.active !== null;
  }
  get installing(): boolean {
    return this.active?.installing === true;
  }
  get codexSelected(): boolean {
    return this.windows && this.selected === 'codex';
  }
  /** SPEC-013 FR-11: Codex first-time setup opens from the Agent CLIs tab only once Codex works. */
  get codexReadyOnComputer(): boolean {
    return this.windows && this.readyOnComputer('codex');
  }
  /** SPEC-013 FR-10: a provider the last check of this computer found working. */
  readyOnComputer(helper: unknown): boolean {
    const step = this.computerState?.steps.find((item) => item.id === helper);
    return step !== undefined && step.id !== 'node' && step.id !== 'npm' && step.id !== 'shell' && stepDone(step);
  }
  private get platform(): string {
    return this.windows ? 'win32' : process.platform === 'win32' ? 'linux' : process.platform;
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
  private async run(helper: string, change: HelperChange, signal: AbortSignal, listener?: SetupLogListener): Promise<HelperResult> {
    signal.throwIfAborted();
    const described = this.options.describe?.(helper, change) ?? { command: `${helper}${change === 'upgrade' ? ' upgrade' : change ? ' apply' : ' check'}`, file: helper };
    const run = ++this.runs;
    const started = Date.now();
    const base = { run, kind: change ? 'change' : 'check', helper, ...described } as const;
    // Telling a page about a run never changes how the run goes: a helper may already have changed the computer.
    const emit = (entry: SetupLogEntry) => {
      for (const hear of [listener, this.options.onRun]) {
        try {
          hear?.(entry);
        } catch {
          // A window that is going away.
        }
      }
    };
    emit({ ...base, phase: 'start', at: new Date(started).toISOString() });
    const finished = (extra: Partial<SetupLogEntry>) =>
      emit({ ...base, phase: 'end', at: new Date().toISOString(), durationMs: Date.now() - started, ...extra });
    let result: HelperResult;
    try {
      result = await this.runHelper(helper, change, signal);
    } catch (error) {
      finished({ error: signal.aborted ? 'Stopped' : error instanceof Error ? error.message : 'The helper could not complete' });
      throw error;
    }
    finished({
      status: result.status,
      ...(result.detectedVersion ? { version: result.detectedVersion } : {}),
      ...(plannedBy(result).length ? { planned: plannedBy(result) } : {}),
      ...(result.appliedChanges?.length ? { applied: result.appliedChanges } : {}),
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      ...(result.manualSteps?.length ? { manualSteps: result.manualSteps } : {}),
    });
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
  check(provider: unknown, signal?: AbortSignal, listener?: SetupLogListener): Promise<ProviderSetupState> {
    this.assertProvider(provider);
    return this.exclusive(async (signal) => {
      this.selected = provider;
      return this.inspect(provider, signal, listener);
    }, false, signal);
  }
  /** Both creation IPC paths recheck installation; Codex readiness remains advisory. */
  async checkForCreation(provider: unknown, signal?: AbortSignal, listener?: SetupLogListener): Promise<ProviderSetupState> {
    this.assertProvider(provider);
    return this.exclusive(async (signal) => {
      this.selected = provider;
      // A diagnostic probe must not hold the owner's creation action open.
      const state = await this.inspect(provider, signal, listener, false);
      if (!state.canFinish) throw new Error('Complete setup for the selected provider first');
      return state;
    }, false, signal);
  }
  /**
   * SPEC-010 FR-11 and SPEC-013 FR-8: one ticked step of the checked provider's chain,
   * installed or, where its helper has one, updated, followed by a fresh check.
   */
  install(provider: unknown, step: unknown, listener?: SetupLogListener, change: unknown = 'apply'): Promise<ProviderSetupState> {
    this.assertProvider(provider);
    if (provider !== this.selected) throw new Error('Check this provider before installing it');
    if (
      !['node', 'npm', 'shell', 'provider'].includes(String(step)) ||
      (step !== 'provider' && provider !== 'codex') ||
      (step === 'shell' && !this.windows)
    )
      throw new Error('This prerequisite is outside the selected provider');
    const helper = step === 'provider' ? provider : (step as string);
    if (!isSetupChange(change) || (change === 'upgrade' && !isUpdatableHelper(helper))) throw new Error('This setup step has no update');
    return this.exclusive(async (signal) => {
      // FR-12: PowerShell scripts is optional and needs nothing above it.
      if (provider === 'codex' && step !== 'node' && step !== 'shell') {
        // Each step needs the ones above it, as the page shows them. Only those are read here:
        // each helper is a process of its own, and the fresh check below reads them all.
        const chain = this.chain(provider);
        const needed = chain.slice(0, chain.findIndex((link) => link.id === step));
        let unmet = false;
        for (const link of needed) {
          if ((await this.run(link.helper, false, signal, listener)).status !== 'ready') {
            unmet = true;
            break;
          }
        }
        if (unmet)
          throw new Error(step === 'npm' || (step === 'provider' && !this.windows)
            ? 'Complete Node.js and npm setup first'
            : 'Complete the steps above first');
      }
      const from = change === 'upgrade' ? await this.versionBeforeUpdate(helper, signal, listener) : null;
      const applied = await this.run(helper, change === 'upgrade' ? 'upgrade' : true, signal, listener);
      this.noteSystemRestart(helper, applied);
      const checked = await this.inspect(provider, signal, listener);
      const target = checked.steps.find((item) => item.id === step)!;
      if (settleChange(target, applied, change, from) && !stepDone(target) && !target.optional) checked.canFinish = false;
      if (target.lastUpdate) this.updates.set(helper, target.lastUpdate);
      this.mergeIntoComputer(provider, checked.steps);
      return checked;
    }, true);
  }

  /* ---- SPEC-013: this computer, for Cats Bot Settings' Agent CLIs tab ---- */

  /** The last results, or every row not checked yet. Starts no process. */
  computer(): ComputerSetupState {
    if (this.computerState) return this.computerState;
    return { platform: this.platform, checkedAt: null, steps: this.computerLinks().map((link) => this.blankStep(link, 'not_checked')), signIn: {} };
  }

  /**
   * FR-4: Node.js first. While it is not ready, the npm folder and Codex wait unread, because
   * their plans cannot be known. The rest are read a few at a time, and a row whose check
   * fails does not stop the others.
   */
  checkComputer(listener?: SetupLogListener): Promise<ComputerSetupState> {
    return this.exclusive(async (signal) => {
      const links = this.computerLinks();
      const results = new Map<SetupHelperId, HelperResult | Error>();
      const read = async (id: SetupHelperId) => {
        try {
          results.set(id, await this.run(id, false, signal, listener));
        } catch (error) {
          signal.throwIfAborted();
          results.set(id, error instanceof Error ? error : new Error(String(error)));
        }
      };
      await read('node');
      const node = results.get('node');
      const nodeReady = !(node instanceof Error) && node?.status === 'ready';
      await eachBounded(links.filter((link) => link.id !== 'node' && (nodeReady || !link.needsNode)).map((link) => link.id), CHECKS_AT_ONCE, read);
      const steps = links.map((link) => this.computerStep(link, results.get(link.id)));
      const codex = results.get('codex');
      const codexStep = steps.find((item) => item.id === 'codex');
      const codexInitialization = this.windows && codexStep && stepDone(codexStep) && !(codex instanceof Error)
        ? await this.readCodexInitialization(codex?.commandPath, signal, listener)
        : undefined;
      this.computerState = {
        platform: this.platform,
        checkedAt: new Date().toISOString(),
        steps,
        signIn: signInsOf(steps),
        ...(codexInitialization ? { codexInitialization } : {}),
      };
      return this.computerState;
    });
  }

  /**
   * FR-7 and FR-8: one ticked row of the Agent CLIs tab: installed or set up (`apply`), or
   * updated (`upgrade`), then read again. Setting up Node.js also reads what was waiting on it.
   */
  changeComputer(helper: unknown, change: unknown, listener?: SetupLogListener): Promise<ComputerSetupState> {
    if (!isSetupHelperId(helper) || (helper === 'shell' && !this.windows)) throw new Error('Choose a setup step on this computer');
    if (!isSetupChange(change) || (change === 'upgrade' && !isUpdatableHelper(helper))) throw new Error('This setup step has no update');
    return this.exclusive(async (signal) => {
      // What it is installed through has to work first, as the tab's dependency stem shows.
      const needed: SetupHelperId[] = helper === 'npm' ? ['node'] : helper === 'codex' ? ['node', 'npm'] : [];
      for (const id of needed) {
        if ((await this.run(id, false, signal, listener)).status !== 'ready') throw new Error('Complete Node.js and npm setup first');
      }
      const from = change === 'upgrade' ? await this.versionBeforeUpdate(helper, signal, listener) : null;
      const applied = await this.run(helper, change === 'upgrade' ? 'upgrade' : true, signal, listener);
      this.noteSystemRestart(helper, applied);
      const links = this.computerLinks();
      let codexPath: string | undefined;
      const fresh = async (id: SetupHelperId) => {
        const link = links.find((item) => item.id === id)!;
        try {
          const result = await this.run(id, false, signal, listener);
          if (id === 'codex') codexPath = result.commandPath;
          return this.computerStep(link, result);
        } catch (error) {
          signal.throwIfAborted();
          return this.computerStep(link, error instanceof Error ? error : new Error(String(error)));
        }
      };
      const target = await fresh(helper);
      settleChange(target, applied, change, from);
      if (target.lastUpdate) this.updates.set(helper, target.lastUpdate);
      const updates = [target];
      // Whatever waited on Node.js can now say what it would do.
      if (helper === 'node' && stepDone(target)) {
        for (const id of ['npm', 'codex'] as const) {
          if (this.computerState?.steps.find((item) => item.id === id)?.status !== 'ready') updates.push(await fresh(id));
        }
      }
      const base = this.computer();
      const steps = base.steps.map((item) => updates.find((update) => update.id === item.id) ?? item);
      const codexStep = steps.find((item) => item.id === 'codex');
      let codexInitialization = base.codexInitialization;
      if (this.windows && codexStep && stepDone(codexStep) && updates.some((item) => item.id === 'codex')) {
        codexInitialization = await this.readCodexInitialization(codexPath, signal, listener);
      }
      this.computerState = {
        ...base,
        checkedAt: base.checkedAt ?? new Date().toISOString(),
        steps,
        signIn: signInsOf(steps),
        ...(codexInitialization ? { codexInitialization } : {}),
      };
      return this.computerState;
    }, true);
  }

  /** FR-9: an update starts from something that works, and the check before it says which version. */
  private async versionBeforeUpdate(helper: string, signal: AbortSignal, listener?: SetupLogListener): Promise<string | null> {
    const before = await this.run(helper, false, signal, listener);
    const provider = CLI_PROVIDERS.some((item) => item.id === helper);
    if (before.status !== 'ready' && !(provider && before.installed && before.status === 'auth_required'))
      throw new Error('Install it before updating it');
    return before.detectedVersion ?? null;
  }

  private noteSystemRestart(helper: string, applied: HelperResult): void {
    if (this.windows && helper === 'node' && applied.restartRequired === true &&
        applied.interruptions?.some(item => item.kind === 'restart_required' && item.requiresRestart === true)) {
      this.systemRestartReported = true;
      this.systemRestartWarnings = distinctLines([...this.systemRestartWarnings, ...(applied.warnings ?? [])]);
    }
  }

  /** The rows of the Agent CLIs tab, in the order it draws them. */
  private computerLinks(): Array<SetupLink<SetupHelperId>> {
    const provider = (id: SetupHelperId, needsNode = false): SetupLink<SetupHelperId> =>
      ({ id, helper: id, label: CLI_PROVIDERS.find((item) => item.id === id)!.label, needsNode, optional: false });
    return [
      { id: 'node', helper: 'node', label: 'Node.js and npm', needsNode: false, optional: false },
      { id: 'npm', helper: 'npm', label: 'npm installation folder', needsNode: true, optional: false },
      provider('codex', true),
      provider('claude'),
      provider('antigravity'),
      provider('grok'),
      provider('muse'),
      ...(this.windows ? [{ id: 'shell', helper: 'shell', label: 'PowerShell scripts', needsNode: false, optional: true } satisfies SetupLink<SetupHelperId>] : []),
    ];
  }

  private blankStep<Id extends string>(link: SetupLink<Id>, status: string): SetupStep<Id> {
    return {
      id: link.id,
      label: link.label,
      status,
      installed: false,
      version: null,
      warnings: [],
      manualSteps: [],
      restartRequired: false,
      optional: link.optional,
      planned: [],
      applied: [],
      script: this.options.identify?.(link.helper) ?? null,
      applyCommand: this.options.describe?.(link.helper, true).command ?? null,
      updateCommand: isUpdatableHelper(link.helper) ? this.options.describe?.(link.helper, 'upgrade').command ?? null : null,
    };
  }

  private stepOf<Id extends string>(link: SetupLink<Id>, result: HelperResult): SetupStep<Id> {
    const update = this.updates.get(link.helper);
    return {
      ...this.blankStep(link, result.status),
      installed: result.installed === true || result.status === 'ready',
      version: result.detectedVersion ?? null,
      warnings: distinctLines([...(result.warnings ?? []), ...(link.helper === 'node' ? this.systemRestartWarnings : [])]),
      ...(link.helper === 'node' && this.systemRestartReported ? { systemRestartRequired: true } : {}),
      manualSteps: result.manualSteps ?? [],
      // A check's changes_required flag previews the restart after applying its plan;
      // no change has run yet, so the row must still offer its tick box.
      restartRequired: result.restartRequired === true && result.status !== 'changes_required',
      planned: plannedBy(result),
      ...(update && update.to === (result.detectedVersion ?? null) ? { lastUpdate: update } : {}),
    };
  }

  /** FR-5: a check that could not run says so, and a row waiting on Node.js was not read. */
  private computerStep(link: SetupLink<SetupHelperId>, result: HelperResult | Error | undefined): SetupStep<SetupHelperId> {
    if (result === undefined) return this.blankStep(link, 'prerequisite_required');
    if (result instanceof Error) return { ...this.blankStep(link, 'check_failed'), checkError: result.message };
    return this.stepOf(link, result);
  }

  /** A bot's own check reads some of the same helpers; the Agent CLIs tab shows what it found. */
  private mergeIntoComputer(provider: string, steps: SetupStep[]): void {
    const state = this.computerState;
    if (!state) return;
    const found = new Map<string, SetupStep<string>>(steps.map((item) => [item.id === 'provider' ? provider : item.id, item]));
    const merged = state.steps.map((item) => {
      const next = found.get(item.id);
      return next && next.status !== 'prerequisite_required' ? { ...next, id: item.id, label: item.label } : item;
    });
    this.computerState = { ...state, steps: merged, signIn: signInsOf(merged) };
  }

  private chain(provider: string): SetupLink[] {
    const label = CLI_PROVIDERS.find((item) => item.id === provider)!.label;
    if (provider !== 'codex') return [{ id: 'provider', helper: provider, label, needsNode: false, optional: false }];
    return [
      { id: 'node', helper: 'node', label: 'Node.js and npm', needsNode: false, optional: false },
      { id: 'npm', helper: 'npm', label: 'npm installation folder', needsNode: true, optional: false },
      { id: 'provider', helper: provider, label: 'Codex', needsNode: true, optional: false },
      ...(this.windows
        ? [{ id: 'shell', helper: 'shell', label: 'PowerShell scripts', needsNode: false, optional: true } satisfies SetupLink]
        : []),
    ];
  }
  /**
   * SPEC-010 FR-7: until Node.js works, what needs it cannot say what it would do, so it
   * waits unread. Once it works, everything is read in one pass, because a check only
   * reads: a clean machine then asks the owner twice rather than once per step.
   */
  private async inspect(provider: string, signal: AbortSignal, listener?: SetupLogListener, includeInitialization = true): Promise<ProviderSetupState> {
    const steps: SetupStep[] = [];
    let codexCommandPath: string | undefined;
    let nodeReady = true;
    for (const link of this.chain(provider)) {
      if (link.needsNode && !nodeReady) {
        steps.push(this.blankStep(link, 'prerequisite_required'));
        continue;
      }
      const result = await this.run(link.helper, false, signal, listener);
      if (link.id === 'provider' && provider === 'codex') codexCommandPath = result.commandPath;
      if (link.id === 'node') nodeReady = result.status === 'ready';
      steps.push(this.stepOf(link, result));
    }
    let codexInitialization: CodexInitialization | undefined;
    if (includeInitialization && this.windows && provider === 'codex') {
      codexInitialization = { status: 'required' };
      if (steps.every((step) => step.optional || stepDone(step))) {
        codexInitialization = await this.readCodexInitialization(codexCommandPath, signal, listener);
      }
    }
    this.mergeIntoComputer(provider, steps);
    return {
      provider,
      steps,
      canFinish: steps.every((step) => step.optional || stepDone(step)),
      signIn: signInState(provider, steps.find((step) => step.id === 'provider')?.status),
      signInCommand: signInCommand(provider),
      ...(codexInitialization ? { codexInitialization } : {}),
    };
  }

  /** SPEC-010 FR-15: the read-only app-server question, logged like any other check. */
  private async readCodexInitialization(commandPath: string | undefined, signal: AbortSignal, listener?: SetupLogListener): Promise<CodexInitialization> {
    const run = ++this.runs, started = Date.now();
    const base = { run, kind: 'check' as const, helper: 'codex-initialization', file: 'Codex app-server', command: '' };
    const emit = (entry: SetupLogEntry) => {
      for (const hear of [listener, this.options.onRun]) { try { hear?.(entry); } catch { /* A closing view. */ } }
    };
    let reported = false;
    const reportCommand = (command: string) => {
      base.command = command;
      if (!reported) emit({ ...base, phase: 'start', at: new Date(started).toISOString() });
      reported = true;
    };
    try {
      const result = await this.options.codexInitialization?.(commandPath, signal, reportCommand) ?? { status: 'unavailable' as const };
      if (!reported) reportCommand('');
      signal.throwIfAborted();
      emit({ ...base, phase: 'end', at: new Date().toISOString(), durationMs: Date.now() - started, status: result.status });
      return result;
    } catch (error) {
      if (!reported) reportCommand('');
      emit({ ...base, phase: 'end', at: new Date().toISOString(), durationMs: Date.now() - started, error: signal.aborted ? 'Stopped' : 'Could not check Codex first-time setup.' });
      signal.throwIfAborted();
      return { status: 'unavailable' };
    }
  }
}

function plannedBy(result: HelperResult): string[] {
  return [...(result.plannedActions ?? []), ...(result.plannedChanges ?? [])];
}

/**
 * A few at a time, in order. It settles only once every probe has ended, so a stopped check
 * releases the operation after the last process tree is gone, never while one is still closing.
 */
async function eachBounded<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const results = await Promise.allSettled(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await work(queue.shift()!);
  }));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

/**
 * After a change the fresh check decides (SPEC-008 FR-19). A failure or a refused elevation
 * always stands. A restart or relaunch the helper asks for stands only while the fresh probe
 * cannot confirm the step: the runner already hands a found CLI's folder to Runtime and every
 * core. An update that did not finish leaves a working tool as it was, so its row stays ready
 * and says what happened (SPEC-013 FR-9). True when the change stopped short.
 */
function settleChange<Id extends string>(target: SetupStep<Id>, applied: HelperResult, change: SetupChange, from: string | null): boolean {
  const done = stepDone(target);
  // Install-Node reports a declined UAC prompt as `changes_required` with an elevation interruption.
  const status =
    applied.status !== 'ready' &&
    applied.interruptions?.some((item) => item.kind === 'elevation_required')
      ? 'elevation_required'
      : applied.status;
  const refused = ['elevation_required', 'failed'].includes(status);
  const interrupted =
    refused ||
    (!done &&
      (applied.restartRequired === true ||
        ['restart_required', 'relaunch_required'].includes(status)));
  target.applied = applied.appliedChanges ?? [];
  target.manualSteps = distinctLines([...target.manualSteps, ...(applied.manualSteps ?? [])]);
  // An installer's diagnostics explain a step that is not done; a finished step drops them.
  if (interrupted || !done)
    target.warnings = distinctLines([...target.warnings, ...(applied.warnings ?? [])]);
  if (change === 'upgrade' && done) {
    // Node's helper reports `already_up_to_date_*` when nothing changed, which is not an update.
    const changes = target.applied.filter((entry) => !/^already_/u.test(entry));
    const updated = Boolean(target.version && (from ? from !== target.version : changes.length > 0));
    // An installer that asks for a restart (MSI 3010) finishes its update afterwards.
    const restarting = !updated && (applied.restartRequired === true || ['restart_required', 'relaunch_required'].includes(status));
    target.lastUpdate = {
      from,
      to: target.version,
      outcome: status === 'elevation_required' ? 'declined' : refused ? 'failed' : updated ? 'updated' : restarting ? 'restart' : 'current',
    };
    return refused;
  }
  if (interrupted) {
    target.status = status;
    target.restartRequired = applied.restartRequired === true;
  }
  return interrupted;
}

/** FR-15: only Claude's helper asks its CLI, so only Claude can say either way. */
function signInState(provider: string, status: string | undefined): SetupSignIn {
  if (status === 'auth_required') return 'required';
  return provider === 'claude' && status === 'ready' ? 'signed_in' : 'unknown';
}

/** SPEC-013 FR-10: every provider that works, with what it reports and its fixed command. */
function signInsOf(steps: Array<SetupStep<SetupHelperId>>): ComputerSetupState['signIn'] {
  const signIn: ComputerSetupState['signIn'] = {};
  for (const step of steps) {
    if (!CLI_PROVIDERS.some((item) => item.id === step.id) || !stepDone(step)) continue;
    signIn[step.id] = { state: signInState(step.id, step.status), command: signInCommand(step.id) };
  }
  return signIn;
}

/** Ready, or a provider that is installed and waits only for the owner's sign-in. */
function stepDone(step: SetupStep<string>): boolean {
  const provider = step.id === 'provider' || CLI_PROVIDERS.some((item) => item.id === step.id);
  return (
    !step.restartRequired &&
    (step.status === 'ready' ||
      (provider && step.installed && step.status === 'auth_required'))
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
