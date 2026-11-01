import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fetchFakeState, makeTempHome, openTestBot, sendAndWait, waitForEvent } from '../support/harness.ts';
import { RuntimeClient } from '../../src/core/runtime/client.ts';

const home = makeTempHome('cats-bot-busy-retry-');
after(() => home.cleanup());

test('a non-busy HTTP 409 fails once with its original reason', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'conflict', core: { turnRetry: { ownerBusyMs: 1 } } });
  await core.start();
  try {
    const result = await sendAndWait(core, 'home', 'selection-conflict', 1500);
    assert.equal(result.state, 'failed');
    assert.match(result.error!, /409.*provider_changed.*provider is no longer selected/u);
    assert.equal((await fetchFakeState(core)).calls.filter(c => c.op === 'message').length, 1);
  } finally { await core.stop(); }
});

test('a persistently busy session stops retrying without replacing it or losing the owner message', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'persistent', core: { turnRetry: { ownerBusyMs: 1, maxBusyAttempts: 3 } } });
  await core.start();
  try {
    const result = await sendAndWait(core, 'home', 'busy-always', 1500);
    assert.equal(result.state, 'failed');
    assert.equal(result.attempts, 3);
    assert.match(result.error!, /Automatic retries stopped/u);
    const calls = (await fetchFakeState(core)).calls;
    assert.equal(calls.filter(c => c.op === 'create').length, 1);
    assert.equal(calls.filter(c => c.op === 'message').length, 3);
    assert.equal(core.transcript('home').filter(e => e.kind === 'owner').length, 1);
    assert.equal(core.status().queue.queued, 0);
    assert.equal(core.listWorkItems().find(w => w.id === result.id)?.prompt, 'busy-always');
  } finally { await core.stop(); }
});

test('waiting work can be cancelled without cancelling a Runtime turn owned by another sender', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'cancel', core: { turnRetry: { ownerBusyMs: 100 } } });
  await core.start();
  try {
    const waiting = waitForEvent(core, e => e.type === 'work.updated' && e.workItem.state === 'queued' && e.workItem.error === 'session_busy');
    const item = await core.sendOwnerMessage('home', 'busy-always');
    await waiting;
    await core.cancelTurn('home');
    assert.equal(core.listWorkItems().find(w => w.id === item.id)?.state, 'cancelled');
    assert.equal(core.status().queue.queued, 0);
    const calls = (await fetchFakeState(core)).calls;
    assert.equal(calls.filter(c => c.op === 'message').length, 1);
    assert.equal(calls.filter(c => c.op === 'cancel').length, 0);
  } finally { await core.stop(); }
});

test('a successful busy retry clears the old error and leaves no permanent waiting notice', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'recovered', core: { turnRetry: { ownerBusyMs: 1 } } });
  await core.start();
  try {
    const result = await sendAndWait(core, 'home', 'busy-once');
    assert.equal(result.state, 'completed');
    assert.equal(result.error, undefined);
    assert.equal(core.transcript('home').some(e => e.text.startsWith('Waiting:')), false);
  } finally { await core.stop(); }
});

test('an admitted retry clears waiting before its response finishes streaming', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'admitted', core: { turnRetry: { ownerBusyMs: 1 } } });
  await core.start();
  try {
    const accepted = waitForEvent(core, e => e.type === 'work.updated' && e.workItem.attempts === 2 && e.workItem.state === 'running' && !e.workItem.error);
    const item = await core.sendOwnerMessage('home', 'busy-once-slow');
    await accepted;
    assert.equal(core.listWorkItems().find(w => w.id === item.id)?.error, undefined);
    assert.equal(core.listWorkItems().find(w => w.id === item.id)?.state, 'running');
    await core.cancelTurn('home');
  } finally { await core.stop(); }
});

test('cancel during retry preparation cannot cancel the other Runtime turn', async () => {
  let releaseHistory!: () => void;
  let enteredHistory!: () => void;
  const entered = new Promise<void>(resolve => { enteredHistory = resolve; });
  const held = new Promise<void>(resolve => { releaseHistory = resolve; });
  let messages = 0, cancels = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const client = new RuntimeClient({ baseUrl: 'http://fixture', apiKey: 'fixture', fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/providers/config') return json({ providers: {} });
    if (path === '/sessions' && init?.method === 'POST') return json({ id: 'fixture', status: 'ready' });
    if (path.endsWith('/messages')) { messages++; return json({ error: 'Session is busy processing another message' }, 409); }
    if (path.endsWith('/history')) { enteredHistory(); await held; return json({ messages: [] }); }
    if (path.endsWith('/cancel')) { cancels++; return json({}); }
    return json({ id: 'fixture', status: 'ready', interactions: [] });
  } });
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'preparing', core: { tools: false, runtimeClient: client, turnRetry: { ownerBusyMs: 1 } } });
  await core.start();
  try {
    const item = await core.sendOwnerMessage('home', 'owner');
    await entered;
    assert.equal(core.listWorkItems().find(w => w.id === item.id)?.attempts, 2);
    assert.equal(messages, 1);
    const done = waitForEvent(core, e => e.type === 'turn.completed' && e.workItem.id === item.id);
    await core.cancelTurn('home');
    assert.equal(cancels, 0);
    releaseHistory();
    await done;
    assert.equal(messages, 1);
    assert.equal(core.listWorkItems().find(w => w.id === item.id)?.state, 'cancelled');
  } finally { releaseHistory(); await core.stop(); }
});
