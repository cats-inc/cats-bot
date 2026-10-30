import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { initializeBot } from '../../src/core/bot.ts';
import { callHubControl, HubControlRefusal, HubControlRejectedError, HubControlServer, HubNotRunningError } from '../../src/core/host-api/hubControl.ts';
import { readBotProfile } from '../../src/core/profile/initialize.ts';
import { hubPathsFor } from '../../src/core/store/paths.ts';
import { acquireHubLock, readHubState, readOrCreateInstallationId, writeHubState } from '../../src/shell/electron/hub/hubState.ts';
import {
  activeBots, addBot, adoptionOrder, emptyRegistry, readRegistry, reconcileRegistry, withHolder, writeRegistry,
} from '../../src/shell/electron/hub/registry.ts';
import { FLOATING_CAT, placeFloating } from '../../src/shell/electron/floatingPlacement.ts';
import { applyWindowIdentity, botWindowIdentity } from '../../src/shell/electron/windowIdentity.ts';
import { makeTempHome, type TempHome } from '../support/harness.ts';

// PLAN-009 Phase 2 (SPEC-008 FR-1 to FR-4, FR-17, FR-18, FR-24, FR-25), apart from Electron.

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-hub-');
});
after(() => home.cleanup());

let roots = 0;
function freshHome(): string {
  const root = join(home.root, `home-${(roots += 1)}`);
  mkdirSync(join(root, 'bots'), { recursive: true });
  return root;
}

test('the registry round-trips, fills defaults and keeps a corrupt file as it is (FR-2)', () => {
  const root = freshHome();
  assert.deepEqual(readRegistry(root), { state: 'missing' });
  let registry = addBot(addBot(emptyRegistry(), 'mochi', new Date('2026-10-30T00:00:00Z')), 'nori');
  registry = withHolder(registry, 'mochi', 'first-run', new Date('2026-10-30T00:00:00Z'));
  writeRegistry(root, registry);
  const read = readRegistry(root);
  assert.equal(read.state, 'ok');
  if (read.state !== 'ok') return;
  assert.deepEqual(read.registry.bots.map((bot) => [bot.id, bot.order, bot.startAutomatically, bot.archivedAt]),
    [['mochi', 0, true, null], ['nori', 1, true, null]]);
  assert.equal(read.registry.bossCat.holder, 'mochi');
  assert.deepEqual(read.registry.environmentProfile, { kind: 'native' });
  assert.equal(read.registry.maxBots, 3);

  // Missing fields get defaults; a holder that names no bot is cleared.
  writeFileSync(hubPathsFor(root).registry, JSON.stringify({ schemaVersion: 1, bots: [{ id: 'mochi' }], bossCat: { holder: 'ghost' } }));
  const defaults = readRegistry(root);
  assert.equal(defaults.state, 'ok');
  if (defaults.state === 'ok') {
    assert.deepEqual(defaults.registry.bots[0], { id: 'mochi', order: 0, startAutomatically: true, createdAt: new Date(0).toISOString(), archivedAt: null });
    assert.equal(defaults.registry.bossCat.holder, null);
  }

  for (const corrupt of ['{not json', JSON.stringify({ schemaVersion: 2 }), JSON.stringify({ schemaVersion: 1, bots: [{ id: '../x' }] }),
    JSON.stringify({ schemaVersion: 1, bots: [{ id: 'a' }, { id: 'a' }] }), JSON.stringify({ schemaVersion: 1, environmentProfile: { kind: 'docker' } })]) {
    writeFileSync(hubPathsFor(root).registry, corrupt);
    assert.equal(readRegistry(root).state, 'corrupt', corrupt);
    assert.throws(() => writeRegistry(root, registry), /kept/u, 'a corrupt registry is never overwritten');
    assert.equal(readFileSync(hubPathsFor(root).registry, 'utf8'), corrupt);
  }
});

test('reconciling follows the directories and reports the rest, deleting nothing (FR-3)', () => {
  const root = freshHome();
  const paths = hubPathsFor(root);
  for (const id of ['mochi', 'nori', 'stray']) initializeBot(paths.bots, { id, name: id, provider: 'claude' });
  initializeBot(paths.archive, { id: 'old', name: 'old', provider: 'claude' });
  mkdirSync(join(paths.bots, 'Not-An-Id'), { recursive: true });
  let registry = emptyRegistry();
  for (const id of ['mochi', 'nori', 'old', 'gone']) registry = addBot(registry, id);
  registry = { ...registry, bots: registry.bots.map((bot) => (bot.id === 'nori' ? { ...bot, archivedAt: '2026-10-01T00:00:00Z' } : bot)) };
  const reconciled = reconcileRegistry(root, registry, new Date('2026-10-30T00:00:00Z'));
  assert.equal(reconciled.changed, true);
  const byId = Object.fromEntries(reconciled.registry.bots.map((bot) => [bot.id, bot.archivedAt]));
  assert.deepEqual(byId, { mochi: null, nori: null, old: '2026-10-30T00:00:00.000Z', gone: null }, 'the directory decides');
  assert.deepEqual(reconciled.unregistered, ['stray']);
  assert.deepEqual(reconciled.missing, ['gone']);
  assert.deepEqual(reconciled.skipped, ['Not-An-Id']);
  assert.deepEqual(activeBots(reconciled.registry, root).map((bot) => bot.id), ['mochi', 'nori']);
});

test('hub preferences live in the hub state file, and the installation keeps one id (FR-1, FR-18)', () => {
  const root = freshHome();
  assert.equal(readHubState(root), null);
  writeHubState(root, { schemaVersion: 1, language: 'zh-TW', openAtLogin: true });
  assert.deepEqual(readHubState(root), { schemaVersion: 1, language: 'zh-TW', openAtLogin: true });
  writeFileSync(hubPathsFor(root).state, JSON.stringify({ language: 'klingon', openAtLogin: 'yes' }));
  assert.deepEqual(readHubState(root), { schemaVersion: 1, language: 'system', openAtLogin: false });

  const userData = join(root, 'electron');
  const id = readOrCreateInstallationId(userData);
  assert.match(id, /^[0-9a-f-]{36}$/u);
  assert.equal(readOrCreateInstallationId(userData), id);
});

test('one hub holds a root; a second learns which installation does (FR-1)', () => {
  const root = freshHome();
  const first = acquireHubLock(root, 'install-a', 'C:\\A\\Cats Bot.exe');
  assert.equal(first.held, true);
  // The test process is alive, so a lock naming it is held.
  const second = acquireHubLock(root, 'install-b', 'C:\\B\\Cats Bot.exe');
  assert.equal(second.held, false);
  if (!second.held) {
    assert.equal(second.owner.installationId, 'install-a');
    assert.equal(second.owner.executable, 'C:\\A\\Cats Bot.exe');
  }
  if (first.held) first.release();
  const third = acquireHubLock(root, 'install-b', 'C:\\B\\Cats Bot.exe');
  assert.equal(third.held, true);
  if (third.held) third.release();
  // A lock left by a process that is gone is taken over.
  writeFileSync(hubPathsFor(root).lock, JSON.stringify({ pid: 2 ** 30, host: 'elsewhere', installationId: 'x', executable: 'y', startedAt: '' }));
  const fourth = acquireHubLock(root, 'install-b', 'C:\\B\\Cats Bot.exe');
  assert.equal(fourth.held, true);
  if (fourth.held) fourth.release();
});

test('owner CLI hub commands go through the hub, and refuse without one (FR-25)', async () => {
  const root = freshHome();
  await assert.rejects(callHubControl(root, { operation: 'status' }), HubNotRunningError);
  const server = new HubControlServer(root, 'install-a', {
    status: () => ({ bots: [{ id: 'mochi', state: 'running' }] }),
    refuse: () => { throw new HubControlRefusal('The bot cap of 3 is reached.'); },
    fail: () => { throw new Error('secret internal detail'); },
  });
  await server.start();
  try {
    const descriptor = JSON.parse(readFileSync(hubPathsFor(root).control, 'utf8')) as Record<string, unknown>;
    assert.equal(descriptor.installationId, 'install-a');
    assert.match(String(descriptor.token), /^[a-f0-9]{64}$/u);
    assert.deepEqual(await callHubControl(root, { operation: 'status' }), { bots: [{ id: 'mochi', state: 'running' }] });
    await assert.rejects(callHubControl(root, { operation: 'refuse' }), (error: Error) =>
      error instanceof HubControlRejectedError && error.message === 'The bot cap of 3 is reached.');
    await assert.rejects(callHubControl(root, { operation: 'fail' }), (error: Error) =>
      error instanceof HubControlRejectedError && !error.message.includes('secret'));
    await assert.rejects(callHubControl(root, { operation: 'constructor' }), /Unsupported hub operation/u);
    // A wrong token is refused.
    writeFileSync(hubPathsFor(root).control, JSON.stringify({ ...descriptor, token: 'f'.repeat(64) }));
    await assert.rejects(callHubControl(root, { operation: 'status' }), HubControlRejectedError);
    writeFileSync(hubPathsFor(root).control, JSON.stringify(descriptor));
  } finally {
    await server.stop();
  }
  await assert.rejects(callHubControl(root, { operation: 'status' }), HubNotRunningError, 'a stopped hub removes its descriptor');
});

test('cats-bot hub boss-cat asks the hub to set or clear the Boss Cat (SPEC-009 FR-2)', async () => {
  const { spawn } = await import('node:child_process');
  const root = freshHome();
  const asked: unknown[] = [];
  const server = new HubControlServer(root, 'install-a', {
    setBossCat: (body) => {
      asked.push(body.bot);
      if (body.bot === 'ghost') throw new HubControlRefusal('Bot ghost is not active.');
      return { pid: 1, bossCat: body.bot, bots: [{ id: 'nori-catsbot', state: 'running', pid: 7, startAutomatically: true }] };
    },
  });
  await server.start();
  const env: NodeJS.ProcessEnv = { ...process.env, CATS_BOT_HOME: root };
  delete env.CATS_BOT_ID;
  // The CLI runs as a child, so the endpoint in this process can answer it.
  const cli = (...args: string[]) => new Promise<{ status: number | null; out: string }>((resolveRun) => {
    const child = spawn(process.execPath, ['src/cli/main.ts', 'hub', 'boss-cat', ...args], { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('exit', (status) => resolveRun({ status, out }));
  });
  try {
    const set = await cli('nori-catsbot');
    assert.equal(set.status, 0, set.out);
    assert.match(set.out, /nori-catsbot.*Boss Cat/u);
    assert.equal((await cli('--clear')).status, 0);
    const refused = await cli('ghost');
    assert.equal(refused.status, 1);
    assert.match(refused.out, /Bot ghost is not active/u);
    assert.equal((await cli()).status, 2, 'a bot id or --clear is needed');
    assert.deepEqual(asked, ['nori-catsbot', null, 'ghost']);
  } finally {
    await server.stop();
  }
});

test('a bot profile records the native environment, and any other kind is refused (FR-24)', () => {
  const root = freshHome();
  const { root: botRoot } = initializeBot(join(root, 'bots'), { id: 'mochi', name: 'Mochi', provider: 'claude' });
  assert.deepEqual(readBotProfile(botRoot)?.environment, { kind: 'native' });
  const file = join(botRoot, 'profile.json');
  const profile = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete profile.environment;
  writeFileSync(file, JSON.stringify(profile));
  assert.deepEqual(readBotProfile(botRoot)?.environment, { kind: 'native' }, 'an older profile runs natively');
  writeFileSync(file, JSON.stringify({ ...profile, environment: { kind: 'docker', image: 'x' } }));
  assert.throws(() => readBotProfile(botRoot), /Unsupported execution environment "docker"/u);
});

test('a bot\'s windows carry its own AUMID and relaunch the hub on it (FR-17)', () => {
  const identity = botWindowIdentity({ appId: 'io.catsinc.catsbot', botId: 'mochi', botName: 'Mochi', executable: 'C:\\Cats Bot\\Cats Bot.exe', packaged: true });
  assert.deepEqual(identity, {
    appId: 'io.catsinc.catsbot.mochi',
    relaunch: { command: '"C:\\Cats Bot\\Cats Bot.exe" --id mochi', displayName: 'Cats Bot - Mochi', icon: 'C:\\Cats Bot\\Cats Bot.exe' },
  });
  assert.deepEqual(botWindowIdentity({ appId: 'io.catsinc.catsbot', botId: 'mochi', botName: 'Mochi', executable: 'electron.exe', packaged: false }),
    { appId: 'io.catsinc.catsbot.mochi' }, 'a development build pins nothing');
  const applied: unknown[] = [];
  const window = { setAppDetails: (details: unknown) => applied.push(details) } as unknown as Electron.BrowserWindow;
  applyWindowIdentity(window, identity, 'win32');
  applyWindowIdentity(window, identity, 'darwin');
  assert.deepEqual(applied, [{
    appId: 'io.catsinc.catsbot.mochi',
    relaunchCommand: '"C:\\Cats Bot\\Cats Bot.exe" --id mochi', relaunchDisplayName: 'Cats Bot - Mochi', appIconPath: 'C:\\Cats Bot\\Cats Bot.exe',
  }]);
});

test('review of Phase 2: locks of a process that ended on this host are taken over; a live registry lock is honoured', async () => {
  const root = freshHome();
  const { spawn } = await import('node:child_process');
  const { hostname } = await import('node:os');
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const deadPid = await new Promise<number>((resolveExit) => child.once('exit', () => resolveExit(child.pid!)));
  writeFileSync(hubPathsFor(root).lock, JSON.stringify({ pid: deadPid, host: hostname(), installationId: 'x', executable: 'y', startedAt: '' }));
  const lock = acquireHubLock(root, 'install-a', 'C:\A\Cats Bot.exe');
  assert.equal(lock.held, true, 'a lock naming an ended process on this host is stale');
  if (lock.held) lock.release();
  // Another live process holds the registry's write lock.
  writeFileSync(hubPathsFor(root).registryLock, JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: '' }));
  assert.throws(() => writeRegistry(root, emptyRegistry()), /being written by another process/u);
});

test('review of Phase 2: only folders with a profile are bots, and a launch-named bot is taken in first (D11)', () => {
  const root = freshHome();
  mkdirSync(join(root, 'bots', 'empty'), { recursive: true });
  initializeBot(join(root, 'bots'), { id: 'real', name: 'Real', provider: 'claude' });
  assert.deepEqual(reconcileRegistry(root, emptyRegistry()).unregistered, ['real']);
  assert.deepEqual(adoptionOrder(['c', 'a', 'b', 'd'], 'd', 3), ['d', 'a', 'b']);
  assert.deepEqual(adoptionOrder(['c', 'a', 'b', 'd'], 'zz', 3), ['a', 'b', 'c'], 'an unknown name changes nothing');
});

test('review of Phase 2: a descriptor left by a hub that is gone means no hub runs', async () => {
  const root = freshHome();
  const socket = process.platform === 'win32' ? `\\.\pipe\cats-bot-gone-${process.pid}` : join(root, 'gone.sock');
  writeFileSync(hubPathsFor(root).control, JSON.stringify({ version: 1, socket, token: 'a'.repeat(64), pid: 1, installationId: 'x' }));
  await assert.rejects(callHubControl(root, { operation: 'status' }), HubNotRunningError);
  await assert.rejects(callHubControl(root, { operation: 'status', padding: 'x'.repeat(20_000) }), /size limit/u);
});

test('review of Phase 2: a further bot\'s floating cat starts one cat to the left (FR-17)', () => {
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const first = placeFloating({}, [display], display);
  const second = placeFloating({}, [display], display, undefined, 1);
  assert.equal(second.y, first.y);
  assert.equal(first.x - second.x, FLOATING_CAT.width + 16);
  assert.deepEqual(placeFloating({ x: 100, y: 100 }, [display], display, undefined, 2), { x: 100, y: 100 }, 'a remembered place wins');
});
