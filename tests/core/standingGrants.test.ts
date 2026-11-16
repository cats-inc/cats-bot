import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertChoicesOnly, BotInteractions } from '../../src/core/host-api/providerInteractions.ts';
import type { BotInteraction } from '../../src/core/types.ts';
import { fetchFakeState, makeTempHome, openTestBot, sendAndWait } from '../support/harness.ts';

// ADR-027: only messages the owner sends in person may use Runtime's standing grants (Runtime ADR-055).

test('only an owner-sent message marks its send; Telegram, recovery and decision follow-ups never do', async () => {
  const home = makeTempHome('cats-grants-send-');
  const { core } = openTestBot({ botsHome: home.botsHome });
  try {
    await core.start();
    const owner = await sendAndWait(core, 'home', 'hello from the note');
    assert.equal(owner.state, 'completed', owner.error);
    const telegram = await core.sendOwnerMessage('home', 'hello from telegram', 'telegram');
    for (let i = 0; i < 200 && core.getWorkItem(telegram.id)?.state !== 'completed'; i++) await new Promise((r) => setTimeout(r, 50));
    const messages = (await fetchFakeState(core)).calls.filter((call) => call.op === 'message');
    assert.equal(messages.find((call) => call.message === 'hello from the note')?.standingGrants, true);
    const fromTelegram = messages.find((call) => String(call.message).includes('hello from telegram'));
    assert.ok(fromTelegram, 'the Telegram turn reached the runtime');
    assert.equal(fromTelegram!.standingGrants, undefined);
    const recovery = await core.sendOwnerMessage('home', 'hello again after a crash', 'recovery');
    const decision = await core.sendOwnerMessage('home', 'Decision on your question "x": approved.', 'owner', 'decision:wi-1');
    for (const item of [recovery, decision]) {
      for (let i = 0; i < 200 && core.getWorkItem(item.id)?.state !== 'completed'; i++) await new Promise((r) => setTimeout(r, 50));
    }
    const later = (await fetchFakeState(core)).calls.filter((call) => call.op === 'message');
    for (const text of ['hello again after a crash', 'Decision on your question']) {
      const call = later.find((entry) => String(entry.message).includes(text));
      assert.ok(call, text);
      assert.equal(call!.standingGrants, undefined, text);
    }
  } finally { await core.stop(); home.cleanup(); }
});

test('Stop revokes the session grants and the note no longer shows them', async () => {
  const home = makeTempHome('cats-grants-stop-');
  const { core } = openTestBot({ botsHome: home.botsHome, runtimeEnv: { FAKE_PROVIDER_INTERACTIONS: '1' } });
  try {
    await core.start();
    const turn = await sendAndWait(core, 'home', 'warm up');
    assert.equal(turn.state, 'completed', turn.error);
    const conversation = (await core.listConversations()).find((record) => record.id === 'home')!;
    const sessionId = conversation.attachment.sessionId!;
    const supervisor = (core as unknown as { supervisor: { baseUrl: string; _apiKey: string } }).supervisor;
    const grant = { category: 'computer_use', until: 'session', grantedAt: '2026-11-16T00:00:00.000Z' };
    await fetch(`${supervisor.baseUrl}/sessions/${sessionId}/interactions/grants`, { method: 'POST',
      headers: { Authorization: `Bearer ${supervisor._apiKey}` }, body: JSON.stringify({ standingGrants: [grant] }) });
    const events: string[][] = [];
    const unsubscribe = core.subscribe((event) => { if (event.type === 'grants.changed') events.push(event.conversations); });
    assert.deepEqual((await core.providerInteractions('home')).standingGrants, [grant]);
    await core.stopStandingGrants('home');
    assert.equal((await core.providerInteractions('home')).standingGrants, undefined);
    assert.ok((await fetchFakeState(core)).calls.some((call) => call.op === 'revoke_grants' && call.id === sessionId));
    assert.deepEqual(events, [['home'], []]);
    unsubscribe();
  } finally { await core.stop(); home.cleanup(); }
});

test('a request Runtime answered from a grant never counts as waiting, and a contact note cannot grant', () => {
  const home = makeTempHome('cats-grants-unit-');
  try {
    const changed: string[][] = [];
    const interactions = new BotInteractions(home.root, 'bot', () => {}, (ids) => changed.push(ids));
    const base = { botId: 'bot', conversationId: 'home', workItemId: 'w', interactionId: 'i', sessionId: 's', workerGeneration: 'g',
      executionId: 'e', revision: 1, createdAt: '2026-11-16T00:00:00.000Z', expiresAt: '2026-11-16T00:00:00.000Z', kind: 'tool_approval' } as const;
    const entries = (interactions as unknown as { entries: Map<string, BotInteraction> }).entries;
    entries.set('i', { ...base, status: 'responding', reason: 'standing_grant', decision: 'accept' });
    assert.equal(interactions.pending('home'), 0);
    entries.set('j', { ...base, interactionId: 'j', status: 'pending' });
    assert.equal(interactions.pending('home'), 1);
    assert.equal(interactions.setGrants('home', [{ category: 'command', until: 'time', grantedAt: 'x', expiresAt: 'y' }, { category: 'bogus', until: 'session', grantedAt: 'x' }]), true);
    assert.deepEqual(interactions.grantedConversations(), ['home']);
    assert.equal(interactions.setGrants('home', [{ category: 'command', until: 'time', grantedAt: 'x', expiresAt: 'y' }]), false);
    assert.deepEqual(changed, [['home']]);
    const card = { ...base, status: 'pending' as const, prompt: { kind: 'tool_approval' as const, title: 'js', grantCategory: 'computer_use' as const,
      choices: [{ id: 'approve_once', label: 'Approve once' }] } };
    assert.throws(() => assertChoicesOnly(card, { action: 'accept', choice: 'approve_once', standingGrant: { until: 'session' } }), /contact note/u);
    assert.doesNotThrow(() => assertChoicesOnly(card, { action: 'accept', choice: 'approve_once' }));
  } finally { home.cleanup(); }
});

test('Stop fails loudly and keeps the grants in view when Runtime does not confirm (ADR-027 review)', async () => {
  const home = makeTempHome('cats-grants-stopfail-');
  const { core } = openTestBot({ botsHome: home.botsHome, runtimeEnv: { FAKE_PROVIDER_INTERACTIONS: '1', FAKE_REVOKE_FAILS: '1' } });
  try {
    await core.start();
    assert.equal((await sendAndWait(core, 'home', 'warm up')).state, 'completed');
    const sessionId = (await core.listConversations()).find((record) => record.id === 'home')!.attachment.sessionId!;
    const supervisor = (core as unknown as { supervisor: { baseUrl: string; _apiKey: string } }).supervisor;
    const grant = { category: 'command', until: 'session', grantedAt: '2026-11-16T00:00:00.000Z' };
    await fetch(`${supervisor.baseUrl}/sessions/${sessionId}/interactions/grants`, { method: 'POST',
      headers: { Authorization: `Bearer ${supervisor._apiKey}` }, body: JSON.stringify({ standingGrants: [grant] }) });
    assert.deepEqual((await core.providerInteractions('home')).standingGrants, [grant]);
    await assert.rejects(core.stopStandingGrants(), /did not confirm/u);
    assert.deepEqual(await core.standingGrantConversations(), ['home']);
  } finally { await core.stop(); home.cleanup(); }
});

test('a timed grant leaves the bot when it expires, with no note open (ADR-027 review)', async () => {
  const home = makeTempHome('cats-grants-expiry-');
  try {
    const changed: string[][] = [];
    const interactions = new BotInteractions(home.root, 'bot', () => {}, (ids) => changed.push(ids));
    interactions.setGrants('home', [{ category: 'file', until: 'time', grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 80).toISOString() }]);
    assert.deepEqual(interactions.grantedConversations(), ['home']);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(interactions.grantedConversations(), []);
    assert.deepEqual(changed, [['home'], []]);
  } finally { home.cleanup(); }
});
