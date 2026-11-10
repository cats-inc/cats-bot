import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SetupLogEntry } from '../../src/shared/providerSetup.ts';
import {
  describeHelperRun,
  helperInvocation,
  ProviderSetup,
  type HelperChange,
  type HelperResult,
} from '../../src/shell/electron/providerSetup.ts';
import { ipcMain } from '../support/setup-electron.ts';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'electron'
      ? { url: new URL('../support/setup-electron.ts', import.meta.url).href, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { COMPUTER_SETUP_CHANNELS, registerComputerSetupIpc } = await import('../../src/shell/electron/computerSetup.ts');
hooks.deregister();

/**
 * SPEC-013: the hub's Agent CLIs tab. These run stub helpers only: nothing here installs,
 * updates or checks anything on the machine running the tests.
 */

const assets = fileURLToPath(new URL('../../assets/setup/', import.meta.url));
const ready = (version = '1.2.3'): HelperResult => ({ status: 'ready', installed: true, detectedVersion: version });
const missing = (helper: string): HelperResult => ({ status: 'changes_required', installed: false, plannedActions: [`${helper}:install`] });
const describe = (helper: string, change: HelperChange) => ({
  command: `fake ${helper}${change === 'upgrade' ? ' -Upgrade' : change ? ' -Apply' : ' -CheckOnly'}`,
  file: `${helper}.ps1`,
});
const identify = (helper: string) => ({ file: `${helper}.ps1`, sha256: 'a'.repeat(64), source: 'cats-platform 1234567' });

test('an update runs -Upgrade on every platform, and only where a helper has one (FR-8)', () => {
  assert.deepEqual(helperInvocation(assets, 'win32', 'claude', 'upgrade').args.slice(-3), ['-Helper', 'claude', '-Upgrade']);
  assert.deepEqual(helperInvocation(assets, 'win32', 'node', 'upgrade').args.slice(-3), ['-Helper', 'node', '-Upgrade']);
  for (const platform of ['darwin', 'linux'] as const) {
    for (const helper of ['node', 'codex', 'claude', 'antigravity', 'grok', 'muse']) {
      assert.deepEqual(helperInvocation(assets, platform, helper, 'upgrade').args.slice(1), ['-Upgrade', '-Json'], `${platform}/${helper}`);
    }
  }
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.throws(() => helperInvocation(assets, platform, 'npm', 'upgrade'), /no update/u);
  }
  assert.throws(() => helperInvocation(assets, 'win32', 'shell', 'upgrade'), /no update/u);
  assert.match(describeHelperRun('C:\\Cats Bot\\setup', 'win32', 'grok', 'upgrade').command, / -Helper grok -Upgrade$/u);
});

test('the Windows dispatcher passes -Upgrade through and refuses it for the npm folder and PowerShell', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../assets/setup/Invoke-SetupHelper.ps1', import.meta.url), 'utf8');
  assert.match(source, /\[switch\]\$Upgrade/u);
  assert.match(source, /if \(\$Upgrade\) \{ & \$scriptPath -Upgrade -Json @scoped \}/u);
  assert.match(source, /\$Upgrade -and \$Helper -in @\('npm', 'shell'\)/u);
});

test('looking at the tab starts no process: every row reads not checked yet (FR-3)', () => {
  const calls: string[] = [];
  const setup = new ProviderSetup(async (helper) => { calls.push(helper); return ready(); }, { windows: true, describe, identify });
  const state = setup.computer();
  assert.deepEqual(calls, []);
  assert.equal(state.checkedAt, null);
  assert.deepEqual(state.steps.map((step) => step.id), ['node', 'npm', 'codex', 'claude', 'antigravity', 'grok', 'muse', 'shell']);
  assert.ok(state.steps.every((step) => step.status === 'not_checked'));
  assert.equal(state.steps.find((step) => step.id === 'shell')?.optional, true);
  // FR-8: only helpers with an update get its command.
  assert.equal(state.steps.find((step) => step.id === 'claude')?.updateCommand, 'fake claude -Upgrade');
  assert.equal(state.steps.find((step) => step.id === 'node')?.updateCommand, 'fake node -Upgrade');
  assert.equal(state.steps.find((step) => step.id === 'npm')?.updateCommand, null);
  assert.equal(state.steps.find((step) => step.id === 'shell')?.updateCommand, null);
  assert.equal(state.steps.find((step) => step.id === 'claude')?.applyCommand, 'fake claude -Apply');
  assert.equal(new ProviderSetup(async () => ready(), { windows: false }).computer().steps.some((step) => step.id === 'shell'), false);
});

test('Node.js is read first, what needs it waits unread, and at most three checks run at once (FR-4)', async () => {
  const calls: string[] = [];
  let running = 0;
  let most = 0;
  const setup = new ProviderSetup(async (helper, change) => {
    calls.push(`${helper}:${change}`);
    running += 1;
    most = Math.max(most, running);
    await new Promise((done) => setTimeout(done, 5));
    running -= 1;
    return helper === 'node' ? missing('node') : ready();
  }, { windows: true });
  const state = await setup.checkComputer();
  assert.equal(calls[0], 'node:false');
  assert.ok(!calls.some((call) => call.startsWith('npm') || call.startsWith('codex')), 'nothing waiting on Node.js ran');
  assert.ok(most <= 3, `ran ${most} at once`);
  assert.equal(state.steps.find((step) => step.id === 'npm')?.status, 'prerequisite_required');
  assert.equal(state.steps.find((step) => step.id === 'codex')?.status, 'prerequisite_required');
  assert.equal(state.steps.find((step) => step.id === 'node')?.status, 'changes_required');
  assert.deepEqual(state.steps.find((step) => step.id === 'node')?.planned, ['node:install']);
  assert.ok(state.checkedAt);
  // FR-3: the results last for the hub session.
  assert.equal(setup.computer(), state);
});

test('a row whose check cannot run says so and does not stop the others (FR-5)', async () => {
  const setup = new ProviderSetup(async (helper) => {
    if (helper === 'grok') throw new Error('The provider check timed out.');
    return ready();
  }, { windows: false });
  const state = await setup.checkComputer();
  const grok = state.steps.find((step) => step.id === 'grok')!;
  assert.equal(grok.status, 'check_failed');
  assert.equal(grok.checkError, 'The provider check timed out.');
  assert.ok(state.steps.filter((step) => step.id !== 'grok').every((step) => step.status === 'ready'));
  // FR-10: only working CLIs get a sign-in row, Claude says either way, the rest cannot tell.
  assert.deepEqual(Object.keys(state.signIn), ['codex', 'claude', 'antigravity', 'muse']);
  assert.deepEqual(state.signIn.claude, { state: 'signed_in', command: 'claude' });
  assert.equal(state.signIn.codex?.state, 'unknown');
});

test('a change runs only the ticked helper, after what it is installed through, then reads it again (FR-7)', async () => {
  const calls: string[] = [];
  const installed = new Set<string>(['node', 'npm']);
  const setup = new ProviderSetup(async (helper, change) => {
    calls.push(`${helper}:${change}`);
    if (change) installed.add(helper);
    return installed.has(helper) ? ready() : missing(helper);
  }, { windows: false });
  await setup.checkComputer();
  calls.length = 0;
  const state = await setup.changeComputer('codex', 'apply');
  assert.deepEqual(calls, ['node:false', 'npm:false', 'codex:true', 'codex:false']);
  assert.equal(state.steps.find((step) => step.id === 'codex')?.status, 'ready');
  assert.equal(state.signIn.codex?.command, 'codex login');
  assert.throws(() => setup.changeComputer('../evil', 'apply'), /Choose a setup step/u);
  assert.throws(() => setup.changeComputer('shell', 'apply'), /Choose a setup step/u, 'PowerShell scripts is Windows only');
  assert.throws(() => setup.changeComputer('npm', 'upgrade'), /no update/u);
  assert.throws(() => setup.changeComputer('claude', 'reinstall'), /no update/u);
});

test('Codex waits for Node.js and its npm folder, as the stem shows', async () => {
  const setup = new ProviderSetup(async (helper) => (helper === 'npm' ? missing('npm') : ready()), { windows: false });
  await assert.rejects(setup.changeComputer('codex', 'apply'), /Complete Node.js and npm setup first/u);
});

test('setting up Node.js also reads what was waiting on it', async () => {
  const installed = new Set<string>();
  const calls: string[] = [];
  const setup = new ProviderSetup(async (helper, change) => {
    calls.push(`${helper}:${change}`);
    if (change) installed.add(helper);
    return installed.has(helper) || helper === 'claude' ? ready() : missing(helper);
  }, { windows: false });
  await setup.checkComputer();
  calls.length = 0;
  const state = await setup.changeComputer('node', 'apply');
  assert.deepEqual(calls, ['node:true', 'node:false', 'npm:false', 'codex:false']);
  assert.equal(state.steps.find((step) => step.id === 'npm')?.status, 'changes_required');
  assert.deepEqual(state.steps.find((step) => step.id === 'codex')?.planned, ['codex:install']);
});

test('an update says what it found from the checks before and after it (FR-9)', async () => {
  let version = '2.0.14';
  const calls: string[] = [];
  const setup = new ProviderSetup(async (helper, change) => {
    calls.push(`${helper}:${change}`);
    if (change === 'upgrade') version = '2.0.20';
    return helper === 'claude' ? ready(version) : ready();
  }, { windows: false });
  await setup.checkComputer();
  calls.length = 0;
  let state = await setup.changeComputer('claude', 'upgrade');
  assert.deepEqual(calls, ['claude:false', 'claude:upgrade', 'claude:false']);
  assert.deepEqual(state.steps.find((step) => step.id === 'claude')?.lastUpdate, { from: '2.0.14', to: '2.0.20', outcome: 'updated' });
  state = await setup.changeComputer('claude', 'upgrade');
  assert.deepEqual(state.steps.find((step) => step.id === 'claude')?.lastUpdate, { from: '2.0.20', to: '2.0.20', outcome: 'current' });
});

test('an update that did not finish leaves the working version, and the row says so', async () => {
  const cases: Array<[HelperResult, string]> = [
    [{ status: 'failed', warnings: ['Network unreachable'] }, 'failed'],
    [{ status: 'changes_required', interruptions: [{ kind: 'elevation_required' }] }, 'declined'],
  ];
  for (const [result, outcome] of cases) {
    const setup = new ProviderSetup(async (_helper, change) => (change === 'upgrade' ? { ...result } : ready('22.11.0')), { windows: true });
    const state = await setup.changeComputer('node', 'upgrade');
    const node = state.steps.find((step) => step.id === 'node')!;
    assert.equal(node.status, 'ready', outcome);
    assert.equal(node.lastUpdate?.outcome, outcome);
  }
  const setup = new ProviderSetup(async () => missing('grok'), { windows: false });
  await assert.rejects(setup.changeComputer('grok', 'upgrade'), /Install it before updating it/u);
});

test('an update that changed nothing, or that finishes after a restart, says so', async () => {
  // Node's helper reports already_up_to_date_* when the version is current, and the check before had no version.
  let setup = new ProviderSetup(async (_helper, change) => (change === 'upgrade'
    ? { status: 'ready', installed: true, appliedChanges: ['already_up_to_date_node'] }
    : { status: 'ready', installed: true }), { windows: false });
  let node = (await setup.changeComputer('node', 'upgrade')).steps.find((step) => step.id === 'node')!;
  assert.equal(node.lastUpdate?.outcome, 'current');
  // An MSI that asks for a restart (3010) finishes its update afterwards.
  setup = new ProviderSetup(async (_helper, change) => (change === 'upgrade'
    ? { status: 'restart_required', restartRequired: true, interruptions: [{ kind: 'restart_required', requiresRestart: true }], appliedChanges: ['msi_install'] }
    : ready('22.11.0')), { windows: true });
  node = (await setup.changeComputer('node', 'upgrade')).steps.find((step) => step.id === 'node')!;
  assert.equal(node.lastUpdate?.outcome, 'restart');
});

test('a stopped check releases the hub only once every probe has ended', async () => {
  let running = 0;
  const setup = new ProviderSetup(async (helper, _change, signal) => {
    running += 1;
    try {
      await new Promise((done) => setTimeout(done, helper === 'node' ? 1 : 30));
      if (signal?.aborted) {
        // Ending a probe's process tree takes a while, and some take longer than others.
        await new Promise((done) => setTimeout(done, helper.length % 2 ? 5 : 40));
        throw new Error('Stopped');
      }
      return ready();
    } finally {
      running -= 1;
    }
  }, { windows: false });
  const checking = setup.checkComputer();
  await new Promise((done) => setTimeout(done, 15));
  setup.cancelCheck();
  await assert.rejects(checking);
  assert.equal(running, 0, 'a probe was still closing when the check gave up');
  assert.equal(setup.busy, false);
});

test('one setup operation at a time across the hub, whichever page started it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const setup = new ProviderSetup(async () => { await gate; return ready(); }, { windows: false });
  const checking = setup.checkComputer();
  await assert.rejects(setup.changeComputer('claude', 'apply'), /Wait for the current setup operation/u);
  await assert.rejects(setup.check('claude'), /Wait for the current setup operation/u);
  release();
  await checking;
  await setup.changeComputer('claude', 'apply');
});

test('a cat bot\'s own check and update reach the Agent CLIs tab too (FR-13)', async () => {
  let version = '0.9.0';
  const setup = new ProviderSetup(async (helper, change) => {
    if (helper === 'grok' && change === 'upgrade') version = '1.0.0';
    return helper === 'grok' ? ready(version) : missing(helper);
  }, { windows: false, describe });
  await setup.checkComputer();
  const before = await setup.check('grok');
  assert.equal(before.steps[0]?.updateCommand, 'fake grok -Upgrade');
  const after = await setup.install('grok', 'provider', undefined, 'upgrade');
  assert.deepEqual(after.steps[0]?.lastUpdate, { from: '0.9.0', to: '1.0.0', outcome: 'updated' });
  assert.equal(after.canFinish, true);
  const grok = setup.computer().steps.find((step) => step.id === 'grok')!;
  assert.equal(grok.version, '1.0.0');
  assert.equal(grok.label, 'Grok');
  await setup.check('codex');
  assert.throws(() => setup.install('codex', 'npm', undefined, 'upgrade'), /no update/u);
  assert.throws(() => setup.install('codex', 'provider', undefined, 'force'), /no update/u);
});

/* ---- The channels ---- */

function sender(id: number) {
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    event: { sender: { id, isDestroyed: () => false, send: (channel: string, entry: unknown) => sent.push([channel, entry]) }, senderFrame: {} },
  };
}

test('only Cats Bot Settings may use the Agent CLIs channels, and closing them removes every handler (FR-12)', async () => {
  ipcMain.handlers.clear();
  const calls: string[] = [];
  const opened: unknown[] = [];
  const setup = new ProviderSetup(async (helper, change) => { calls.push(`${helper}:${change}`); return ready(); }, { windows: true });
  let stopping = false;
  const cleanup = registerComputerSetupIpc({
    providers: setup,
    fromHub: (event) => event.sender.id === 1,
    stopping: () => stopping,
    openTerminal: async (provider) => { opened.push(provider); return { opened: true, command: 'claude' }; },
    initializeCodex: async () => ({ opened: false, command: 'codex' }),
  });
  const invoke = (event: unknown, channel: string, ...args: unknown[]) => Promise.resolve().then(() => ipcMain.handlers.get(channel)!(event, ...args));
  const hub = sender(1);
  const other = sender(2);
  for (const channel of COMPUTER_SETUP_CHANNELS) {
    await assert.rejects(invoke(other.event, channel, 'claude', 'apply'), /only from Cats Bot Settings/u, channel);
  }
  const blank = await invoke(hub.event, 'computer:state') as { checkedAt: string | null };
  assert.equal(blank.checkedAt, null);
  assert.deepEqual(calls, [], 'reading the state started nothing');
  await assert.rejects(invoke(hub.event, 'computer:openTerminal', 'claude'), /Check this computer first/u);
  await invoke(hub.event, 'computer:check');
  assert.ok(hub.sent.some(([channel, entry]) => channel === 'setup:log' && (entry as SetupLogEntry).helper === 'node'));
  assert.deepEqual(await invoke(hub.event, 'computer:openTerminal', 'claude'), { opened: true, command: 'claude' });
  assert.deepEqual(opened, ['claude']);
  assert.ok(hub.sent.some(([, entry]) => (entry as SetupLogEntry).kind === 'terminal'));
  await assert.rejects(invoke(hub.event, 'computer:openTerminal', 'npm'), /Check this computer first/u, 'a dependency has no sign-in');
  assert.deepEqual(await invoke(hub.event, 'computer:openCodexInitialization'), { opened: false, command: 'codex' });
  calls.length = 0;
  await invoke(hub.event, 'computer:change', 'grok', 'upgrade');
  assert.deepEqual(calls, ['grok:false', 'grok:upgrade', 'grok:false']);
  stopping = true;
  await assert.rejects(invoke(hub.event, 'computer:check'), /stopping/u);
  cleanup();
  assert.deepEqual(COMPUTER_SETUP_CHANNELS.filter((channel) => ipcMain.handlers.has(channel)), []);
});

test('what an update found stays on its row while that version is the one there', async () => {
  let version = '0.9.0';
  const setup = new ProviderSetup(async (helper, change) => {
    if (change === 'upgrade') version = '1.0.0';
    return helper === 'grok' ? ready(version) : ready();
  }, { windows: false });
  await setup.check('grok');
  await setup.install('grok', 'provider', undefined, 'upgrade');
  assert.equal((await setup.check('grok')).steps[0]?.lastUpdate?.outcome, 'updated', 'a later read keeps it');
  version = '1.1.0';
  assert.equal((await setup.check('grok')).steps[0]?.lastUpdate, undefined, 'a different version drops it');
});
