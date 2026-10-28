import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import type { BotInteraction, InteractionAnswer } from '../../src/core/types.ts';
import { makeTempHome, openTestBot, waitForEvent } from '../support/harness.ts';
import { defaultWorld, fakeHelper } from '../support/desktopControl.ts';

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for desktop consent');
    await delay(20);
  }
}

test('packed Codex desktop tools wait for tool consent and a separate app grant', { timeout: 120_000 }, async () => {
  const home = makeTempHome('cats-codex-desktop-');
  const helper = fakeHelper(defaultWorld());
  const { core } = openTestBot({ botsHome: home.botsHome, profile: { provider: 'codex' }, core: {
    tools: false,
    desktopControl: { platform: 'win32', helperPath: 'fixture.exe', spawn: helper.spawn, grantWaitMs: 10_000 },
    runtime: { runtimeEntry: resolveRuntimeEntry(), providerCommand: process.execPath,
      providerLaunchArgs: [resolve('tests/support/fixture-cli/codex-fixture.mjs')], readyTimeoutMs: 60_000,
      env: { ...process.env, HOME: home.botsHome, USERPROFILE: home.botsHome, CODEX_HOME: join(home.botsHome, 'codex'),
        APPDATA: join(home.botsHome, 'roaming'), LOCALAPPDATA: join(home.botsHome, 'local'),
        XDG_CONFIG_HOME: join(home.botsHome, '.config'), XDG_DATA_HOME: join(home.botsHome, '.local', 'share') } },
  } });
  const pending = async () => {
    let interaction: BotInteraction | undefined;
    await waitUntil(async () => {
      interaction = (await core.providerInteractions('home')).interactions.find(i => i.status === 'pending');
      return !!interaction;
    }, 60_000);
    assert.equal(interaction!.kind, 'tool_approval');
    assert.equal(interaction!.prompt?.server, 'cats-desktop');
    return interaction!;
  };
  const answer = (i: BotInteraction, value: InteractionAnswer) => core.respondProviderInteraction('home', i.interactionId, {
    workItemId: i.workItemId, workerGeneration: i.workerGeneration, executionId: i.executionId,
    expectedRevision: i.revision, idempotencyKey: `answer-${i.interactionId}`, answer: value,
  });
  try {
    await core.updateProfile({ permissions: { allowedTools: [] }, desktopControl: { enabled: true }, providerPolicy: {
      version: 1, mode: 'explicit', access: 'workspace-write', network: false, approval: 'on-request',
    } });
    await core.start();
    await core.setConversationDesktopControl('home', true);
    for (const action of ['decline', 'cancel'] as const) {
      const done = waitForEvent(core, e => e.type === 'turn.completed', 60_000);
      await core.sendOwnerMessage('home', 'provider-desktop');
      const i = await pending();
      assert.equal(helper.calls.includes('resolve_apps'), false, 'no app request before tool consent');
      assert.equal((await core.desktopControlState('home')).conversation!.pendingRequests.length, 0);
      await answer(i, { action });
      const result = await done;
      assert.ok(result.type === 'turn.completed');
      assert.equal(result.workItem.result?.text, 'desktop tool declined');
      assert.equal(helper.calls.includes('resolve_apps'), false, 'decline/cancel never invokes the tool');
    }
    const done = waitForEvent(core, e => e.type === 'turn.completed', 60_000);
    const item = await core.sendOwnerMessage('home', 'provider-desktop');
    const first = await pending();
    assert.equal(first.workItemId, item.id);
    await answer(first, { action: 'accept', choice: 'accept' });
    await waitUntil(async () => (await core.desktopControlState('home')).conversation!.pendingRequests.length === 1, 10_000);
    const state = await core.desktopControlState('home');
    assert.equal(state.conversation!.grants.length, 0, 'tool approval does not grant an app');
    assert.equal(helper.calls.includes('read_ui'), false);
    await core.respondDesktopGrant('home', state.conversation!.pendingRequests[0]!.requestId, 'allow');
    const list = await pending();
    assert.equal(list.workItemId, item.id);
    await answer(list, { action: 'accept', choice: 'accept' });
    const read = await pending();
    assert.match(read.prompt!.message!, /read_ui/);
    assert.equal(helper.calls.includes('read_ui'), false, 'even a read waits for its own consent');
    await answer(read, { action: 'accept', choice: 'accept' });
    const result = await done;
    assert.ok(result.type === 'turn.completed');
    assert.equal(result.workItem.state, 'completed', result.workItem.error);
    assert.equal(result.workItem.result?.text, 'desktop fixture read completed');
    assert.equal(helper.calls.filter(op => op === 'read_ui').length, 1);
    assert.equal((await core.sessionCapabilities('home')).desktopControl?.status, 'injected');
    const receipts = (await core.providerInteractions('home')).interactions;
    assert.ok(receipts.every(i => !i.prompt), 'terminal receipts contain no input');
  } finally { await core.stop(); home.cleanup(); }
});
