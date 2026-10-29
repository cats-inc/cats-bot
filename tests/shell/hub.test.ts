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
  activeBots, addBot, emptyRegistry, readRegistry, reconcileRegistry, writeRegistry,
} from '../../src/shell/electron/hub/registry.ts';
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
  registry = { ...registry, coordinator: { holder: 'mochi' } };
  writeRegistry(root, registry);
  const read = readRegistry(root);
  assert.equal(read.state, 'ok');
  if (read.state !== 'ok') return;
  assert.deepEqual(read.registry.bots.map((bot) => [bot.id, bot.order, bot.startAutomatically, bot.archivedAt]),
    [['mochi', 0, true, null], ['nori', 1, true, null]]);
  assert.equal(read.registry.coordinator.holder, 'mochi');
  assert.deepEqual(read.registry.environmentProfile, { kind: 'native' });
  assert.equal(read.registry.maxBots, 3);

  // Missing fields get defaults; a holder that names no bot is cleared.
  writeFileSync(hubPathsFor(root).registry, JSON.stringify({ schemaVersion: 1, bots: [{ id: 'mochi' }], coordinator: { holder: 'ghost' } }));
  const defaults = readRegistry(root);
  assert.equal(defaults.state, 'ok');
  if (defaults.state === 'ok') {
    assert.deepEqual(defaults.registry.bots[0], { id: 'mochi', order: 0, startAutomatically: true, createdAt: new Date(0).toISOString(), archivedAt: null });
    assert.equal(defaults.registry.coordinator.holder, null);
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
