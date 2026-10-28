import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { BotInteractions } from '../../src/core/host-api/providerInteractions.ts';
import { callHostControl } from '../../src/core/host-api/control.ts';
import type { BotInteraction, BotInteractionResponse } from '../../src/core/types.ts';
import type { WorkItem } from '../../src/core/types.ts';
import type { RuntimeClient } from '../../src/core/runtime/client.ts';
import { fetchFakeState, makeTempHome, openTestBot, waitForEvent } from '../support/harness.ts';

function answer(i: BotInteraction): BotInteractionResponse {
  return { workerGeneration: i.workerGeneration, executionId: i.executionId, workItemId: i.workItemId,
    expectedRevision: i.revision, idempotencyKey: 'owner-answer-1', answer: { action: 'accept', values: { answer: 'private-test-answer' } } };
}

test('headless CLI answers outside the occupied gate, keeps notes isolated and persists only receipts', async () => {
  const home = makeTempHome('cats-provider-controls-');
  const { core, root } = openTestBot({ botsHome: home.botsHome, runtimeEnv: { FAKE_PROVIDER_INTERACTIONS: '1' } });
  try {
    await core.start();
    const other = await core.createConversation('Other');
    const waiting = waitForEvent(core, e => e.type === 'provider.interactions' && e.pending === 1);
    const item = await core.sendOwnerMessage('home', 'provider-question');
    await waiting;
    const i = (await core.providerInteractions('home')).interactions[0]!;
    assert.equal(i.workItemId, item.id);
    assert.equal(i.prompt?.fields?.[0]?.secret, true);
    const queued = await core.sendOwnerMessage(other.id, 'after response');
    await core.tick();
    assert.equal(core.getWorkItem(queued.id)?.state, 'queued', 'human wait keeps the global gate');
    assert.equal(core.status().queue.running?.id, item.id);
    await assert.rejects(core.respondProviderInteraction(other.id, i.interactionId, answer(i)));
    await assert.rejects(core.respondProviderInteraction('home', i.interactionId, { ...answer(i), workerGeneration: 'old' }));
    const done = waitForEvent(core, e => e.type === 'turn.completed' && e.workItem.id === item.id);
    const exit = await new Promise<{ code: number | null; out: string; error: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve('src/cli/main.ts'), 'respond', 'home', i.interactionId, '--id', 'testbot'], {
        env: { ...process.env, CATS_BOTS_HOME: home.botsHome }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      let out = ''; let error = '';
      child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { error += c; });
      child.on('error', reject); child.on('exit', code => resolveResult({ code, out, error }));
      child.stdin.end(JSON.stringify(answer(i)));
    });
    assert.equal(exit.code, 0, exit.error);
    assert.deepEqual(JSON.parse(exit.out), { accepted: true });
    await done;
    assert.equal(core.getWorkItem(item.id)?.state, 'completed');
    assert.equal((await fetchFakeState(core)).calls.filter(c => c.op === 'provider_response').length, 1);
    for (const file of ['journal.jsonl', 'provider-interactions.json', 'provider-interactions.json.bak']) {
      const bytes = readFileSync(join(root, file), 'utf8');
      assert.ok(!bytes.includes('private-test-answer'));
      assert.ok(!bytes.includes('Fixture question'));
    }
    assert.ok(!JSON.stringify(core.transcript('home')).includes('private-test-answer'));
    await assert.rejects(core.respondProviderInteraction('home', i.interactionId, answer(i)), 'old answer cannot reach the next work item');
  } finally { await core.stop(); home.cleanup(); }
});

test('retarget waits, view closure does not cancel, restart receipts cannot revive a callback', async () => {
  const home = makeTempHome('cats-provider-restart-');
  const { core, root } = openTestBot({ botsHome: home.botsHome, runtimeEnv: { FAKE_PROVIDER_INTERACTIONS: '1' } });
  try {
    await core.start();
    const waiting = waitForEvent(core, e => e.type === 'provider.interactions' && e.pending === 1);
    const item = await core.sendOwnerMessage('home', 'provider-question');
    await waiting;
    const i = (await core.providerInteractions('home')).interactions[0]!;
    await core.closeView('home');
    await core.updateProfile({ executionTarget: { provider: 'codex', model: null } });
    await core.tick();
    assert.equal(core.status().queue.running?.id, item.id);
    assert.equal(core.runtimeState(), 'ready');
    const reconstructed = new BotInteractions(root, 'testbot', () => {});
    const snapshot = await reconstructed.snapshot(i.conversationId);
    assert.equal(snapshot.interactions[0]?.status, 'interrupted');
    assert.equal(snapshot.interactions[0]?.prompt, undefined);
    await assert.rejects(reconstructed.respond(i.conversationId, i.interactionId, answer(i)));
    const cancelled = waitForEvent(core, e => e.type === 'turn.completed' && e.workItem.id === item.id);
    await core.cancelTurn('home'); await cancelled;
    await assert.rejects(callHostControl(root, { operation: 'respond', conversationId: 'home', interactionId: i.interactionId, response: answer(i) }));
  } finally { await core.stop(); home.cleanup(); }
});

test('snapshot notices during fetch and at promise cleanup trigger another authoritative read', async () => {
  for (const timing of ['during', 'cleanup']) {
    const home = makeTempHome('cats-provider-race-');
    try {
      const first = { interactionId: 'one', sessionId: 'session', workerGeneration: 'generation', executionId: 'execution', revision: 1,
        kind: 'user_input', status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } as BotInteraction;
      const second = { ...first, interactionId: 'two', revision: 2 };
      const item = { id: 'work', conversationId: 'conversation', run: { sessionId: 'session' } } as WorkItem;
      let calls = 0;
      let release!: () => void;
      const blocked = new Promise<void>(resolveWait => { release = resolveWait; });
      const notice = (i: BotInteraction) => ledger.notice(item, { type: 'progress', metadata: { interaction: i } });
      const ledger = new BotInteractions(home.botsHome, 'bot', () => {
        if (timing === 'cleanup' && calls === 1) queueMicrotask(() => queueMicrotask(() => notice(second)));
      });
      ledger.track(item, { interactions: async () => {
        calls += 1;
        if (calls === 1 && timing === 'during') await blocked;
        return { version: 1, sessionId: 'session', workerGeneration: 'generation', revision: calls,
          interactions: calls === 1 ? [first] : [first, second] };
      } } as unknown as RuntimeClient);
      notice(first);
      if (timing === 'during') { notice(second); release(); }
      await ledger.snapshot('conversation');
      await new Promise<void>(resolveWait => setImmediate(resolveWait));
      assert.deepEqual((await ledger.snapshot('conversation')).interactions.map(i => i.interactionId), ['one', 'two']);
      assert.ok(calls >= 2);
    } finally { home.cleanup(); }
  }
});

test('future receipt backup is preserved even when the primary is valid', () => {
  const home = makeTempHome('cats-receipt-version-');
  try {
    const file = join(home.botsHome, 'provider-interactions.json');
    writeFileSync(file, JSON.stringify({ version: 1, receipts: [] }));
    const future = '{"version":99,"receipts":[],"future":"preserve"}';
    writeFileSync(`${file}.bak`, future);
    assert.throws(() => new BotInteractions(home.botsHome, 'bot', () => {}));
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), future);
  } finally { home.cleanup(); }
});

test('a tool_approval receipt (Claude Code tools, SPEC-006 desktop tools) reloads after a restart', async () => {
  const home = makeTempHome('cats-receipt-tool-approval-');
  try {
    const at = new Date().toISOString();
    const receipt = { botId: 'bot', conversationId: 'c', workItemId: 'w', interactionId: 'i', sessionId: 's',
      workerGeneration: 'g', executionId: 'e', revision: 1, createdAt: at, expiresAt: at, status: 'resolved', kind: 'tool_approval' };
    writeFileSync(join(home.botsHome, 'provider-interactions.json'), JSON.stringify({ version: 1, receipts: [receipt] }));
    const reloaded = new BotInteractions(home.botsHome, 'bot', () => {});
    assert.equal((await reloaded.snapshot('c')).interactions[0]?.kind, 'tool_approval');
  } finally { home.cleanup(); }
});

test('startup failure releases the new control endpoint and instance lock', async () => {
  const home = makeTempHome('cats-control-start-failure-');
  const { core, root } = openTestBot({ botsHome: home.botsHome });
  try {
    renameSync(join(root, 'conversations'), join(root, 'conversations-backup'));
    writeFileSync(join(root, 'conversations'), 'blocked directory');
    await assert.rejects(core.start());
    assert.equal(existsSync(join(root, 'host-control.json')), false);
    assert.equal(existsSync(join(root, 'instance.lock.json')), false);
  } finally { await core.stop(); home.cleanup(); }
});

test('receipt failure during shutdown cannot strand the control endpoint or lock', async () => {
  const home = makeTempHome('cats-control-stop-failure-');
  const { core, root } = openTestBot({ botsHome: home.botsHome, runtimeEnv: { FAKE_PROVIDER_INTERACTIONS: '1' } });
  try {
    await core.start();
    const pending = waitForEvent(core, e => e.type === 'provider.interactions' && e.pending === 1);
    await core.sendOwnerMessage('home', 'provider-question'); await pending;
    const store = (core as unknown as { interactions: BotInteractions }).interactions;
    store.end = () => { throw new Error('injected disk failure'); };
    await assert.rejects(core.stop());
    assert.equal(existsSync(join(root, 'host-control.json')), false);
    assert.equal(existsSync(join(root, 'instance.lock.json')), false);
  } finally { await core.stop(); home.cleanup(); }
});
