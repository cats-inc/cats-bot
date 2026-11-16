import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { SessionBinder } from '../../src/core/conversations/binder.ts';
import { ConversationStore } from '../../src/core/conversations/store.ts';
import { createProfile } from '../../src/core/profile/profile.ts';
import { TurnRunner } from '../../src/core/queue/turnRunner.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';
import { RuntimeHttpError, type RuntimeClient, type RuntimeSessionView } from '../../src/core/runtime/client.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import type { WorkItem } from '../../src/core/types.ts';
import { makeTempHome } from '../support/harness.ts';

/**
 * SPEC-001 FR-11 (2026-11-17), through the turn runner: an owner's message replaces a session that never started at
 * most once, background work never does, and a failed replacement leaves the next message free to try again.
 */
function setup(t: { after(fn: () => void): void }, sendError: RuntimeHttpError | null, kind: WorkItem['kind'] = 'owner_message') {
  const home = makeTempHome('cats-bot-owner-replacement-');
  t.after(() => home.cleanup());
  const paths = botPathsFor(join(home.botsHome, 'fixture'));
  const now = () => new Date('2026-11-17T00:00:00Z');
  const store = new ConversationStore({ paths, now });
  store.load();
  store.home();
  const profile = createProfile({ name: 'Fixture', provider: 'codex', cwd: join(paths.root, 'workspace') });
  // A conversation stuck on a session that never started, after a Runtime restart.
  store.setAttachment('home', { state: 'failed', sessionId: 'runtime-home', providerSessionId: null,
    provider: 'codex', model: null, configRevision: profile.configRevision });
  store.append('home', { kind: 'owner', origin: 'owner', text: 'Hello before signing in' });
  const calls = { create: 0, resume: 0, sends: [] as string[], retired: [] as string[] };
  // The first turn reached its CLI and failed: the journal records an attempted turn in runtime-home.
  const runs: WorkItem[] = [];
  const first = createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: 'home', prompt: 'Hello before signing in' }, now());
  first.run = { provider: 'codex', model: null, sessionId: 'runtime-home', startedAt: now().toISOString(), historyBaseline: 0 };
  runs.push(first);
  const client = {
    getSession: async (id: string): Promise<RuntimeSessionView> => ({ id, status: 'closed', providerName: 'codex',
      providerBackend: 'cli', origin: 'runtime', messageCount: 0 }),
    sessionControls: async () => ({}),
    resumeSession: async () => { calls.resume += 1; throw new RuntimeHttpError(400, 'No provider session ID to resume', null); },
    createSession: async () => { calls.create += 1; return { id: `new-${calls.create}`, status: 'ready' }; },
    // With an error, the CLI dies at start: Runtime marks each new session closed before the send arrives.
    streamMessage: async (id: string) => {
      calls.sends.push(id);
      if (sendError) throw sendError;
      return { completed: true, errorText: null };
    },
    getHistory: async () => ({ messages: [] }),
  };
  const binder = new SessionBinder({ client: () => client as unknown as RuntimeClient, profile: () => profile,
    conversations: store, now, log: () => {},
    hasAttemptedSessionTurn: (id) => runs.some((item) => item.run?.sessionId === id),
    retireSession: (id) => { calls.retired.push(id); } });
  const runner = new TurnRunner({ client: () => client as unknown as RuntimeClient, binder, conversations: store, now,
    emit: () => {}, persistRun: (item) => { runs.push(item); }, log: () => {} });
  const message = (prompt: string, itemKind: WorkItem['kind'] = kind) =>
    createWorkItem({ kind: itemKind, source: 'owner', conversationId: 'home', prompt }, now());
  return { store, calls, client, binder, runner, message };
}

for (const [label, error] of [
  ['400 closed', new RuntimeHttpError(400, 'Session is closed. Resume it first.', null)],
  ['410 exited', new RuntimeHttpError(410, 'Worker process has exited', null)],
  ['404 no worker', new RuntimeHttpError(404, 'No active worker. Resume the session first.', null)],
] as const) {
  test(`one owner message makes one session while its CLI still dies at start (${label})`, async (t) => {
    const f = setup(t, error);
    const outcome = await f.runner.run(f.message('Hello after signing in'), new AbortController());
    assert.equal(outcome.kind, 'failed');
    assert.equal(f.calls.create, 1);
    assert.deepEqual(f.calls.retired, ['runtime-home']);
  });
}

for (const entry of ['none', 'ready', 'sleeping', 'failed'] as const) {
  test(`one owner message makes one session from a ${entry} conversation while its CLI dies at start`, async (t) => {
    const f = setup(t, new RuntimeHttpError(400, 'Session is closed. Resume it first.', null));
    if (entry === 'none') f.store.setAttachment('home', { state: 'none', sessionId: null });
    else f.store.setAttachment('home', { state: entry });
    await f.runner.run(f.message('Hello after signing in'), new AbortController());
    assert.equal(f.calls.create, 1);
  });
}

test('once the CLI works, the owner\'s message replaces the session that never started and is answered', async (t) => {
  const f = setup(t, null);
  const outcome = await f.runner.run(f.message('Hello after signing in'), new AbortController());
  assert.equal(outcome.kind, 'completed');
  assert.equal(f.calls.create, 1);
  assert.deepEqual(f.calls.sends, ['new-1']);
  assert.equal(f.store.home().attachment.sessionId, 'new-1');
});

for (const kind of ['schedule', 'event', 'heartbeat'] as const) {
  test(`a ${kind} keeps the session that never started`, async (t) => {
    const f = setup(t, null, kind);
    const outcome = await f.runner.run(f.message('Background work'), new AbortController());
    assert.equal(outcome.kind, 'failed');
    assert.equal(f.calls.create, 0);
    assert.equal(f.store.home().attachment.sessionId, 'runtime-home');
  });
}

test('an owner\'s turn that joins a reconcile bind replaces the session once', async (t) => {
  const f = setup(t, null);
  const tick = f.binder.bind('home');
  const turn = f.binder.bind('home', { forTurn: true, owner: true });
  assert.equal(tick, turn);
  assert.deepEqual(await tick, { ok: true, sessionId: 'new-1', how: 'created' });
  assert.equal(f.calls.create, 1);
});

test('a replacement whose create times out leaves the next owner message free to try again', async (t) => {
  const f = setup(t, null);
  const create = f.client.createSession;
  let tries = 0;
  f.client.createSession = async () => {
    tries += 1;
    if (tries === 1) throw new Error('request timed out');
    return create();
  };
  const first = await f.runner.run(f.message('Hello after signing in'), new AbortController());
  assert.equal(first.kind, 'failed');
  assert.equal(f.store.home().attachment.sessionId, 'runtime-home');
  const second = await f.runner.run(f.message('Hello again'), new AbortController());
  assert.equal(second.kind, 'completed', second.kind === 'failed' ? second.reason : undefined);
  assert.equal(tries, 2);
});
