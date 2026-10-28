import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { callHostControl } from '../../src/core/host-api/control.ts';
import { makeTempHome, openTestBot, waitForEvent } from '../support/harness.ts';

test('packed Runtime maps Codex native input to the headless Bot and resumes the same turn', { timeout: 90_000 }, async () => {
  const home = makeTempHome('cats-native-controls-');
  const { core, root } = openTestBot({ botsHome: home.botsHome, profile: { provider: 'codex' }, core: {
    tools: false,
    runtime: { runtimeEntry: resolveRuntimeEntry(), providerCommand: process.execPath,
      providerLaunchArgs: [resolve('tests/support/fixture-cli/codex-fixture.mjs')], readyTimeoutMs: 60_000,
      env: { ...process.env, HOME: home.botsHome, USERPROFILE: home.botsHome, CODEX_HOME: join(home.botsHome, 'codex'),
        APPDATA: join(home.botsHome, 'roaming'), LOCALAPPDATA: join(home.botsHome, 'local'),
        XDG_CONFIG_HOME: join(home.botsHome, '.config'), XDG_DATA_HOME: join(home.botsHome, '.local', 'share') } },
  } });
  try {
    await core.updateProfile({ permissions: { allowedTools: [] }, providerPolicy: {
      version: 1, mode: 'explicit', access: 'workspace-write', network: false, approval: 'on-request',
    } });
    await core.start();
    assert.equal(core.runtimeState(), 'ready');
    const pending = waitForEvent(core, e => e.type === 'provider.interactions' && e.pending === 1, 60_000);
    const done = waitForEvent(core, e => e.type === 'turn.completed', 60_000);
    await core.sendOwnerMessage('home', 'provider-question');
    await pending;
    const interaction = (await core.providerInteractions('home')).interactions[0]!;
    assert.equal(interaction.kind, 'user_input');
    const caps = await core.sessionCapabilities('home', true);
    assert.equal(caps.observation?.policy.status, 'verified');
    assert.equal(caps.observation?.inventory.servers[0]?.name, 'fixture_tools');
    await callHostControl(root, { operation: 'respond', conversationId: 'home', interactionId: interaction.interactionId,
      response: { workItemId: interaction.workItemId, workerGeneration: interaction.workerGeneration, executionId: interaction.executionId,
        expectedRevision: interaction.revision, idempotencyKey: 'native-owner', answer: { action: 'accept', values: { answer: 'Continue' } } } });
    const result = await done;
    assert.ok(result.type === 'turn.completed');
    assert.equal(result.workItem.state, 'completed', result.workItem.error);
    assert.equal(result.workItem.result?.text, 'native response received');
  } finally { await core.stop(); home.cleanup(); }
});
