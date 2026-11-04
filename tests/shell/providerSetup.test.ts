import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { SetupLogEntry } from '../../src/shared/providerSetup.ts';
import {
  createHelperRunner,
  createScriptIdentity,
  describeHelperRun,
  helperInvocation,
  installedCommandPath,
  ProviderSetup,
  setupRunDiagnostic,
  type HelperResult,
} from '../../src/shell/electron/providerSetup.ts';

const assets = fileURLToPath(new URL('../../assets/setup/', import.meta.url));
const ready = (): HelperResult => ({ status: 'ready', installed: true, detectedVersion: '1.2.3' });

test('Windows Codex check reports an install plan when npm has no global prefix', {
  skip: process.platform !== 'win32',
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'cats-bot-codex-prefix-'));
  try {
    const windows = join(home, 'windows');
    mkdirSync(windows);
    for (const name of ['Install-Codex.ps1', '_NpmCliInstaller.ps1', '_VerifiedNpmUpdate.ps1']) {
      let source = readFileSync(join(assets, 'windows', name), 'utf8');
      if (name === 'Install-Codex.ps1') {
        assert.ok(source.includes("-CommandName 'codex'"));
        source = source.replace("-CommandName 'codex'", "-CommandName 'cats-bot-missing-cli-fixture'");
      }
      writeFileSync(join(windows, name), source);
    }
    writeFileSync(join(home, 'Invoke-SetupHelper.ps1'), `param([string]$Helper, [switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Helper -ne 'codex' -or $Apply) { throw 'Unexpected fixture command' }
function npm {
 if ($args[0] -ne 'list') { throw 'Check attempted a non-list npm command' }
 & $env:ComSpec /d /c 'echo npm error code ENOENT 1>&2 & exit /b 1'
}
& (Join-Path $PSScriptRoot 'windows/Install-Codex.ps1') -CheckOnly -Json -AllowAdmin
exit $LASTEXITCODE
`);
    const result = await createHelperRunner(home)('codex', false);
    assert.equal(result.status, 'changes_required');
    assert.equal(result.installed, false);
    assert.deepEqual(result.plannedActions, ['@openai/codex:install']);
    assert.deepEqual(result.appliedChanges, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the Windows npm helper previews a PATH change without requiring a restart yet', {
  skip: process.platform !== 'win32',
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'cats-bot-setup-npm-'));
  const prefix = join(home, 'prefix');
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(assets, 'windows', 'Setup-NodeGlobalPrefix.ps1'),
      '-CheckOnly', '-Json', '-AllowAdmin', '-SkipNodeCheck',
      '-UserHome', home, '-DesiredPrefix', prefix,
      '-CurrentPrefix', join(home, 'old-prefix'), '-CurrentUserPath', join(home, 'old-bin'),
    ], { windowsHide: true, timeout: 10_000 });
    const result = JSON.parse(stdout.replace(/^\uFEFF/u, '')) as HelperResult;
    assert.equal(result.status, 'changes_required');
    assert.equal(result.restartRequired, true, 'the raw helper anticipates a restart after applying');
    assert.ok(result.plannedChanges?.some((line) => line.includes('user PATH')));
    assert.equal(existsSync(prefix), false, 'the read-only helper has not created the folder');
    const setup = new ProviderSetup(async (helper) => helper === 'npm' ? result : ready(), { windows: true });
    const state = await setup.check('codex');
    assert.equal(state.steps[1]?.status, 'changes_required');
    assert.equal(state.steps[1]?.restartRequired, false, 'the page must still offer to apply the plan');
    assert.equal(state.canFinish, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the packaged Codex prerequisite chain accepts an already configured npm folder with system Bash', {
  skip: process.platform === 'win32',
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'cats-bot-setup-bash-'));
  try {
    const bin = join(home, 'prefix', 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, '.nvm'));
    writeFileSync(join(home, '.nvm', 'nvm.sh'), 'export PATH="$HOME/prefix/bin:$PATH"\n');
    writeFileSync(join(home, '.npmrc'), `prefix=${join(home, 'prefix')}\n`);
    const nodeExecutable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(bin, 'node'), `#!/bin/sh
if [ "$1" = '-v' ]; then printf 'v24.0.0\\n'; else exec ${nodeExecutable} "$@"; fi
`, { mode: 0o755 });
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nprintf "codex-cli 0.166.0\\n"\n', { mode: 0o755 });
    writeFileSync(join(bin, 'npm'), `#!/bin/sh
case "$*" in
  'config get prefix') printf '%s\\n' "$HOME/prefix" ;;
  'config get registry') printf '%s\\n' 'https://registry.npmjs.org/' ;;
  'list -g --depth=0 --json @openai/codex') printf '%s\\n' '{"dependencies":{"@openai/codex":{"version":"0.166.0"}}}' ;;
  *) printf 'Unexpected npm mutation: %s\\n' "$*" >&2; exit 95 ;;
esac
`, { mode: 0o755 });
    const calls: string[] = [];
    const setup = new ProviderSetup(async (helper, apply) => {
      assert.equal(apply, false);
      calls.push(helper);
      const invocation = helperInvocation(assets, process.platform, helper, apply);
      const { stdout } = await promisify(execFile)(invocation.command, invocation.args, {
        env: { HOME: home, NVM_DIR: join(home, '.nvm'), PATH: '/usr/bin:/bin', SHELL: '/bin/bash' },
        timeout: 10_000,
      });
      return JSON.parse(stdout) as HelperResult;
    });
    const state = await setup.check('codex');
    assert.deepEqual(calls, ['node', 'npm', 'codex']);
    assert.deepEqual(state.steps.map((step) => step.status), ['ready', 'ready', 'ready']);
    assert.equal(state.steps.at(-1)?.version, '0.166.0');
    assert.equal(state.canFinish, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a fresh GUI startup rediscovers nvm/custom npm directories without installing or checking other providers', async () => {
  let path = '/usr/bin:/bin';
  const calls: string[] = [];
  const setup = new ProviderSetup(async (helper, apply) => {
    calls.push(`${helper}:${apply}`);
    const result = {
      ...ready(),
      commandPath:
        helper === 'node' ? '/users/cat/.nvm/versions/node/v24/bin/node' : '/custom/npm/bin/codex',
    };
    path = installedCommandPath(result, path, 'darwin');
    return result;
  });
  await setup.prepareEnvironment('codex');
  assert.deepEqual(calls, ['node:false', 'codex:false']);
  assert.equal(path, '/custom/npm/bin:/users/cat/.nvm/versions/node/v24/bin:/usr/bin:/bin');
  await setup.prepareEnvironment('legacy-cli');
  assert.equal(calls.length, 2);
  assert.equal(
    installedCommandPath({ ...ready(), commandPath: '../untrusted' }, path, 'darwin'),
    path,
  );
  assert.equal(
    installedCommandPath(
      { ...ready(), commandPath: 'C:\\custom\\bin\\codex.cmd' },
      'C:\\Windows',
      'win32',
    ),
    'C:\\custom\\bin;C:\\Windows',
  );
});

test('provider-first setup checks native providers without probing Node/npm or another CLI', async () => {
  for (const provider of ['claude', 'antigravity', 'grok', 'muse']) {
    const calls: string[] = [];
    const setup = new ProviderSetup(async (helper, apply) => {
      calls.push(`${helper}:${apply}`);
      return ready();
    });
    const state = await setup.check(provider);
    assert.deepEqual(calls, [`${provider}:false`]);
    assert.equal(state.canFinish, true);
    assert.equal(state.steps[0]?.version, '1.2.3');
    assert.throws(() => setup.install(provider, 'node'), /outside/u);
  }
});

test('Codex reads Node.js first, then everything at once, and installs in order (SPEC-010 FR-7)', async () => {
  const installed = new Set<string>();
  const calls: string[] = [];
  const setup = new ProviderSetup(async (helper, apply) => {
    calls.push(`${helper}:${apply}`);
    if (apply) installed.add(helper);
    return installed.has(helper) ? ready() : { status: 'changes_required', installed: false };
  }, { windows: false });
  const missing = await setup.check('codex');
  assert.equal(missing.canFinish, false);
  assert.deepEqual(
    missing.steps.map((step) => step.status),
    ['changes_required', 'prerequisite_required', 'prerequisite_required'],
  );
  assert.deepEqual(calls, ['node:false'], 'what needs Node.js cannot say what it would do yet');
  await assert.rejects(setup.install('codex', 'provider'), /Complete Node.js/u);
  assert.ok(!calls.includes('codex:true'));
  const node = await setup.install('codex', 'node');
  assert.deepEqual(
    node.steps.map((step) => step.status),
    ['ready', 'changes_required', 'changes_required'],
    'with Node.js working, everything is read in one pass',
  );
  await assert.rejects(setup.install('codex', 'provider'), /Complete Node.js/u, 'Codex still needs the npm folder');
  const npm = await setup.install('codex', 'npm');
  assert.deepEqual(
    npm.steps.map((step) => step.status),
    ['ready', 'ready', 'changes_required'],
  );
  assert.equal((await setup.install('codex', 'provider')).canFinish, true);
  assert.deepEqual(
    calls.filter((call) => call.endsWith(':true')),
    ['node:true', 'npm:true', 'codex:true'],
  );
});

test('a step carries the helper\'s own plan and what it just did, and the script it ran (FR-10)', async () => {
  let installed = false;
  const script = { file: 'Install-ClaudeCode.ps1', sha256: 'abc', source: 'cats-platform 7b3f94e' };
  const setup = new ProviderSetup(async (_helper, apply) => {
    if (apply) {
      installed = true;
      return { status: 'ready', appliedChanges: ['installed native CLI'] };
    }
    return installed
      ? ready()
      : { status: 'changes_required', plannedActions: ['remove_legacy_npm_claude_shim'], plannedChanges: ['Add a folder to the user PATH'] };
  }, { identify: () => script });
  const before = await setup.check('claude');
  assert.deepEqual(before.steps[0]?.planned, ['remove_legacy_npm_claude_shim', 'Add a folder to the user PATH']);
  assert.deepEqual(before.steps[0]?.script, script);
  const after = await setup.install('claude', 'provider');
  assert.deepEqual(after.steps[0]?.applied, ['installed native CLI']);
  assert.deepEqual(after.steps[0]?.planned, []);
});

test('sign-in is what the CLI reports, and unknown when it cannot say (FR-15)', async () => {
  const stateOf = async (provider: string, result: HelperResult) => (await new ProviderSetup(async () => result).check(provider)).signIn;
  assert.equal(await stateOf('claude', { status: 'auth_required', installed: true }), 'required');
  assert.equal(await stateOf('claude', ready()), 'signed_in');
  assert.equal(await stateOf('grok', ready()), 'unknown');
  assert.equal(await stateOf('antigravity', ready()), 'unknown');
  assert.equal(await stateOf('claude', { status: 'not_installed' }), 'unknown');
  assert.equal((await new ProviderSetup(async () => ready(), { windows: false }).check('codex')).signIn, 'unknown');
});

test('each run is logged at its start and end, for the page and the hub (FR-14)', async () => {
  const entries: SetupLogEntry[] = [];
  const hub: SetupLogEntry[] = [];
  const setup = new ProviderSetup(
    async (_helper, apply) => (apply ? { status: 'ready', appliedChanges: ['did it'], warnings: ['careful'] } : { status: 'changes_required', plannedActions: ['do_it'], detectedVersion: '1.0' }),
    { describe: (helper, apply) => ({ command: `run ${helper} ${apply}`, file: `${helper}.ps1` }), onRun: (entry) => hub.push(entry) },
  );
  await setup.check('grok', undefined, (entry) => entries.push(entry));
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.phase, entry.helper, entry.command, entry.file]), [
    ['check', 'start', 'grok', 'run grok false', 'grok.ps1'],
    ['check', 'end', 'grok', 'run grok false', 'grok.ps1'],
  ]);
  assert.equal(entries[0]!.run, entries[1]!.run);
  assert.equal(entries[1]!.status, 'changes_required');
  assert.equal(entries[1]!.version, '1.0');
  assert.deepEqual(entries[1]!.planned, ['do_it']);
  entries.length = 0;
  await setup.install('grok', 'provider', (entry) => entries.push(entry));
  const change = entries.find((entry) => entry.kind === 'change' && entry.phase === 'end')!;
  assert.deepEqual(change.applied, ['did it']);
  assert.deepEqual(change.warnings, ['careful']);
  assert.equal(entries.filter((entry) => entry.kind === 'check').length, 2, 'the fresh check is logged too');
  assert.equal(hub.length, 6, 'the hub hears every run');
});

test('Windows Codex creation rechecks the resolved CLI and logs the actual native command', async () => {
  const entries: SetupLogEntry[] = [];
  const shim = 'C:\\Users\\cat\\npm\\codex.ps1';
  const command = '"C:\\Users\\cat\\npm\\native\\codex.exe" "app-server"';
  let probes = 0;
  const setup = new ProviderSetup(async helper => ({ ...ready(), ...(helper === 'codex' ? { commandPath: shim } : {}) }), {
    windows: true,
    codexInitialization: async (path, _signal, onCommand) => {
      assert.equal(path, shim); probes++; onCommand(command); return { status: 'ready' };
    },
  });
  await setup.check('codex');
  await setup.checkForCreation('codex', undefined, entry => entries.push(entry));
  assert.equal(probes, 2, 'creation must not reuse the page check');
  assert.deepEqual(entries.filter(entry => entry.helper === 'codex-initialization').map(entry => [entry.phase, entry.command]), [['start', command], ['end', command]]);
  const unavailable = new ProviderSetup(async () => ready(), { windows: true });
  assert.equal((await unavailable.check('codex')).canFinish, true);
  await assert.rejects(unavailable.checkForCreation('codex'), /Complete Codex first-time setup/);
});

test('Codex initialization never applies to another platform or provider', async () => {
  const unexpected = async (): Promise<never> => { throw new Error('must not probe'); };
  for (const [windows, provider] of [[false, 'codex'], [true, 'claude']] as const) {
    const setup = new ProviderSetup(async () => ready(), { windows, codexInitialization: unexpected });
    assert.equal((await setup.checkForCreation(provider)).codexInitialization, undefined);
  }
});

test('a page that goes away cannot break an install that has already changed the computer', async () => {
  let installed = false;
  const setup = new ProviderSetup(async (_helper, apply) => {
    if (apply) installed = true;
    return installed ? ready() : { status: 'changes_required' };
  }, { onRun: () => { throw new Error('hub log failed'); } });
  const throwing = () => { throw new Error('Object has been destroyed'); };
  await setup.check('grok', undefined, throwing);
  const state = await setup.install('grok', 'provider', throwing);
  assert.equal(installed, true);
  assert.equal(state.canFinish, true, 'the fresh check still ran');
  assert.equal(setup.busy, false);
});

test('a run that fails or is stopped still ends in the log', async () => {
  const entries: SetupLogEntry[] = [];
  const broken = new ProviderSetup(async () => { throw new Error('unreadable result'); });
  await assert.rejects(broken.check('grok', undefined, (entry) => entries.push(entry)), /unreadable/u);
  assert.equal(entries.at(-1)!.phase, 'end');
  assert.equal(entries.at(-1)!.error, 'unreadable result');
  const stopped: SetupLogEntry[] = [];
  const setup = new ProviderSetup((_helper, _apply, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  const checking = setup.check('grok', undefined, (entry) => stopped.push(entry));
  setup.cancelCheck();
  await assert.rejects(checking, { name: 'AbortError' });
  assert.equal(stopped.at(-1)!.error, 'Stopped');
});

test('the hub\'s record of a run holds fixed words only (ADR-013)', () => {
  const base = { run: 1, at: '', kind: 'change', helper: 'npm', file: 'x', command: 'C:\\Users\\you\\secret path' } as const;
  assert.equal(setupRunDiagnostic({ ...base, phase: 'start' }), null);
  const line = setupRunDiagnostic({ ...base, phase: 'end', status: 'ready', durationMs: 12, applied: ['Updated C:\\Users\\you PATH'], warnings: ['C:\\Users\\you'] })!;
  assert.equal(line, 'setup change npm: ready, 1 change(s) in 12 ms');
  assert.equal(setupRunDiagnostic({ ...base, phase: 'end', status: 'C:\\Users\\you', durationMs: 1 }), 'setup change npm: unknown in 1 ms');
  assert.equal(setupRunDiagnostic({ ...base, phase: 'end', error: 'Failed in C:\\Users\\you', durationMs: 1 }), 'setup change npm: failed in 1 ms');
});

test('a run reads as the command it really is, and a script as its recorded copy', () => {
  const windows = describeHelperRun('C:\\Program Files\\Cats Bot\\setup', 'win32', 'node', true);
  assert.equal(windows.file, 'Install-Node.ps1');
  assert.match(windows.command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ".*Invoke-SetupHelper\.ps1" -Helper node -Apply$/u);
  const mac = describeHelperRun('/Applications/Cats Bot/setup', 'darwin', 'claude', false);
  assert.equal(mac.file, 'install-claude-code.sh');
  assert.match(mac.command, /^\/bin\/bash ".*install-claude-code\.sh" -CheckOnly -Json$/u);
  const identify = createScriptIdentity(assets, 'win32');
  const script = identify('codex')!;
  assert.equal(script.file, 'Install-Codex.ps1');
  assert.match(script.sha256!, /^[0-9a-f]{64}$/u);
  assert.match(script.source!, /^cats-platform [0-9a-f]{7}$/u);
  assert.equal(createScriptIdentity(assets, 'linux')('shell'), null, 'Windows only');
  assert.equal(createScriptIdentity(join(assets, 'missing'), 'win32')('codex')?.sha256, null, 'a missing record costs only the hash');
});

test('installation is explicit, restricted to the checked provider, and followed by a fresh probe', async () => {
  let installed = false;
  const calls: string[] = [];
  const setup = new ProviderSetup(async (helper, apply) => {
    calls.push(`${helper}:${apply}`);
    if (apply) {
      installed = true;
      return { status: 'ready', warnings: ['Installer warning'] };
    }
    return installed ? ready() : { status: 'not_installed' };
  });
  assert.throws(() => setup.install('claude', 'provider'), /Check this provider/u);
  assert.throws(() => setup.check('gemini'), /supported provider/u);
  await setup.check('claude');
  assert.throws(() => setup.install('codex', 'provider'), /Check this provider/u);
  assert.throws(() => setup.install('claude', '../evil'), /outside/u);
  const state = await setup.install('claude', 'provider');
  assert.deepEqual(calls, ['claude:false', 'claude:true', 'claude:false']);
  assert.equal(state.canFinish, true);
  // A finished step drops the installer's diagnostics (a winget fallback note, say).
  assert.deepEqual(state.steps[0]?.warnings, []);
});

test('installer errors cannot be hidden by a later ready probe', async () => {
  for (const status of ['failed', 'elevation_required']) {
    const setup = new ProviderSetup(async (_helper, apply) =>
      apply ? { status, manualSteps: ['Complete setup'], warnings: ['Why'] } : ready(),
    );
    await setup.check('claude');
    const state = await setup.install('claude', 'provider');
    assert.equal(state.canFinish, false, status);
    assert.equal(state.steps[0]?.status, status);
    assert.deepEqual(state.steps[0]?.manualSteps, ['Complete setup']);
    assert.deepEqual(state.steps[0]?.warnings, ['Why']);
  }
});

// Measured on a clean Windows 11 VM: every native installer and the npm folder ask for a
// relaunch or restart that the fresh probe already shows is not needed (PLAN-010 Phase 3).
test('a restart or relaunch stands only while the fresh probe cannot confirm the step', async () => {
  for (const applied of [
    { status: 'restart_required', restartRequired: true },
    { status: 'relaunch_required' },
    { status: 'ready', restartRequired: true },
  ] as HelperResult[]) {
    const confirmed = new ProviderSetup(async (_helper, apply) => (apply ? applied : ready()));
    await confirmed.check('claude');
    const shown = await confirmed.install('claude', 'provider');
    assert.equal(shown.canFinish, true, applied.status);
    assert.equal(shown.steps[0]?.status, 'ready');

    const unseen = new ProviderSetup(async (_helper, apply) =>
      apply ? applied : { status: 'not_installed' },
    );
    await unseen.check('claude');
    const waiting = await unseen.install('claude', 'provider');
    assert.equal(waiting.canFinish, false, applied.status);
    assert.equal(waiting.steps[0]?.status, applied.status);
  }
  const signIn = new ProviderSetup(async (_helper, apply) =>
    apply
      ? { status: 'relaunch_required', installed: true }
      : { status: 'auth_required', installed: true },
  );
  await signIn.check('claude');
  const installed = await signIn.install('claude', 'provider');
  assert.equal(installed.steps[0]?.status, 'auth_required');
  assert.equal(installed.canFinish, true);
});

for (const usableAfterInstall of [true, false]) {
  test(`an explicit Windows restart stays visible when the new Node is ${usableAfterInstall ? 'usable' : 'unavailable'}`, async () => {
    let applied = false;
    const warning = 'Windows requires a system restart to complete the installation.';
    const setup = new ProviderSetup(async (helper, apply) => {
      if (helper === 'node' && apply) {
        applied = true;
        return { status: 'restart_required', installed: true, restartRequired: true,
          interruptions: [{ kind: 'restart_required', requiresRestart: true }], warnings: [warning] };
      }
      if (helper === 'node' && (!applied || !usableAfterInstall)) return { status: 'changes_required', installed: false };
      return ready();
    }, { windows: true });
    await setup.check('codex');
    const installed = await setup.install('codex', 'node');
    const node = installed.steps.find(step => step.id === 'node')!;
    assert.equal(node.systemRestartRequired, true);
    assert.ok(node.warnings.includes(warning));
    assert.equal(installed.canFinish, usableAfterInstall, 'usable CLIs keep working while the reboot advice remains');
    const rechecked = await setup.check('codex');
    assert.equal(rechecked.steps[0]!.systemRestartRequired, true);
    assert.ok(rechecked.steps[0]!.warnings.includes(warning));
    if (usableAfterInstall) {
      const later = await setup.install('codex', 'npm');
      assert.equal(later.steps[0]!.systemRestartRequired, true);
      assert.ok(later.steps[0]!.warnings.includes(warning));
    }
  });
}

test('the same help line from the check and the install shows once', async () => {
  const setup = new ProviderSetup(async (_helper, apply) =>
    apply
      ? { status: 'relaunch_required', installed: true, manualSteps: ['Run `claude` to sign in.'] }
      : { status: 'auth_required', installed: true, manualSteps: ['Run claude to sign in.'] },
  );
  await setup.check('claude');
  const state = await setup.install('claude', 'provider');
  assert.deepEqual(state.steps[0]?.manualSteps, ['Run claude to sign in.']);
});

test('authentication is reported separately from installation; unknown results are not ready', async () => {
  for (const [result, expected] of [
    [{ status: 'auth_required', installed: true }, true],
    [{ status: 'auth_required', installed: false }, false],
    [{ status: 'ready', installed: true, restartRequired: true }, false],
    [{ status: 'unknown', installed: true }, false],
  ] as const) {
    const setup = new ProviderSetup(async () => result);
    assert.equal((await setup.check('claude')).canFinish, expected);
  }
});

test('concurrent provider changes cannot replace an active install and shutdown waits for it', async () => {
  let complete!: (value: HelperResult) => void;
  const setup = new ProviderSetup(async (_helper, apply) =>
    apply
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : ready(),
  );
  await setup.check('claude');
  const install = setup.install('claude', 'provider');
  assert.equal(setup.installing, true);
  setup.cancelCheck();
  await assert.rejects(setup.check('codex'), /Wait/u);
  let idle = false;
  const drain = setup.whenIdle().then(() => {
    idle = true;
  });
  assert.equal(idle, false);
  complete(ready());
  await install;
  await drain;
  assert.equal(idle, true);
  assert.equal(setup.busy, false);
  assert.equal(setup.installing, false);
  await setup.check('muse');
  assert.throws(() => setup.install('claude', 'provider'), /Check this provider/u);
});

test('shutdown cancels read-only checks, releases idle waiters and skips remaining prerequisites', async () => {
  const calls: string[] = [];
  let aborted = false;
  const setup = new ProviderSetup(async (helper, _apply, signal) => {
    calls.push(helper);
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => {
        aborted = true;
        reject(signal!.reason);
      }, { once: true });
    });
  });
  const checking = assert.rejects(setup.check('codex'), { name: 'AbortError' });
  const idle = setup.whenIdle();
  assert.equal(setup.installing, false);
  setup.cancelCheck();
  await Promise.all([checking, idle]);
  assert.equal(aborted, true);
  assert.equal(setup.busy, false);
  assert.deepEqual(calls, ['node']);
});

test('closing one page cannot cancel a check owned by another page', async () => {
  const owner = new AbortController();
  const unrelated = new AbortController();
  let complete!: (value: HelperResult) => void;
  const setup = new ProviderSetup(async () => new Promise(resolve => { complete = resolve; }));
  const checking = setup.check('claude', owner.signal);
  unrelated.abort();
  complete(ready());
  assert.equal((await checking).canFinish, true);
  owner.abort();
  await assert.rejects(setup.check('muse', owner.signal), { name: 'AbortError' });
  assert.equal(setup.busy, false);
});

test('packaged helper invocations accept no renderer-supplied command, path or extra flags', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    for (const helper of ['node', 'npm', 'codex', 'claude', 'antigravity', 'grok', 'muse']) {
      const invocation = helperInvocation(assets, platform, helper, false);
      const script =
        platform === 'win32'
          ? invocation.args[invocation.args.indexOf('-File') + 1]!
          : invocation.args[0]!;
      assert.ok(existsSync(script), `${platform}/${helper} is packaged`);
      assert.ok(!invocation.args.includes('--apply') && !invocation.args.includes('-Apply'));
      if (platform !== 'win32') {
        assert.deepEqual(invocation.args.slice(1), ['-CheckOnly', '-Json']);
        assert.deepEqual(helperInvocation(assets, platform, helper, true).args.slice(1), [
          '-Apply',
          '-Json',
        ]);
      }
    }
    assert.throws(() => helperInvocation(assets, platform, '../evil', true), /Unknown/u);
    assert.throws(() => helperInvocation(assets, platform, 'codex --dangerous', true), /Unknown/u);
  }
});

test('every vendored installer and sourced dependency matches its pinned Platform source', () => {
  const manifest = JSON.parse(readFileSync(join(assets, 'provenance.json'), 'utf8')) as {
    commit: string;
    files: Array<{ path: string; sha256: string }>;
  };
  assert.match(manifest.commit, /^[a-f0-9]{40}$/u);
  for (const file of manifest.files) {
    const path = join(assets, file.path),
      content = readFileSync(path);
    assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256, file.path);
    // Each Unix source and PowerShell dot-source remains beside its caller.
    for (const match of content
      .toString('utf8')
      .matchAll(/(?:SCRIPT_DIR|script_dir|PSScriptRoot)[/\\]?['" ]*([\w-]+\.(?:sh|ps1))/gu)) {
      assert.ok(existsSync(join(dirname(path), match[1]!)), `${file.path} needs ${match[1]}`);
    }
  }
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(
    pkg.build.files.includes('assets/**/*'),
    'installer closure is included in every package',
  );
});

// The clean VM's Codex chain: the npm folder asks for a restart its fresh probe does not need.
test('Codex goes on after the npm folder without a restart or Check again', async () => {
  let npmReady = false;
  let codexInstalled = false;
  const setup = new ProviderSetup(async (helper, apply) => {
    if (helper === 'node') return ready();
    if (helper === 'npm') {
      if (apply) {
        npmReady = true;
        return { status: 'restart_required', restartRequired: true };
      }
      return npmReady ? { status: 'ready' } : { status: 'changes_required', restartRequired: true };
    }
    if (apply) {
      codexInstalled = true;
      return { status: 'ready', installed: true };
    }
    return codexInstalled ? ready() : { status: 'not_installed' };
  }, { windows: false });
  const before = await setup.check('codex');
  assert.equal(before.steps[1]?.status, 'changes_required');
  assert.equal(before.steps[1]?.restartRequired, false, 'a read-only plan is not an installed step waiting for restart');
  const afterNpm = await setup.install('codex', 'npm');
  assert.equal(afterNpm.steps[1]?.status, 'ready');
  assert.equal(afterNpm.steps[2]?.status, 'not_installed');
  assert.equal((await setup.install('codex', 'provider')).canFinish, true);
});

test('a declined UAC prompt shows as elevation_required, not as a step to set up', async () => {
  const declined = 'Administrator elevation was cancelled or failed.';
  const setup = new ProviderSetup(async (_helper, apply) =>
    apply
      ? { status: 'changes_required', warnings: [declined], interruptions: [{ kind: 'elevation_required' }] }
      : { status: 'changes_required' },
  );
  await setup.check('codex');
  const state = await setup.install('codex', 'node');
  assert.equal(state.steps[0]?.status, 'elevation_required');
  assert.deepEqual(state.steps[0]?.warnings, [declined]);
  assert.equal(state.canFinish, false);
});

// On Windows, PowerShell runs npm's codex.ps1 only under a permissive execution policy, so
// the owner's own `codex login` in PowerShell needs this step. Nothing of Cats Bot's does:
// helpers run with -ExecutionPolicy Bypass and Runtime resolves codex.cmd.
test('on Windows PowerShell scripts is optional, last, and blocks nothing (SPEC-010 FR-12)', async () => {
  const installed = new Set<string>(['npm']);
  const calls: string[] = [];
  const setup = new ProviderSetup(async (helper, apply) => {
    calls.push(`${helper}:${apply}`);
    if (apply) installed.add(helper);
    return installed.has(helper) ? ready() : { status: 'changes_required', installed: false };
  }, { windows: true });
  const before = await setup.check('codex');
  assert.deepEqual(before.steps.map((step) => [step.id, step.status, step.optional]), [
    ['node', 'changes_required', false],
    ['npm', 'prerequisite_required', false],
    ['provider', 'prerequisite_required', false],
    ['shell', 'changes_required', true],
  ], 'it is read even while Node.js is missing');
  assert.deepEqual(calls, ['node:false', 'shell:false']);
  // It can be ticked in the first round, because it needs nothing above it.
  const shell = await setup.install('codex', 'shell');
  assert.equal(shell.steps[3]?.status, 'ready');
  installed.delete('shell');
  await setup.install('codex', 'node');
  const declined = await setup.install('codex', 'provider');
  assert.deepEqual(declined.steps.map((step) => step.status), ['ready', 'ready', 'ready', 'changes_required']);
  assert.equal(declined.canFinish, true, 'declining it does not stop Codex or finishing');
  // A failure in it stays on its own row.
  const failing = new ProviderSetup(async (helper, apply) => (helper === 'shell' ? { status: apply ? 'failed' : 'changes_required' } : ready()), { windows: true });
  await failing.check('codex');
  const failed = await failing.install('codex', 'shell');
  assert.equal(failed.steps[3]?.status, 'failed');
  assert.equal(failed.canFinish, true);
  // Other providers and other systems never see the step.
  const elsewhere = new ProviderSetup(async () => ready(), { windows: false });
  await elsewhere.check('codex');
  assert.throws(() => elsewhere.install('codex', 'shell'), /outside/u);
  assert.throws(() => helperInvocation(assets, 'darwin', 'shell', false), /Windows only/u);
  assert.deepEqual(helperInvocation(assets, 'win32', 'shell', true).args.slice(-3), ['-Helper', 'shell', '-Apply']);
  const claude = new ProviderSetup(async () => ready(), { windows: true });
  assert.deepEqual((await claude.check('claude')).steps.map((step) => step.id), ['provider']);
});
