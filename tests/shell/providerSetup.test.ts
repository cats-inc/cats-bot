import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  helperInvocation,
  installedCommandPath,
  ProviderSetup,
  type HelperResult,
} from '../../src/shell/electron/providerSetup.ts';

const assets = fileURLToPath(new URL('../../assets/setup/', import.meta.url));
const ready = (): HelperResult => ({ status: 'ready', installed: true, detectedVersion: '1.2.3' });

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
  });
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
  assert.deepEqual(state.steps[0]?.warnings, ['Installer warning']);
});

test('installer errors and restart requirements cannot be hidden by a later ready probe', async () => {
  for (const status of ['failed', 'elevation_required', 'restart_required', 'relaunch_required']) {
    const setup = new ProviderSetup(async (_helper, apply) =>
      apply ? { status, manualSteps: ['Complete setup'] } : ready(),
    );
    await setup.check('claude');
    const state = await setup.install('claude', 'provider');
    assert.equal(state.canFinish, false, status);
    assert.equal(state.steps[0]?.status, status);
    assert.deepEqual(state.steps[0]?.manualSteps, ['Complete setup']);
  }
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
  await setup.check('muse');
  assert.throws(() => setup.install('claude', 'provider'), /Check this provider/u);
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
