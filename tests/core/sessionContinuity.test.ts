import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { SessionBinder } from '../../src/core/conversations/binder.ts';
import { ConversationStore } from '../../src/core/conversations/store.ts';
import { createProfile } from '../../src/core/profile/profile.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import { RuntimeHttpError, type RuntimeClient, type RuntimeSessionView } from '../../src/core/runtime/client.ts';
import type { AttachmentState } from '../../src/core/types.ts';
import { makeTempHome } from '../support/harness.ts';
import { TurnRunner } from '../../src/core/queue/turnRunner.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';
import type { RuntimeStreamEvent } from '../../src/core/runtime/client.ts';
import { LifeLoop } from '../../src/core/life/loop.ts';
import { checkedResponse } from '../../src/core/store/presentation.ts';
import { openTestStateStore } from '../support/stateData.ts';

function fixture(t: { after(fn: () => void): void }, state: AttachmentState = 'sleeping') {
  const home = makeTempHome('cats-bot-continuity-');
  const paths = botPathsFor(join(home.botsHome, 'fixture'));
  const now = () => new Date('2026-11-11T00:00:00Z');
  const db = openTestStateStore(paths, t);
  // The database closes before its directory is removed; Windows refuses otherwise.
  t.after(() => { db.close(); home.cleanup(); });
  const store = new ConversationStore({ store: () => db, now }); store.load(); store.home();
  const profile = createProfile({ name: 'Fixture', provider: 'codex', cwd: join(paths.root, 'workspace') });
  const saved = (id: string) => ({ state, sessionId: `runtime-${id}`, providerSessionId: `native-${id}`,
    provider: 'codex', model: null, configRevision: profile.configRevision });
  store.setAttachment('home', saved('home'));
  const calls = { inspect: [] as string[], resume: [] as Array<{ id: string; body: unknown }>, create: [] as unknown[], overlay: [] as string[], retired: [] as string[] };
  const client = {
    getSession: async (id: string): Promise<RuntimeSessionView> => {
      calls.inspect.push(id); return { id, status: 'closed', providerName: 'codex', providerSessionId: id.replace('runtime-', 'native-') };
    },
    sessionControls: async () => ({}),
    resumeSession: async (id: string, body: unknown) => {
      calls.resume.push({ id, body }); return { id, status: 'ready', providerSessionId: id.replace('runtime-', 'native-') };
    },
    createSession: async (body: unknown) => {
      calls.create.push(body); return { id: `new-${calls.create.length}`, status: 'initializing' };
    },
  };
  let attempted: boolean | undefined = false;
  const makeBinder = (conversations = store) => new SessionBinder({ client: () => client as unknown as RuntimeClient,
    profile: () => profile, conversations, now, log: () => {},
    mcpServers: () => [{ name: 'fixture', transport: 'http', url: 'http://127.0.0.1:1', auth: { kind: 'bearer_env', token: 'fresh-test-token' } }],
    sessionCreated: id => { calls.overlay.push(id); },
    retireSession: id => { calls.retired.push(id); },
    ...(attempted !== undefined ? { hasAttemptedSessionTurn: () => attempted! } : {}),
  });
  return { paths, db, now, store, profile, saved, calls, client, binder: makeBinder(), makeBinder,
    setAttempted(value: boolean | undefined) { attempted = value; } };
}

for (const state of ['sleeping', 'closed', 'failed'] as const) {
  test(`${state} saved attachments resume both identities, with fresh host descriptors and no create`, async t => {
    const f = fixture(t, state);
    const [first, joined] = await Promise.all([f.binder.bind('home'), f.binder.bind('home')]);
    assert.deepEqual(first, { ok: true, sessionId: 'runtime-home', how: 'resumed' });
    assert.equal(joined, first);
    assert.equal(f.calls.resume.length, 1);
    assert.equal(f.calls.create.length, 0);
    assert.equal(f.store.home().attachment.providerSessionId, 'native-home');
    assert.deepEqual(f.calls.overlay, ['runtime-home']);
    assert.equal((f.calls.resume[0]!.body as { mcpServers: Array<{ auth: { token: string } }> }).mcpServers[0]!.auth.token, 'fresh-test-token');
  });
}

for (const id of ['home', 'note']) {
  test(`an unstarted closed CLI session for ${id} rebuilds once with its conversation handoff`, async t => {
    const f = fixture(t, 'failed');
    if (id === 'note') { f.store.create('Note', 'note', id); f.store.setAttachment(id, f.saved(id)); }
    f.store.setAttachment(id, { providerSessionId: null });
    f.store.append(id, { kind: 'owner', origin: 'owner', text: 'Keep my previous conversation' });
    f.client.getSession = async sessionId => ({ id: sessionId, status: 'closed', providerName: 'codex',
      providerBackend: 'cli', origin: 'runtime', messageCount: 0 });
    const [first, joined] = await Promise.all([f.binder.bind(id), f.binder.bind(id)]);
    assert.deepEqual(first, { ok: true, sessionId: 'new-1', how: 'created' });
    assert.equal(joined, first);
    assert.equal(f.calls.resume.length, 0);
    assert.equal(f.calls.create.length, 1);
    assert.match((f.calls.create[0] as { instructions: string }).instructions, /Keep my previous conversation/u);
    assert.deepEqual(f.calls.retired, [`runtime-${id}`]);
    assert.equal(f.store.require(id).attachment.replacementPending, true);
    assert.equal(f.store.transcript(id).filter(entry => entry.text.includes('a new session starts')).length, 1);
    if (id === 'note') assert.equal(f.store.home().attachment.sessionId, 'runtime-home');

    // Even if the new zero-turn worker also stops, restarting cannot create
    // another replacement before this one has completed a turn.
    f.store.setAttachment(id, { state: 'sleeping' });
    const reloaded = new ConversationStore({ store: () => f.db, now: f.now }); reloaded.load();
    assert.equal((await f.makeBinder(reloaded).bind(id)).ok, false);
    assert.equal(f.calls.create.length, 1);
  });
}

for (const replacementPending of [false, true]) for (const condition of ['live', 'closing', 'used', 'count_unknown', 'origin_unknown', 'discovered', 'backend_unknown', 'api', 'saved_native', 'observed_native', 'attempted', 'attempt_unknown', 'source_path', 'provider_path', 'current_run', 'last_run']) {
  test(`an absent native ID does not authorize replacement when ${condition}, fenced=${replacementPending}`, async t => {
    const f = fixture(t);
    if (condition === 'attempted' || condition === 'attempt_unknown') f.setAttempted(condition === 'attempted' ? true : undefined);
    f.store.setAttachment('home', { providerSessionId: condition === 'saved_native' ? 'native-home' : null,
      replacementPending: replacementPending || undefined });
    f.client.getSession = async id => ({ id, status: condition === 'live' ? 'ready' : condition === 'closing' ? 'closing' : 'closed',
      providerName: 'codex', providerBackend: condition === 'api' ? 'api' : condition === 'backend_unknown' ? undefined : 'cli',
      origin: condition === 'discovered' ? 'discovered' : condition === 'origin_unknown' ? undefined : 'runtime',
      messageCount: condition === 'used' ? 1 : condition === 'count_unknown' ? undefined : 0,
      ...(condition === 'source_path' ? { sourcePath: 'fixture-history.jsonl' } : {}),
      ...(condition === 'provider_path' ? { providerSourcePath: 'fixture-native.jsonl' } : {}),
      ...(condition === 'current_run' ? { inspection: { currentRun: { status: 'running' } } } : {}),
      ...(condition === 'last_run' ? { inspection: { lastRun: { status: 'failed' } } } : {}),
      ...(condition === 'observed_native' ? { providerSessionId: 'native-home' } : {}) });
    f.client.resumeSession = async () => { throw new RuntimeHttpError(400, 'No provider session ID to resume', null); };
    assert.equal((await f.makeBinder().bind('home', { forTurn: true })).ok, condition === 'live');
    assert.equal(f.calls.create.length, 0);
    assert.equal(f.store.home().attachment.sessionId, 'runtime-home');
  });
}

test('a pending turn recovers an unused replacement after reload while ticks remain fenced', async t => {
  const f = fixture(t);
  f.store.setAttachment('home', { providerSessionId: null, replacementPending: true });
  f.store.append('home', { kind: 'owner', origin: 'owner', text: 'Preserve my conversation' });
  f.client.getSession = async id => ({ id, status: 'closed', origin: 'runtime', providerBackend: 'cli', messageCount: 0 });
  const reloaded = new ConversationStore({ store: () => f.db, now: f.now }); reloaded.load();
  const binder = f.makeBinder(reloaded);
  for (let tick = 0; tick < 3; tick++) assert.equal((await binder.bind('home')).ok, false);
  assert.equal(f.calls.create.length, 0);

  Object.assign(f.client, {
    streamMessage: async () => ({ completed: true, errorText: null }),
  });
  const runner = new TurnRunner({ client: () => f.client as unknown as RuntimeClient,
    binder, conversations: reloaded, now: f.now, emit: () => {}, persistRun: () => {}, log: () => {} });
  const item = createWorkItem({ kind: 'owner_message', source: 'fixture', conversationId: 'home', prompt: 'Continue' }, f.now());
  assert.equal((await runner.run(item, new AbortController())).kind, 'completed');
  assert.equal(f.calls.create.length, 1);
  assert.match((f.calls.create[0] as { instructions: string }).instructions, /Preserve my conversation/u);
  assert.deepEqual(f.calls.retired, ['runtime-home']);
  assert.equal(reloaded.home().attachment.sessionId, 'new-1');
  assert.equal(reloaded.home().attachment.replacementPending, undefined);
});

test('a turn joining a reconcile bind shares its unstarted replacement instead of staying blocked', async t => {
  const f = fixture(t);
  f.store.setAttachment('home', { providerSessionId: null, replacementPending: true });
  f.client.getSession = async id => ({ id, status: 'closed', origin: 'runtime', providerBackend: 'cli', messageCount: 0 });
  const tick = f.binder.bind('home');
  const turn = f.binder.bind('home', { forTurn: true });
  assert.equal(turn, tick);
  assert.deepEqual(await turn, { ok: true, sessionId: 'new-1', how: 'created' });
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.store.home().attachment.replacementPending, true);
});

test('an ambiguous create while recovering an unused replacement stays fenced for later turns', async t => {
  const f = fixture(t);
  f.store.setAttachment('home', { providerSessionId: null, replacementPending: true });
  f.client.getSession = async id => ({ id, status: 'closed', origin: 'runtime', providerBackend: 'cli', messageCount: 0 });
  let attempts = 0;
  f.client.createSession = async () => { attempts++; throw new Error('request timed out'); };
  assert.equal((await f.binder.bind('home', { forTurn: true })).ok, false);
  const reloaded = new ConversationStore({ store: () => f.db, now: f.now }); reloaded.load();
  assert.equal((await f.makeBinder(reloaded).bind('home', { forTurn: true })).ok, false);
  assert.equal(attempts, 1);
});

for (const evidence of ['terminal', 'missing'] as const) {
  test(`a pending turn cannot bypass the replacement fence for ${evidence} evidence`, async t => {
    const f = fixture(t);
    f.store.setAttachment('home', { providerSessionId: null, replacementPending: true });
    f.client.getSession = async id => {
      if (evidence === 'missing') throw new RuntimeHttpError(404, 'Session not found', null);
      return { id, status: 'closed', origin: 'runtime', providerBackend: 'cli', messageCount: 0, providerSessionUnavailable: true };
    };
    assert.equal((await f.binder.bind('home', { forTurn: true })).ok, false);
    assert.equal(f.calls.create.length, 0);
  });
}

test('temporary resume failures preserve the mapping across attempts and notes stay separate', async t => {
  const f = fixture(t);
  f.store.create('Note', 'note', 'note'); f.store.setAttachment('note', f.saved('note'));
  const resume = f.client.resumeSession;
  f.client.resumeSession = async () => { throw new RuntimeHttpError(503, 'temporary failure', null); };
  assert.equal((await f.binder.bind('home')).ok, false);
  assert.equal((await f.binder.bind('home')).ok, false);
  assert.equal(f.calls.create.length, 0);
  assert.equal(f.store.home().attachment.sessionId, 'runtime-home');
  f.client.resumeSession = resume;
  assert.equal((await f.binder.bind('home')).ok, true);
  assert.equal((await f.binder.bind('note')).ok, true);
  assert.deepEqual(f.calls.resume.map(call => call.id), ['runtime-home', 'runtime-note']);
});

test('confirmed loss replaces once and the fence survives reload until a completed turn', async t => {
  const f = fixture(t);
  f.store.append('home', { kind: 'owner', origin: 'owner', text: 'Keep this history' });
  f.client.getSession = async () => { throw new RuntimeHttpError(404, 'Session not found', null); };
  assert.equal((await f.binder.bind('home')).ok, true);
  assert.equal(f.calls.create.length, 1);
  assert.match((f.calls.create[0] as { instructions: string }).instructions, /Keep this history/u);
  assert.equal(f.store.home().attachment.replacementPending, true);
  f.store.setAttachment('home', { state: 'sleeping' });
  const reloaded = new ConversationStore({ store: () => f.db, now: f.now }); reloaded.load();
  assert.equal((await f.makeBinder(reloaded).bind('home')).ok, false);
  assert.equal((await f.makeBinder(reloaded).bind('home')).ok, false);
  assert.equal(f.calls.create.length, 1);
});

test('a failed replacement request cannot create again on the next tick', async t => {
  const f = fixture(t);
  f.store.setAttachment('home', { unavailableReason: 'provider_session_unavailable', state: 'failed' });
  let attempts = 0;
  f.client.createSession = async () => { attempts++; throw new Error('request timed out'); };
  assert.equal((await f.binder.bind('home')).ok, false);
  assert.equal((await f.binder.bind('home')).ok, false);
  assert.equal(attempts, 1);
});

test('old records load without rewriting, and intentional retarget creates a new session', async t => {
  const f = fixture(t, 'closed');
  const stored = (): string => JSON.stringify(f.db.conversations().find((record) => (record as { id: string }).id === 'home'));
  const before = stored();
  const reloaded = new ConversationStore({ store: () => f.db, now: f.now }); reloaded.load();
  assert.equal(stored(), before);
  assert.equal(reloaded.home().attachment.replacementPending, undefined);
  f.profile.configRevision++;
  const result = await f.makeBinder(reloaded).bind('home');
  assert.ok(result.ok && result.how === 'created');
  assert.equal(f.calls.resume.length, 0);
  assert.equal(reloaded.home().attachment.replacementPending, undefined);
});

for (const transport of ['http', 'stream', 'repeated', 'partial', 'partial_text'] as const) {
  test(`native loss via ${transport} has bounded recovery and never replays partial work`, async t => {
    const f = fixture(t, 'ready'); let sends = 0;
    Object.assign(f.client, {
      getHistory: async () => ({ messages: [] }),
      streamMessage: async (_id: string, _request: unknown, onEvent: (event: RuntimeStreamEvent) => void) => {
        sends++;
        if (sends === 1 || transport === 'repeated') {
          if (transport === 'http' || transport === 'repeated') {
            throw new RuntimeHttpError(410, 'Native history unavailable', null, 'provider_session_unavailable');
          }
          if (transport === 'partial') onEvent({ type: 'tool_use', toolName: 'fixture', toolId: 'one' });
          if (transport === 'partial_text') onEvent({ type: 'text', text: 'Partial response' });
          onEvent({ type: 'error', code: 'provider_session_unavailable', text: 'Native history unavailable' });
          return { completed: false, errorText: 'Native history unavailable', errorCode: 'provider_session_unavailable' };
        }
        onEvent({ type: 'text', text: 'Recovered' });
        onEvent({ type: 'result' });
        return { completed: true, errorText: null };
      },
    });
    const runner = new TurnRunner({ client: () => f.client as unknown as RuntimeClient,
      binder: f.binder, conversations: f.store, now: f.now, emit: () => {}, persistRun: () => {}, log: () => {} });
    const item = createWorkItem({ kind: 'owner_message', source: 'fixture', conversationId: 'home', prompt: 'Fixture turn' }, f.now());
    const outcome = await runner.run(item, new AbortController());
    if (transport === 'partial' || transport === 'partial_text') {
      assert.equal(outcome.kind, 'failed'); assert.equal(sends, 1); assert.equal(f.calls.create.length, 0);
    } else if (transport === 'repeated') {
      assert.equal(outcome.kind, 'failed'); assert.equal(sends, 2); assert.equal(f.calls.create.length, 1);
      assert.equal((await runner.run(item, new AbortController())).kind, 'failed');
      assert.equal(f.calls.create.length, 1); assert.equal(sends, 2);
    } else {
      assert.equal(outcome.kind, 'completed'); assert.equal(sends, 2); assert.equal(f.calls.create.length, 1);
      assert.equal(f.store.home().attachment.replacementPending, undefined);
    }
    const presentations = f.db.responses('home').map((row) => checkedResponse(row)!);
    assert.ok(presentations.every(entry => entry.presentation?.phase === 'sealed'));
    assert.ok(presentations.every(entry => entry.presentation?.blocks.every(block => block.status !== 'streaming')));
    if (transport === 'partial' || transport === 'partial_text') {
      assert.equal(presentations.length, 1);
      assert.equal(presentations[0]!.presentation!.blocks[0]!.kind, transport === 'partial' ? 'tool' : 'text');
      if (transport === 'partial') assert.equal(presentations[0]!.presentation!.blocks[0]!.status, 'error');
    }
  });
}

for (const evidence of ['missing', 'unavailable', 'running', 'retargeted'] as const) {
  test(`a late home probe (${evidence}) cannot replace or overwrite a newer attachment`, async t => {
    const f = fixture(t, 'ready');
    let resolveProbe!: (view: RuntimeSessionView) => void;
    let rejectProbe!: (error: Error) => void;
    let running = false;
    f.profile.heartbeat.enabled = false;
    f.client.getSession = () => new Promise((resolve, reject) => { resolveProbe = resolve; rejectProbe = reject; });
    const life = new LifeLoop({ now: f.now, random: () => 0, profile: () => f.profile,
      heartbeatMode: () => 'assist', conversations: f.store, binder: f.binder,
      client: () => f.client as unknown as RuntimeClient, runtimeState: () => 'ready', ensureRuntime: async () => true,
      isTurnRunning: () => running, hasQueuedWork: () => false, hasQueuedWorkIn: () => false, enqueue: () => {}, schedules: () => [],
      saveSchedule: () => {}, awaitingOwner: () => [], expireWorkItem: () => {}, journal: () => {}, emit: () => {},
      log: () => {}, readLifeState: () => null, writeLifeState: () => {},
    });
    const tick = life.tick();
    assert.ok(resolveProbe, 'the home GET is pending');
    if (evidence === 'running') running = true;
    else if (evidence === 'retargeted') f.profile.configRevision++;
    else {
      // An owner send confirms A is unavailable and binds B while the tick's GET(A) is pending.
      f.store.setAttachment('home', { state: 'failed', unavailableReason: 'provider_session_unavailable' });
      assert.equal((await f.binder.bind('home')).ok, true);
      f.store.setAttachment('home', { state: 'ready', replacementPending: undefined });
    }
    const before = structuredClone(f.store.home().attachment);
    if (evidence === 'missing') rejectProbe(new RuntimeHttpError(404, 'Session not found', null));
    else resolveProbe({ id: 'runtime-home', status: 'closed', providerSessionUnavailable: { code: 'provider_session_unavailable' } });
    const report = await tick;
    assert.equal(report.outcome, evidence === 'running' ? 'busy_turn' : 'runtime_unknown');
    assert.deepEqual(f.store.home().attachment, before);
    assert.equal(f.calls.create.length, evidence === 'missing' || evidence === 'unavailable' ? 1 : 0);
    assert.equal(f.calls.resume.length, 0);
  });
}

test('repeated-failure evidence survives reload and a fenced known-text failure can recover in the same live session', async t => {
  const f = fixture(t, 'ready');
  let failure = 'provider transport reset'; let sends = 0;
  Object.assign(f.client, {
    getHistory: async () => ({ messages: [] }),
    streamMessage: async (_id: string, _request: unknown, onEvent: (event: RuntimeStreamEvent) => void) => {
      sends++;
      if (failure) {
        onEvent({ type: 'error', text: failure });
        return { completed: false, errorText: failure };
      }
      onEvent({ type: 'text', text: 'Repaired' }); onEvent({ type: 'result' });
      return { completed: true, errorText: null };
    },
  });
  const runnerFor = (store: ConversationStore) => new TurnRunner({ client: () => f.client as unknown as RuntimeClient,
    binder: f.makeBinder(store), conversations: store, now: f.now, emit: () => {}, persistRun: () => {}, log: () => {} });
  const run = (runner: TurnRunner, prompt: string) => runner.run(createWorkItem({ kind: 'owner_message', source: 'fixture',
    conversationId: 'home', prompt }, f.now()), new AbortController());
  const initial = runnerFor(f.store);
  assert.equal((await run(initial, 'first')).kind, 'failed');
  assert.equal((await run(initial, 'second')).kind, 'failed');
  assert.equal(sends, 2); assert.equal(f.calls.create.length, 0);
  assert.equal(f.store.home().attachment.unavailableReason, 'repeated_provider_failure');
  const reloaded = new ConversationStore({ store: () => f.db, now: f.now }); reloaded.load();
  assert.equal(reloaded.home().attachment.unavailableReason, 'repeated_provider_failure');
  const afterRestart = runnerFor(reloaded);
  failure = 'No saved copy of session fixture was found remotely.';
  assert.equal((await run(afterRestart, 'third')).kind, 'failed');
  assert.equal(f.calls.create.length, 1); assert.equal(reloaded.home().attachment.replacementPending, true);
  // A fresh runner has no in-memory guard; the saved fence must still prevent another create.
  const restartedAgain = runnerFor(reloaded);
  assert.equal((await run(restartedAgain, 'fourth')).kind, 'failed');
  assert.equal(f.calls.create.length, 1);
  const replacementId = reloaded.home().attachment.sessionId;
  failure = '';
  assert.equal((await run(restartedAgain, 'repair')).kind, 'completed');
  assert.equal(reloaded.home().attachment.sessionId, replacementId);
  assert.equal(reloaded.home().attachment.replacementPending, undefined);
  assert.equal(f.calls.create.length, 1);
});
