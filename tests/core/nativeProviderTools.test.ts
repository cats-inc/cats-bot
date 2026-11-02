import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderProvidersConfig } from '../../src/core/runtime/providersConfig.ts';
import { assertHostedProviderPolicy } from '../../src/core/runtime/providerPolicy.ts';
import { providerCanOfferSessionTools } from '../../src/shared/providerTools.ts';
import { fetchFakeState, makeTempHome, openTestBot, sendAndWait, waitForEvent } from '../support/harness.ts';

const policy = { version: 1, mode: 'provider', constraints: { maxAccess: 'full-access', network: true } } as const;
test('hosted targets enable session tools without changing legacy defaults', () => {
  for (const provider of ['muse', 'grok', 'antigravity']) {
    assert.equal(providerCanOfferSessionTools(provider, null), false);
    assert.equal(providerCanOfferSessionTools(provider, policy), provider !== 'antigravity');
    assert.doesNotThrow(() => assertHostedProviderPolicy(provider, policy));
    assert.throws(() => assertHostedProviderPolicy(provider, { ...policy, constraints: { maxAccess: 'workspace-write', network: true } }), /full machine/u);
    assert.throws(() => assertHostedProviderPolicy(provider, { version: 1, mode: 'explicit', access: 'full-access', network: true, approval: 'never' }), /provider configuration/u);
    assert.doesNotMatch(renderProvidersConfig({ provider }), /protocol:/u);
    assert.match(renderProvidersConfig({ provider, protocol: 'hosted' }), /protocol: "hosted"/u);
  }
  assert.equal(providerCanOfferSessionTools('codex', null), true);
  assert.match(renderProvidersConfig({ provider: 'antigravity', protocol: 'hosted' }), /agy_acp_server/u);
  assert.match(renderProvidersConfig({ provider: 'antigravity' }), /command: "agy"/u);
});

test('policy-only transport switches wait for the active turn, replace Runtime, and preserve history', async () => {
  const home = makeTempHome('cats-native-policy-');
  const { core, root } = openTestBot({ botsHome: home.botsHome, profile: { provider: 'muse' },
    runtimeEnv: { FAKE_PROVIDER_INTERACTIONS: '1', FAKE_HOSTED_INTERACTIONS_ONLY: '1' } });
  try {
    await core.start();
    await sendAndWait(core, 'home', 'remember the teapot');
    const oldPid = core.status().runtime.pid;
    const running = waitForEvent(core, event => event.type === 'work.updated' && event.workItem.state === 'running' && !!event.workItem.run);
    const item = await core.sendOwnerMessage('home', 'slow:800'); await running;
    const done = waitForEvent(core, event => event.type === 'turn.completed' && event.workItem.id === item.id);
    await core.updateProfile({ providerPolicy: policy });
    assert.equal(core.status().runtime.pid, oldPid);
    const waiting = sendAndWait(core, 'home', 'after tools enabled');
    const queued = sendAndWait(core, 'home', 'second queued message');
    const completed = await done;
    assert.equal(completed.type === 'turn.completed' && completed.workItem.state, 'completed');
    assert.equal((await waiting).state, 'completed');
    assert.equal((await queued).state, 'completed');
    const state = await fetchFakeState(core);
    const instructions = String(state.sessions[0]?.instructions);
    assert.match(instructions, /remember the teapot/u);
    assert.match(instructions, /done after 800ms/u);
    assert.doesNotMatch(instructions, /after tools enabled|second queued message/u);
    for (const message of ['after tools enabled', 'second queued message']) {
      assert.equal(state.calls.filter(call => call.op === 'message' && call.message === message).length, 1);
    }
    assert.notEqual(core.status().runtime.pid, oldPid);
    assert.match(readFileSync(join(root, 'runtime', 'config', 'providers.yaml'), 'utf8'), /protocol: "hosted"/u);
    assert.ok(JSON.stringify(core.transcript('home')).includes('remember the teapot'));
    const hostedPid = core.status().runtime.pid;
    await core.updateProfile({ providerPolicy: null });
    assert.equal((await sendAndWait(core, 'home', 'after tools disabled')).state, 'completed');
    assert.notEqual(core.status().runtime.pid, hostedPid);
    assert.doesNotMatch(readFileSync(join(root, 'runtime', 'config', 'providers.yaml'), 'utf8'), /protocol:/u);
  } finally { await core.stop(); home.cleanup(); }
});


test('Boss Cat tool status requires authenticated discovery and expires when the execution changes', async () => {
  const home = makeTempHome('cats-native-tools-status-');
  const { core } = openTestBot({ botsHome: home.botsHome, profile: { provider: 'muse' },
    runtimeEnv: { FAKE_PROVIDER_INTERACTIONS: '1', FAKE_HOSTED_INTERACTIONS_ONLY: '1' } });
  try {
    await core.start(); await core.updateProfile({ providerPolicy: policy }); core.setBossCat(true);
    await sendAndWait(core, 'home', 'start hosted session');
    assert.equal(core.status().bossCat.tools, false);
    const server = (core as unknown as { hubTools: import('../../src/core/tools/server.ts').BotToolServer }).hubTools;
    const [descriptor] = server.descriptorFor('home');
    const list = async (token: string, url = descriptor!.url) => fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal((await list('incorrect')).status, 401);
    assert.equal(core.status().bossCat.tools, false);
    assert.equal((await list(server.token)).status, 200);
    assert.equal(core.status().bossCat.tools, true);
    core.setBossCat(false); assert.equal(core.status().bossCat.tools, false);
    core.setBossCat(true); assert.equal(core.status().bossCat.tools, true);
    const admitted = waitForEvent(core, event => event.type === 'work.updated' && event.workItem.state === 'running' && !!event.workItem.run);
    const slow = await core.sendOwnerMessage('home', 'slow:400'); await admitted;
    const completed = waitForEvent(core, event => event.type === 'turn.completed' && event.workItem.id === slow.id);
    await core.updateProfile({ instructions: 'New instructions after this turn' });
    assert.equal(core.status().queue.running?.id, slow.id);
    assert.equal((await list(server.token)).status, 200, 'the admitted turn retains its tools until the next bind');
    assert.equal(core.status().bossCat.tools, false, 'stale availability is not attributed to the new settings');
    await completed;
    await sendAndWait(core, 'home', 'after instruction change');
    assert.equal(core.status().bossCat.tools, false);
    assert.equal((await list(server.token, server.descriptorFor('home')[0]!.url)).status, 200);
    const oldSession = (await core.listConversations())[0]!.attachment.sessionId;
    assert.equal((await sendAndWait(core, 'home', 'exit-once: rebuild')).state, 'completed');
    assert.notEqual((await core.listConversations())[0]!.attachment.sessionId, oldSession);
    assert.equal(core.status().bossCat.tools, false);
    assert.equal((await list(server.token)).status, 401, 'an old descriptor cannot mark the new execution connected');
    assert.equal(core.status().bossCat.tools, false);
    assert.equal((await list(server.token, server.descriptorFor('home')[0]!.url)).status, 200);
    assert.equal(core.status().bossCat.tools, true);
    await core.updateProfile({ providerPolicy: null });
    assert.equal(core.status().bossCat.tools, false);
  } finally { await core.stop(); home.cleanup(); }
});
