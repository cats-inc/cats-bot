import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { initializeBot } from '../../src/core/bot.ts';
import { recentEntries, recentWorkItems } from '../../src/core/host-api/commands.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import type { TranscriptEntry, WorkItem } from '../../src/core/types.ts';
import { attachOrStartCore, coreEnvironment, killTree, type CoreLaunch, type HostedCore } from '../../src/shell/electron/coreHost.ts';
import { processIsAlive } from '../../src/shell/electron/update/installation.ts';
import { fakeRuntimeEntry, makeTempHome, type TempHome } from '../support/harness.ts';

/**
 * The review of PR #65: the shell's core host when a core starts slowly, stops while
 * starting, holds its lock without a channel, or stops answering. Cores run the fake
 * runtime in a temporary home.
 */

const host = { pid: process.pid, executable: process.execPath, installationId: 'test-installation' };
let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-core-process-');
});
after(() => home.cleanup());

function launchFor(id: string, env: NodeJS.ProcessEnv = {}): CoreLaunch {
  return {
    execPath: process.execPath, runAsNode: false, entry: resolve('src/cli/main.ts'),
    catsBotHome: home.root, botId: id, manager: 'test-installation', runtimeEntry: fakeRuntimeEntry,
    env: {
      ...process.env,
      HOME: home.root, USERPROFILE: home.root,
      APPDATA: join(home.root, 'AppData', 'Roaming'), LOCALAPPDATA: join(home.root, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(home.root, '.config'), XDG_DATA_HOME: join(home.root, '.local', 'share'),
      ...env,
    },
  };
}

async function settle(hosted: HostedCore | null): Promise<void> {
  if (!hosted) return;
  hosted.client.close();
  if (processIsAlive(hosted.pid)) killTree(hosted.pid);
}

test('the core gets its home and bot from its host, never from the host\'s own variables', () => {
  const env = coreEnvironment({
    ...launchFor('mochi'), runAsNode: true,
    env: { PATH: 'p', CATS_BOT_ID: 'other', CATS_BOT_HOME: 'elsewhere', CATS_RUNTIME_API_KEY: 'k', cats_runtime_dir: 'd', ELECTRON_RUN_AS_NODE: '0' },
  });
  assert.deepEqual(env, { PATH: 'p', CATS_BOT_HOME: home.root, ELECTRON_RUN_AS_NODE: '1' });
});

test('snapshots for a host keep the newest history within their budget', () => {
  const entries = Array.from({ length: 50 }, (_, seq) => ({ seq, at: '', kind: 'bot', origin: 'owner', text: 'x'.repeat(1000) }) as TranscriptEntry);
  const kept = recentEntries(entries, 10_500);
  assert.deepEqual(kept.map((entry) => entry.seq), [41, 42, 43, 44, 45, 46, 47, 48, 49]);
  const items = Array.from({ length: 30 }, (_, n) => ({ id: `w${n}`, state: n === 3 ? 'awaiting_owner' : 'completed', prompt: 'y'.repeat(1000) }) as WorkItem);
  assert.deepEqual(recentWorkItems(items, 3_500).map((item) => item.id), ['w3', 'w27', 'w28', 'w29'], 'unfinished items always stay');
});

test('a turn sent while the Runtime still starts runs once it is ready, not 30 seconds later', { timeout: 60_000 }, async () => {
  const { root } = initializeBot(home.botsHome, { id: 'ready', name: 'Ready', provider: 'claude' });
  let hosted: HostedCore | null = null;
  try {
    hosted = await attachOrStartCore(root, {
      ...launchFor('ready', { CATS_BOT_TEST_RUNTIME_DELAY_MS: '3000' }), runtimeEntry: resolve('tests/support/slow-runtime.mjs'),
    }, { host });
    const core = hosted.core;
    const completed = new Promise<WorkItem>((resolveTurn) => core.subscribe((event) => {
      if (event.type === 'turn.completed') resolveTurn(event.workItem);
    }));
    assert.notEqual((await core.status()).runtime.state, 'ready');
    const sent = Date.now();
    await core.sendOwnerMessage('home', 'hello before ready');
    const item = await completed;
    assert.equal(item.state, 'completed');
    assert.ok(Date.now() - sent < 20_000, `the turn waited ${Date.now() - sent} ms`);
    await hosted.stop(10_000);
  } finally {
    await settle(hosted);
  }
});

// The fixture Runtime ignores its stop until its delay is over, so the stop may take that long;
// what counts is that the core quits from inside start() and nothing is left (review of #66).
test('a stop during start ends the core and its Runtime, with nothing left running', { timeout: 60_000 }, async () => {
  const { root } = initializeBot(home.botsHome, { id: 'early', name: 'Early', provider: 'claude' });
  let hosted: HostedCore | null = null;
  try {
    hosted = await attachOrStartCore(root, {
      ...launchFor('early', { CATS_BOT_TEST_RUNTIME_DELAY_MS: '4000' }), runtimeEntry: resolve('tests/support/slow-runtime.mjs'),
    }, { host });
    const runtimePid = (await hosted.core.status()).runtime.pid;
    const started = Date.now();
    await hosted.stop(10_000);
    assert.ok(Date.now() - started < 9_000, `the stop took ${Date.now() - started} ms`);
    assert.equal(processIsAlive(hosted.pid), false);
    if (runtimePid) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      assert.equal(processIsAlive(runtimePid), false, 'the Runtime ended with it');
    }
  } finally {
    await settle(hosted);
  }
});

test('a lock that is released while the host waits lets the core start at once', { timeout: 60_000 }, async () => {
  const { root } = initializeBot(home.botsHome, { id: 'locked', name: 'Locked', provider: 'claude' });
  // A process holds the bot's lock for 1.5 seconds without a channel, then exits.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' });
  writeFileSync(botPathsFor(root).lock, JSON.stringify({ pid: holder.pid, host: hostname(), startedAt: new Date().toISOString() }));
  let hosted: HostedCore | null = null;
  try {
    const started = Date.now();
    hosted = await attachOrStartCore(root, launchFor('locked'), { host, lockWaitMs: 30_000 });
    assert.equal(hosted.started, true);
    assert.ok(Date.now() - started < 15_000, `it waited ${Date.now() - started} ms`);
    await hosted.stop(10_000);
  } finally {
    await settle(hosted);
    if (holder.pid && processIsAlive(holder.pid)) holder.kill();
  }
});

test('a core that answers nothing is killed once the stop deadline passes', { timeout: 60_000 }, async () => {
  const { root } = initializeBot(home.botsHome, { id: 'wedged', name: 'Wedged', provider: 'claude' });
  const wedged = spawn(process.execPath, [resolve('tests/support/wedged-core.mjs'), root, 'test-installation'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolveReady) => wedged.stdout!.once('data', () => resolveReady()));
  let hosted: HostedCore | null = null;
  try {
    hosted = await attachOrStartCore(root, launchFor('wedged'), { host });
    assert.equal(hosted.started, false);
    const started = Date.now();
    await hosted.stop(2_000);
    assert.ok(Date.now() - started < 10_000, `the stop took ${Date.now() - started} ms`);
    assert.equal(processIsAlive(wedged.pid!), false);
  } finally {
    await settle(hosted);
    if (wedged.pid && processIsAlive(wedged.pid)) wedged.kill();
  }
});

test('review of #66: snapshots are bounded where the core answers, the newest item always stays', async () => {
  const { runCoreCommand } = await import('../../src/core/host-api/commands.ts');
  const huge = Array.from({ length: 3_000 }, (_, seq) => ({ seq, at: '', kind: 'bot', origin: 'owner', text: 'x'.repeat(2_000) }) as TranscriptEntry);
  const target = { conversationTranscript: () => huge, transcript: () => huge, listWorkItems: () => [] } as unknown as Parameters<typeof runCoreCommand>[0];
  const answer = await runCoreCommand(target, 'conversationTranscript', ['home']) as TranscriptEntry[];
  assert.ok(answer.length < huge.length && answer.length > 0);
  assert.equal(answer.at(-1)!.seq, 2_999);
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= 4 * 1024 * 1024 + 4_096);
  const giant = [{ seq: 1, at: '', kind: 'bot', origin: 'owner', text: 'y'.repeat(5 * 1024 * 1024) }] as TranscriptEntry[];
  assert.equal(recentEntries(giant).length, 1, 'an entry over the budget alone still shows');
});

test('review of #66: a lock held without a channel past the wait is a busy bot, not another host\'s core', async () => {
  const { CoreBusyError } = await import('../../src/shell/electron/coreHost.ts');
  const { root } = initializeBot(home.botsHome, { id: 'busy', name: 'Busy', provider: 'claude' });
  // A live process holds the lock; its descriptor names this host but its channel is gone.
  writeFileSync(botPathsFor(root).lock, JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: new Date().toISOString() }));
  writeFileSync(join(root, 'host-channel.json'), JSON.stringify({
    protocol: 1, socket: process.platform === 'win32' ? `\\\\.\\pipe\\cats-bot-gone-${process.pid}` : join(root, 'gone.sock'),
    token: 'c'.repeat(64), pid: process.ppid, manager: 'test-installation', startedAt: '',
  }));
  await assert.rejects(attachOrStartCore(root, launchFor('busy'), { host, lockWaitMs: 1_000 }), CoreBusyError);
});
