import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { initializeBot } from '../../src/core/bot.ts';
import { acquireInstanceLock } from '../../src/core/store/lock.ts';
import { botPathsFor, hubPathsFor } from '../../src/core/store/paths.ts';
import { BotManagementError, BotManager, type BotCores } from '../../src/shell/electron/hub/botManager.ts';
import { CoreRunner } from '../../src/shell/electron/hub/coreRunner.ts';
import { addBot, emptyRegistry, readRegistry, withHolder, writeRegistry } from '../../src/shell/electron/hub/registry.ts';
import { makeTempHome, type TempHome } from '../support/harness.ts';

// PLAN-009 Phase 3 (SPEC-008 FR-3, FR-5, FR-6, FR-9 to FR-11), apart from Electron.

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-manage-');
});
after(() => home.cleanup());

let homes = 0;
function setUp(ids: string[] = []) {
  const root = join(home.root, `home-${(homes += 1)}`);
  mkdirSync(join(root, 'bots'), { recursive: true });
  let registry = emptyRegistry();
  for (const id of ids) {
    initializeBot(join(root, 'bots'), { id, name: id, provider: 'claude' });
    registry = addBot(registry, id);
  }
  registry = withHolder(registry, ids[0] ?? null, 'owner');
  writeRegistry(root, registry);
  const stopped: string[] = [];
  const external = new Set<string>();
  const cores: BotCores = {
    stop: async (id) => { stopped.push(id); },
    hostedElsewhere: (id) => external.has(id),
  };
  return { root, manager: new BotManager(root, registry, cores), stopped, external };
}

const saved = (root: string) => {
  const read = readRegistry(root);
  assert.equal(read.state, 'ok');
  return read.state === 'ok' ? read.registry : emptyRegistry();
};

test('creating bots stops at the cap, and archived bots do not count (FR-6)', async () => {
  const { root, manager } = setUp(['mochi']);
  assert.equal(await manager.create({ name: 'Nori', provider: 'claude' }), 'nori-catsbot');
  assert.equal(await manager.create({ name: 'Nori', provider: 'codex' }), 'nori-catsbot-2', 'a taken id gets a number');
  await assert.rejects(manager.create({ name: 'Four', provider: 'claude' }), (error: Error) =>
    error instanceof BotManagementError && /at most 3 bots/u.test(error.message));
  assert.deepEqual(saved(root).bots.map((bot) => bot.id), ['mochi', 'nori-catsbot', 'nori-catsbot-2']);
  await manager.archive('nori-catsbot-2');
  assert.equal(await manager.create({ name: 'Four', provider: 'claude' }), 'four-catsbot');
  await assert.rejects(manager.restore('nori-catsbot-2'), /at most 3 bots/u, 'restoring is held to the cap too');
  await assert.rejects(manager.create({ id: '../escape', name: 'x', provider: 'claude' }), /not a valid bot id/u);
});

test('archive stops the bot, moves it under its lock and clears the Boss Cat role (FR-5)', async () => {
  const { root, manager, stopped } = setUp(['mochi', 'nori']);
  const paths = hubPathsFor(root);
  await manager.archive('mochi');
  assert.deepEqual(stopped, ['mochi']);
  assert.equal(existsSync(join(paths.bots, 'mochi')), false);
  assert.equal(existsSync(join(paths.archive, 'mochi', 'profile.json')), true);
  assert.equal(existsSync(botPathsFor(join(paths.archive, 'mochi')).lock), false, 'the lock that moved with it is released');
  const registry = saved(root);
  assert.notEqual(registry.bots.find((bot) => bot.id === 'mochi')?.archivedAt, null);
  assert.equal(registry.bossCat.holder, null, 'archiving the holder clears the role');

  await manager.restore('mochi');
  assert.equal(existsSync(join(paths.bots, 'mochi', 'profile.json')), true);
  assert.equal(saved(root).bots.find((bot) => bot.id === 'mochi')?.archivedAt, null);
});

test('a bot in use by another program is neither archived nor moved', async () => {
  const { root, manager, external } = setUp(['mochi', 'nori']);
  external.add('mochi');
  await assert.rejects(manager.archive('mochi'), /running in another program/u);
  // Another live process (the test runner's parent) holds the bot's instance lock.
  const lockFile = botPathsFor(join(hubPathsFor(root).bots, 'nori')).lock;
  const lock = acquireInstanceLock(botPathsFor(join(hubPathsFor(root).bots, 'nori')), process.ppid);
  try {
    await assert.rejects(manager.archive('nori'), /in use by another program/u);
    assert.equal(existsSync(join(hubPathsFor(root).bots, 'nori', 'profile.json')), true, 'left where it was');
    assert.equal(saved(root).bots.find((bot) => bot.id === 'nori')?.archivedAt, null);
  } finally {
    if (lock.held) lock.release();
    assert.equal(existsSync(lockFile), false);
  }
});

test('only an archived bot is deleted, through trash, and nothing outside it is followed (FR-5)', async () => {
  const { root, manager } = setUp(['mochi', 'nori']);
  const paths = hubPathsFor(root);
  await assert.rejects(manager.delete('nori'), /Only an archived bot can be deleted/u);
  // A junction inside the bot must not lead the removal into its target.
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'precious.txt'), 'keep');
  symlinkSync(outside, join(paths.bots, 'nori', 'link'), 'junction');
  await manager.archive('nori');
  await manager.delete('nori');
  assert.equal(existsSync(join(paths.archive, 'nori')), false);
  assert.equal(saved(root).bots.some((bot) => bot.id === 'nori'), false);
  assert.equal(readFileSync(join(outside, 'precious.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(paths.trash) ? (await import('node:fs')).readdirSync(paths.trash).length : 0, 0);
});

test('at start a delete that stopped partway is finished and the registry follows the directories (FR-3)', async () => {
  const { root, manager } = setUp(['mochi', 'nori']);
  const paths = hubPathsFor(root);
  // A delete that moved `nori` into trash and stopped before the registry write.
  mkdirSync(paths.trash, { recursive: true });
  const { renameSync } = await import('node:fs');
  renameSync(join(paths.bots, 'nori'), join(paths.trash, 'nori.1700000000000'));
  // A directory moved into archive/ by hand, and one nobody registered.
  initializeBot(paths.bots, { id: 'stray', name: 'stray', provider: 'claude' });
  const report = manager.recover();
  assert.deepEqual(report.unregistered, ['stray']);
  assert.equal(existsSync(join(paths.trash, 'nori.1700000000000')), false);
  assert.deepEqual(saved(root).bots.map((bot) => bot.id), ['mochi']);
  await manager.register('stray');
  assert.deepEqual(saved(root).bots.map((bot) => bot.id), ['mochi', 'stray']);
});

test('order and start-automatically are kept per bot (FR-5)', async () => {
  const { root, manager } = setUp(['a', 'b', 'c']);
  await manager.reorder(['c', 'a', 'b']);
  assert.deepEqual(saved(root).bots.map((bot) => bot.id), ['c', 'a', 'b']);
  await assert.rejects(manager.reorder(['a', 'b']), /every bot once/u);
  await manager.setStartAutomatically('a', false);
  assert.equal(saved(root).bots.find((bot) => bot.id === 'a')?.startAutomatically, false);
});

test('a core that ends unasked restarts with backoff, then stays failed (FR-9)', async () => {
  const changes: string[] = [];
  const lostListeners: Array<() => void> = [];
  let starts = 0;
  let failStart = false;
  const runner = new CoreRunner<number>('mochi', {
    start: async () => {
      starts += 1;
      if (failStart) throw new Error('no runtime');
      return starts;
    },
    stop: async () => undefined,
    onLost: (_handle, listener) => { lostListeners.push(listener); },
    isExternal: () => false,
    changed: () => changes.push(runner.state),
    log: () => undefined,
    delaysMs: [10, 20],
    maxRestarts: 2,
    windowMs: 60_000,
  });
  assert.equal(await runner.start(), 1);
  assert.equal(runner.state, 'running');
  lostListeners.shift()!();
  assert.equal(runner.state, 'failed');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runner.state, 'running', 'restarted after the first wait');
  assert.equal(starts, 2);
  failStart = true;
  lostListeners.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(runner.state, 'failed');
  assert.equal(runner.exhausted, true, 'no third restart within the window');
  assert.equal(starts, 3);
  // The owner's start counts again from zero.
  failStart = false;
  assert.equal(await runner.start(), 4);
  await runner.stop();
  assert.equal(runner.state, 'stopped');
});

test('a stop is never followed by a restart, and an externally hosted core is only reported (FR-10, FR-11)', async () => {
  const lostListeners: Array<() => void> = [];
  const runner = new CoreRunner<string>('mochi', {
    start: async () => 'core',
    stop: async () => { lostListeners.shift()?.(); },
    onLost: (_handle, listener) => { lostListeners.push(listener); },
    isExternal: () => false,
    changed: () => undefined,
    log: () => undefined,
    delaysMs: [5],
  });
  await runner.start();
  await runner.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runner.state, 'stopped');

  const external = new CoreRunner<string>('nori', {
    start: async () => { throw Object.assign(new Error('Another instance of this bot is running (pid 42).'), { external: true }); },
    stop: async () => undefined,
    onLost: () => undefined,
    isExternal: (error) => (error as { external?: boolean }).external === true,
    changed: () => undefined,
    log: () => undefined,
  });
  assert.equal(await external.start(), null);
  assert.equal(external.state, 'external');
  assert.match(external.error ?? '', /pid 42/u);
});

test('an archived id is reserved: cats-bot run and init refuse it (FR-5)', async () => {
  const { root, manager } = setUp(['mochi', 'old-catsbot']);
  await manager.archive('old-catsbot');
  const env: NodeJS.ProcessEnv = { ...process.env, CATS_BOT_HOME: root };
  delete env.CATS_BOT_ID;
  for (const args of [['run', '--id', 'old-catsbot'], ['init', '--name', 'Old', '--provider', 'claude', '--id', 'old-catsbot'], ['init', '--name', 'Old', '--provider', 'claude']]) {
    const result = spawnSync(process.execPath, ['src/cli/main.ts', ...args], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /Bot old-catsbot is archived/u);
  }
  assert.equal(existsSync(join(hubPathsFor(root).bots, 'old-catsbot')), false, 'no new bot root was created');
});

test('removing a bot never empties what a link inside it points to, under node and under Electron\'s node (review of #66)', async () => {
  const { spawnSync: run } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { resolve: resolvePath } = await import('node:path');
  const moduleUrl = pathToFileURL(resolvePath('src/core/store/removeTree.ts')).href;
  const script = resolvePath('tests/support/remove-tree-check.mjs');
  const electron = resolvePath('node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const runtimes: Array<{ command: string; env: NodeJS.ProcessEnv }> = [{ command: process.execPath, env: process.env }];
  // The hub runs on Electron's own Node, whose recursive rmSync follows junctions.
  if (existsSync(electron)) runtimes.push({ command: electron, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  for (const runtime of runtimes) {
    const temp = mkdtempSync(join(home.root, 'remove-'));
    const result = run(runtime.command, [script, moduleUrl, temp], { env: runtime.env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { runtime: string; botRemoved: boolean; outsideKept: boolean };
    assert.equal(report.botRemoved, true, report.runtime);
    assert.equal(report.outsideKept, true, `${report.runtime} emptied the link's target`);
  }
});

test('review of #66: the owner hears once that a bot is no longer restarted, and a core lost before it was watched restarts', async () => {
  const gaveUp: string[] = [];
  let starts = 0;
  const lost: Array<() => void> = [];
  const runner = new CoreRunner<number>('mochi', {
    start: async () => { starts += 1; return starts; },
    stop: async () => undefined,
    // The core is already gone when the runner starts to watch it.
    onLost: (_handle, listener) => { lost.push(listener); queueMicrotask(listener); },
    isExternal: () => false,
    changed: () => undefined,
    gaveUp: () => gaveUp.push(runner.state),
    log: () => undefined,
    delaysMs: [5],
    maxRestarts: 2,
    windowMs: 60_000,
  });
  await runner.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(starts, 3, 'started, then restarted twice');
  assert.deepEqual(gaveUp, ['failed'], 'one notice, when it gave up, not at each crash');
  assert.equal(runner.exhausted, true);
  await runner.stop();
});

test('review of #66: trash keeps what the hub did not put there, and a bot with no folder is not moved', async () => {
  const { root, manager } = setUp(['mochi', 'nori']);
  const paths = hubPathsFor(root);
  mkdirSync(join(paths.trash, 'keep-me'), { recursive: true });
  writeFileSync(join(paths.trash, 'notes.txt'), 'mine');
  manager.recover();
  assert.equal(existsSync(join(paths.trash, 'keep-me')), true);
  assert.equal(existsSync(join(paths.trash, 'notes.txt')), true);
  const { renameSync } = await import('node:fs');
  renameSync(join(paths.bots, 'nori'), join(root, 'elsewhere'));
  await assert.rejects(manager.archive('nori'), /folder is missing/u);
  assert.equal(existsSync(join(paths.archive, 'nori')), false, 'no empty archive folder');
});
