import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  helperInvocation,
  installedCommandPath,
  ProviderSetup,
  type HelperResult,
} from '../../src/shell/electron/providerSetup.ts';

const assets = fileURLToPath(new URL('../../assets/setup/', import.meta.url));
const ready = (): HelperResult => ({ status: 'ready', installed: true, detectedVersion: '1.2.3' });

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

test('Codex requires working Node/npm, a writable npm folder, then Codex in that order', async () => {
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
  assert.deepEqual(calls, ['node:false']);
  await assert.rejects(setup.install('codex', 'provider'), /Complete Node.js/u);
  assert.ok(!calls.includes('codex:true'));
  const node = await setup.install('codex', 'node');
  assert.deepEqual(
    node.steps.map((step) => step.status),
    ['ready', 'changes_required', 'prerequisite_required'],
  );
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
      return npmReady ? { status: 'ready' } : { status: 'not_installed' };
    }
    if (apply) {
      codexInstalled = true;
      return { status: 'ready', installed: true };
    }
    return codexInstalled ? ready() : { status: 'not_installed' };
  }, { windows: false });
  await setup.check('codex');
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
// `codex login` in a fresh terminal needs the PowerShell scripts step (Setup-CliReadiness).
test('on Windows Codex also needs the PowerShell scripts step, after npm and before Codex', async () => {
  const installed = new Set<string>(['node', 'npm']);
  const calls: string[] = [];
  const setup = new ProviderSetup(async (helper, apply) => {
    calls.push(`${helper}:${apply}`);
    if (apply) installed.add(helper);
    return installed.has(helper) ? ready() : { status: 'changes_required', installed: false };
  }, { windows: true });
  const before = await setup.check('codex');
  assert.deepEqual(before.steps.map((step) => [step.id, step.status]), [
    ['node', 'ready'], ['npm', 'ready'], ['shell', 'changes_required'], ['provider', 'prerequisite_required'],
  ]);
  await assert.rejects(setup.install('codex', 'provider'), /Complete the steps above first/u);
  const shell = await setup.install('codex', 'shell');
  assert.equal(shell.steps[2]?.status, 'ready');
  assert.equal(shell.steps[3]?.status, 'changes_required');
  assert.equal((await setup.install('codex', 'provider')).canFinish, true);
  assert.deepEqual(calls.filter((call) => call.endsWith(':true')), ['shell:true', 'codex:true']);
  // Other providers and other systems never see the step.
  const elsewhere = new ProviderSetup(async () => ready(), { windows: false });
  await elsewhere.check('codex');
  assert.throws(() => elsewhere.install('codex', 'shell'), /outside/u);
  assert.throws(() => helperInvocation(assets, 'darwin', 'shell', false), /Windows only/u);
  assert.deepEqual(helperInvocation(assets, 'win32', 'shell', true).args.slice(-3), ['-Helper', 'shell', '-Apply']);
  const claude = new ProviderSetup(async () => ready(), { windows: true });
  assert.deepEqual((await claude.check('claude')).steps.map((step) => step.id), ['provider']);
});
