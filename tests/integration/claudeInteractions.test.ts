import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { callHostControl } from '../../src/core/host-api/control.ts';
import type { BotCore } from '../../src/core/bot.ts';
import { makeTempHome, openTestBot, waitForEvent } from '../support/harness.ts';

async function answer(core: BotCore, root: string, message: string, kind: string, key: string,
  reply: { choice?: string; values?: Record<string, string> }) {
  const pending = waitForEvent(core, e => e.type === 'provider.interactions' && e.pending === 1, 60_000);
  const done = waitForEvent(core, e => e.type === 'turn.completed', 60_000);
  await core.sendOwnerMessage('home', message);
  await pending;
  const interaction = (await core.providerInteractions('home')).interactions.find(i => i.status === 'pending')!;
  assert.equal(interaction.kind, kind);
  await callHostControl(root, { operation: 'respond', conversationId: 'home', interactionId: interaction.interactionId,
    response: { workItemId: interaction.workItemId, workerGeneration: interaction.workerGeneration, executionId: interaction.executionId,
      expectedRevision: interaction.revision, idempotencyKey: key, answer: { action: 'accept', ...reply } } });
  const result = await done;
  assert.ok(result.type === 'turn.completed');
  assert.equal(result.workItem.state, 'completed', result.workItem.error);
  return { interaction, text: result.workItem.result?.text };
}

test('packed Runtime hosts Claude Code questions, Chrome tool approval and forms in the headless Bot', { timeout: 120_000 }, async () => {
  const home = makeTempHome('cats-claude-controls-');
  const { core, root } = openTestBot({ botsHome: home.botsHome, profile: { provider: 'claude' }, core: {
    tools: false,
    runtime: { runtimeEntry: resolveRuntimeEntry(), providerCommand: process.execPath,
      providerLaunchArgs: [resolve('tests/support/fixture-cli/claude-fixture.mjs')], readyTimeoutMs: 60_000,
      env: { ...process.env, HOME: home.botsHome, USERPROFILE: home.botsHome,
        APPDATA: join(home.botsHome, 'roaming'), LOCALAPPDATA: join(home.botsHome, 'local'),
        XDG_CONFIG_HOME: join(home.botsHome, '.config'), XDG_DATA_HOME: join(home.botsHome, '.local', 'share') } },
  } });
  try {
    await core.updateProfile({ executionTarget: { provider: 'claude', model: null, claudeInChrome: true }, providerPolicy: {
      version: 1, mode: 'explicit', access: 'full-access', network: true, approval: 'on-request',
    } });
    await core.start();
    assert.equal(core.runtimeState(), 'ready');
    await assert.rejects(core.updateProfile({ providerPolicy: {
      version: 1, mode: 'explicit', access: 'workspace-write', network: false, approval: 'on-request',
    } }), /cannot enforce/);
    const kept = (await core.getProfile()).providerPolicy;
    assert.equal(kept?.mode === 'explicit' ? kept.access : null, 'full-access');

    const question = await answer(core, root, 'native-question', 'user_input', 'claude-question', { values: { q0: 'Blue' } });
    assert.equal(question.text, 'answered Blue');
    const chrome = await answer(core, root, 'native-chrome', 'tool_approval', 'claude-chrome', { choice: 'accept' });
    assert.equal(chrome.interaction.prompt?.server, 'claude-in-chrome');
    assert.equal(chrome.text, 'navigate allowed');
    const form = await answer(core, root, 'native-form', 'mcp_form', 'claude-form', { values: { choice: 'b' } });
    assert.equal(form.text, 'form accept b');

    const caps = await core.sessionCapabilities('home', true);
    assert.equal(caps.observation?.policy.status, 'verified');
    assert.equal(caps.observation?.policy.observed?.approval, 'default');
    assert.deepEqual(caps.observation?.inventory.servers.map(server => server.name), ['claude-in-chrome']);
    assert.equal(caps.observation?.inventory.builtins, 'observed');
    assert.equal(caps.observation?.dependencies.find(d => d.kind === 'browser')?.status, 'unknown');
    assert.equal(caps.observation?.dependencies.find(d => d.kind === 'computer_use')?.status, 'unavailable');
  } finally { await core.stop(); home.cleanup(); }
});
