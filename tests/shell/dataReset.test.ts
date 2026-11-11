import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { acquireInstanceLock, writeHandoff } from '../../src/core/store/lock.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import { removeTree } from '../../src/core/store/removeTree.ts';
import { completePendingBotDataReset, DATA_RESET_JOURNAL, prepareBotDataReset, validateBotDataReset } from '../../src/shell/electron/hub/dataReset.ts';
import { createDataResetHandler, dataResetRelaunchArgs } from '../../src/shell/electron/dataResetHandler.ts';
import { initializeBot } from '../../src/core/profile/initialize.ts';
import { BotCore } from '../../src/core/bot.ts';
import { FileSecretStore, SECRET_TELEGRAM_TOKEN } from '../../src/core/secrets.ts';
import { main as cliMain } from '../../src/cli/main.ts';

const consent = { confirmation: 'RESET', resetRuntime: false };
test('reset relaunch keeps the isolated Electron profile and returns to setup rather than recreating a CLI-selected bot', () => {
  assert.deepEqual(dataResetRelaunchArgs(['.', '--user-data-dir=C:/profile', '--id', 'mochi', '--provider=claude', '--name', 'Mochi', '--model=x', '--remote-debugging-port=0']),
    ['.', '--user-data-dir=C:/profile', '--remote-debugging-port=0']);
});
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cats-data-reset-'));
  const home = join(root, 'catsbot');
  const put = (name: string, value = name) => {
    const file = join(home, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); return file;
  };
  for (const dir of ['bots/mochi', 'archive/sora', 'trash/old.123']) {
    put(`${dir}/profile.json`); put(`${dir}/transcripts/home.jsonl`); put(`${dir}/workspace/file.txt`);
    put(`${dir}/runtime/config/providers.yaml`); put(`${dir}/runtime/sessions/conversation.json`);
  }
  for (const name of ['bots.json', 'bots.json.bak', 'hub-state.json', 'setup-draft.json', 'window-state.json', 'boss-cat/deliveries.jsonl', 'logs/hub-audit.jsonl']) put(name);
  put('unrelated.txt', 'keep');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, put };
}

test('Bot-only reset erases all Bot/Hub state and retains each Runtime, including archives and trash', t => {
  const { home } = fixture(t);
  prepareBotDataReset(home, consent);
  assert.equal(completePendingBotDataReset(home), true);
  assert.equal(completePendingBotDataReset(home), false);
  for (const name of ['bots', 'archive', 'trash', 'bots.json', 'bots.json.bak', 'hub-state.json', 'window-state.json', 'setup-draft.json', 'boss-cat', 'logs', DATA_RESET_JOURNAL]) {
    assert.equal(existsSync(join(home, name)), false, name);
  }
  const retained = join(home, 'retained-runtime', readdirSync(join(home, 'retained-runtime'))[0]!);
  for (const dir of ['bots/mochi', 'archive/sora', 'trash/old.123']) {
    assert.equal(readFileSync(join(retained, dir, 'config/providers.yaml'), 'utf8'), `${dir}/runtime/config/providers.yaml`);
    assert.equal(existsSync(join(retained, dir, 'profile.json')), false);
  }
  assert.equal(readFileSync(join(home, 'unrelated.txt'), 'utf8'), 'keep');
});

test('optional Runtime reset also erases Runtime retained by earlier resets', t => {
  const { home, put } = fixture(t);
  prepareBotDataReset(home, consent); completePendingBotDataReset(home);
  put('bots/new/profile.json'); put('bots/new/runtime/data/cache');
  prepareBotDataReset(home, { ...consent, resetRuntime: true });
  completePendingBotDataReset(home);
  assert.deepEqual(readdirSync(home), ['unrelated.txt']);
});

test('an interrupted purge keeps durable consent and finishes on the next start without losing retained Runtime', t => {
  const { home } = fixture(t);
  prepareBotDataReset(home, consent);
  let count = 0;
  assert.throws(() => completePendingBotDataReset(home, { remove: target => {
    if (++count === 2) throw new Error('disk busy');
    removeTree(target);
  } }), /disk busy/u);
  assert.equal(existsSync(join(home, DATA_RESET_JOURNAL)), true);
  assert.throws(() => prepareBotDataReset(home, { ...consent, resetRuntime: true }), /pending/u);
  assert.equal(completePendingBotDataReset(home), true);
  assert.equal(readdirSync(join(home, 'retained-runtime')).length, 1);
});

test('all locks are taken before erasure, including unregistered bots; refusal leaves data and consent intact', t => {
  const { home, put } = fixture(t);
  put('bots/unregistered/profile.json');
  prepareBotDataReset(home, { ...consent, resetRuntime: true });
  const lock = acquireInstanceLock(botPathsFor(join(home, 'bots/unregistered')), process.pid, { dataReset: true });
  assert.equal(lock.held, true);
  try {
    assert.throws(() => completePendingBotDataReset(home), /another program/u);
    assert.equal(existsSync(join(home, 'bots/mochi/profile.json')), true);
    assert.equal(existsSync(join(home, DATA_RESET_JOURNAL)), true);
  } finally { if (lock.held) lock.release(); }
  assert.equal(completePendingBotDataReset(home), true);
});

test('pending reset fences headless startup, init and lock acquisition even while purge removes a lock', t => {
  const { home } = fixture(t);
  prepareBotDataReset(home, consent);
  const root = join(home, 'bots/mochi');
  const blocked = () => {
    assert.throws(() => acquireInstanceLock(botPathsFor(root)), /reset is pending/u);
    assert.throws(() => BotCore.open({ root }), /reset is pending/u);
    assert.throws(() => initializeBot(join(home, 'bots'), { id: 'new', name: 'New', provider: 'claude' }), /reset is pending/u);
  };
  blocked();
  let attempted = false;
  completePendingBotDataReset(home, { remove: target => {
    if (target === join(home, 'bots')) {
      removeTree(join(root, 'instance.lock.json'));
      assert.equal(existsSync(join(root, 'profile.json')), true);
      blocked(); attempted = true;
    }
    removeTree(target);
  } });
  assert.equal(attempted, true);
});

test('pending reset blocks CLI Telegram tokens and late secret/handoff writers after a bot directory is purged', async t => {
  const { home } = fixture(t);
  const root = join(home, 'bots/mochi');
  const store = new FileSecretStore(root);
  prepareBotDataReset(home, consent);
  removeTree(join(home, 'bots'));
  assert.equal(await cliMain(['telegram', 'set-token', 'TEST_ONLY_FAKE_TOKEN', '--id', 'mochi'], { ...process.env, CATS_BOT_HOME: home }), 1);
  assert.throws(() => store.set(SECRET_TELEGRAM_TOKEN, 'TEST_ONLY_FAKE_TOKEN'), /reset is pending/u);
  assert.throws(() => writeHandoff(botPathsFor(root), { kind: 'open', conversationId: 'home' }), /reset is pending/u);
  assert.equal(existsSync(root), false);
  completePendingBotDataReset(home);
});

test('redirected roots and Runtime storage are refused before any data is erased; workspace links keep external files', t => {
  const { root, home, put } = fixture(t);
  const outside = join(root, 'external'); mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'external');
  symlinkSync(outside, join(home, 'bots/mochi/workspace/project'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(home, join(root, 'redirected'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareBotDataReset(join(root, 'redirected'), consent), /redirected/u);
  const badRuntime = put('bots/bad/profile.json');
  symlinkSync(outside, join(dirname(badRuntime), 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareBotDataReset(home, consent), /redirected/u);
  removeTree(join(home, 'bots/bad'));
  prepareBotDataReset(home, { ...consent, resetRuntime: true }); completePendingBotDataReset(home);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'external');
});

test('unsafe installation overlap and malformed consent/journal never authorize a purge', t => {
  const { home, put } = fixture(t);
  for (const request of [null, {}, { ...consent, confirmation: 'reset' }, { ...consent, resetRuntime: 'true' }]) {
    assert.throws(() => prepareBotDataReset(home, request), /RESET/u);
  }
  assert.throws(() => validateBotDataReset(home, [join(home, 'installed')]), /Unsafe/u);
  put(DATA_RESET_JOURNAL, '{"schemaVersion":1,"id":"../escape","resetRuntime":true}');
  assert.throws(() => completePendingBotDataReset(home), /Invalid/u);
  assert.equal(existsSync(join(home, 'bots/mochi/profile.json')), true);
});

test('OS preference reset failure preserves consent and all product data', t => {
  const { home } = fixture(t);
  prepareBotDataReset(home, consent);
  assert.throws(() => completePendingBotDataReset(home, { beforeErase: () => { throw new Error('OS refused'); } }), /OS refused/u);
  assert.equal(existsSync(join(home, 'bots/mochi/profile.json')), true);
  assert.equal(existsSync(join(home, DATA_RESET_JOURNAL)), true);
});

test('reset handler authenticates first, serializes requests and never restarts before a successful drain and durable consent', async () => {
  const calls: string[] = [];
  let release!: () => void;
  let busy = false;
  const handler = createDataResetHandler({ owns: (event: string) => event === 'hub-main', busy: () => busy,
    drain: () => new Promise<void>(done => { calls.push('drain'); release = done; }),
    prepare: () => { calls.push('prepare'); }, restart: () => { calls.push('restart'); }, recover: () => { calls.push('recover'); } });
  for (const sender of ['bot-settings', 'note', 'subframe']) await assert.rejects(handler(sender, consent), /only/u);
  await assert.rejects(handler('hub-main', {}), /RESET/u);
  busy = true; await assert.rejects(handler('hub-main', consent), /Finish/u); busy = false;
  assert.deepEqual(calls, []);
  const resetting = handler('hub-main', consent);
  await assert.rejects(handler('hub-main', consent), /Finish/u);
  release(); await resetting;
  assert.deepEqual(calls, ['drain', 'prepare', 'restart']);
});

test('drain or consent failure recovers the current hub without deleting or relaunching', async () => {
  for (const phase of ['drain', 'prepare']) {
    const calls: string[] = [];
    const handler = createDataResetHandler({ owns: () => true, busy: () => false,
      drain: async () => { if (phase === 'drain') throw new Error('stop failed'); },
      prepare: () => { throw new Error('write failed'); }, restart: () => { calls.push('restart'); }, recover: () => { calls.push('recover'); } });
    await assert.rejects(handler(null, consent), /failed/u);
    assert.deepEqual(calls, ['recover']);
  }
});
