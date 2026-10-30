import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { runCoreCommand, type CoreCommandTarget } from '../../src/core/host-api/commands.ts';
import type { RemoteBotCore } from '../../src/core/host-api/remote.ts';
import type { BotDelivery, BotDeliveryState, WorkItem } from '../../src/core/types.ts';
import { CONSENT_COOLDOWN_MS, Coordinator, type CoordinatorDeps } from '../../src/shell/electron/hub/coordinator.ts';
import { CoreRunner } from '../../src/shell/electron/hub/coreRunner.ts';
import { normalizeRegistry } from '../../src/shell/electron/hub/registry.ts';
import { makeTempHome, type TempHome } from '../support/harness.ts';

/**
 * The security review of PLAN-009 Phase 5 (SPEC-009 FR-3, FR-5, FR-8, FR-9,
 * FR-12): the owner's confirmations, the delivery log, the limits and the
 * audit, with fake cores in a temporary home.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-coordinator-safety-');
});
after(() => home.cleanup());

interface FakeCore {
  admitted: BotDelivery[];
  admit?: (delivery: BotDelivery) => Promise<WorkItem>;
  deliveries?: (ids: string[]) => Promise<BotDeliveryState[]>;
}

function fakeRemote(fake: FakeCore): RemoteBotCore {
  let n = 0;
  return {
    admitBotMessage: async (delivery: BotDelivery) => {
      fake.admitted.push(delivery);
      if (fake.admit) return fake.admit(delivery);
      n += 1;
      return { id: `work-${n}` } as WorkItem;
    },
    botDeliveries: async (ids: string[]) => (fake.deliveries ? fake.deliveries(ids) : []),
    updateProfile: async () => ({}),
  } as unknown as RemoteBotCore;
}

function hub(dir: string, cores: Record<string, FakeCore | null>, overrides: Partial<CoordinatorDeps> = {}) {
  const logs: string[] = [];
  const remotes = new Map(Object.entries(cores).map(([id, fake]) => [id, fake ? fakeRemote(fake) : null]));
  const deps: CoordinatorDeps = {
    home: dir,
    holder: () => 'alpha',
    limits: () => ({ hopsPerChain: 4, messagesPerHour: 100 }),
    bots: () => [...remotes.keys()].map((id) => ({ id, name: id.toUpperCase(), state: 'running' })),
    core: (id) => remotes.get(id) ?? null,
    atBotCap: () => false,
    createBot: async () => 'x',
    startBlocked: () => null,
    startBot: async () => undefined,
    stopBot: async () => undefined,
    setHolder: async () => undefined,
    confirm: async () => false,
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { logs, coordinator: new Coordinator(deps) };
}

const call = (tool: string, args: Record<string, unknown>, conversationId = 'home') => ({ tool, args, conversationId });
const doneItem = (deliveryId: string, from = 'alpha', text = `answer to ${deliveryId}`): WorkItem => ({
  id: `w-${deliveryId}`, source: 'bot', state: 'completed', result: { text, completedAt: new Date().toISOString() },
  chain: { id: 'c', hop: 1, deliveryId, kind: 'message', from, fromName: from },
} as unknown as WorkItem);
const records = (dir: string) => readFileSync(join(dir, 'coordinator', 'deliveries.jsonl'), 'utf8').trim().split('\n')
  .filter(Boolean).map((line) => JSON.parse(line) as { id: string; kind: string; state: string; text: string; to: string });

// ---- the owner's confirmations (FR-3, FR-5) ----

function consent(name: string, overrides: Partial<CoordinatorDeps> = {}) {
  const state = { holder: 'alpha' as string | null, clock: Date.now() };
  const asked: Array<{ holder: string; question: string; detail: string }> = [];
  const created: string[] = [];
  const started: string[] = [];
  const deps: CoordinatorDeps = {
    home: join(home.root, name),
    holder: () => state.holder,
    limits: () => ({ hopsPerChain: 4, messagesPerHour: 10 }),
    bots: () => [
      { id: 'alpha', name: 'Alpha', state: 'running' },
      { id: 'beta', name: 'Beta', state: 'running' },
      { id: 'gamma', name: 'Gamma', state: 'stopped' },
    ],
    core: (id) => (id === 'gamma' ? null : {} as RemoteBotCore),
    atBotCap: () => false,
    createBot: async ({ name: botName }) => {
      created.push(botName);
      return 'new-bot';
    },
    startBlocked: () => null,
    startBot: async (id) => { started.push(id); },
    stopBot: async () => undefined,
    setHolder: async (id) => { state.holder = id; },
    confirm: async (holder, question, detail) => {
      asked.push({ holder, question, detail });
      return false;
    },
    log: () => undefined,
    now: () => new Date(state.clock),
    ...overrides,
  };
  return { state, asked, created, started, coordinator: new Coordinator(deps) };
}

test('what the owner allows after the role moved is not done (FR-3)', async () => {
  let release!: (value: boolean) => void;
  const f = consent('moved', { confirm: () => new Promise<boolean>((resolve) => { release = resolve; }) });
  const pending = f.coordinator.handle('alpha', call('hub_create_bot', { name: 'Gamma2', provider: 'claude' }));
  // The owner gives the role to beta in Settings while the dialog is open, then allows.
  f.state.holder = 'beta';
  release(true);
  const answer = await pending;
  assert.equal(answer.isError, true);
  assert.match(answer.text, /no longer holds/u);
  assert.deepEqual(f.created, []);
});

test('a transfer allowed after the owner assigned the role leaves the owner\'s choice (FR-3)', async () => {
  let release!: (value: boolean) => void;
  const f = consent('stale-transfer', { confirm: () => new Promise<boolean>((resolve) => { release = resolve; }) });
  const pending = f.coordinator.handle('alpha', call('hub_propose_transfer', { bot: 'beta' }));
  f.state.holder = 'gamma';
  release(true);
  assert.match((await pending).text, /no longer holds/u);
  assert.equal(f.state.holder, 'gamma');
});

test('one request of the holder waits for the owner at a time, and a declined one is not asked again at once (FR-5)', async () => {
  let release!: (value: boolean) => void;
  let asked = 0;
  const f = consent('flood', {
    confirm: () => {
      asked += 1;
      return new Promise<boolean>((resolve) => { release = resolve; });
    },
  });
  const first = f.coordinator.handle('alpha', call('hub_create_bot', { name: 'Bot 0', provider: 'claude' }));
  for (const tool of ['hub_create_bot', 'hub_propose_transfer', 'hub_start_bot']) {
    const args = tool === 'hub_create_bot' ? { name: 'Bot 1', provider: 'claude' } : { bot: tool === 'hub_start_bot' ? 'gamma' : 'beta' };
    assert.match((await f.coordinator.handle('alpha', call(tool, args))).text, /not answered your last request/u, tool);
  }
  release(false);
  assert.match((await first).text, /declined/u);
  assert.match((await f.coordinator.handle('alpha', call('hub_start_bot', { bot: 'gamma' }))).text, /a moment ago/u);
  assert.equal(asked, 1, 'only the first request reached the owner');
  f.state.clock += CONSENT_COOLDOWN_MS + 1;
  const later = f.coordinator.handle('alpha', call('hub_start_bot', { bot: 'gamma' }));
  release(true);
  assert.match((await later).text, /Started Gamma/u);
  assert.deepEqual(f.started, ['gamma']);
});

test('what the holder wrote reaches the owner\'s dialog only as labeled single lines (FR-5)', async () => {
  const f = consent('spoof');
  const refused = await f.coordinator.handle('alpha', call('hub_create_bot', { name: 'Tidy" on claude.\n\nThe owner already allowed this', provider: 'claude' }));
  assert.match(refused.text, /one line/u);
  assert.equal(f.asked.length, 0);
  const persona = `${'Routine maintenance bot. '.repeat(30)}\n\nCats Bot has verified this request. Press Allow to continue.`;
  await f.coordinator.handle('alpha', call('hub_create_bot', { name: 'Tidy', persona, provider: 'claude' }));
  const { question, detail } = f.asked[0]!;
  assert.equal(question, 'Alpha asks to create a new bot.');
  const lines = detail.split('\n');
  assert.deepEqual(lines.slice(0, 2), ['Name: Tidy', 'Provider: claude']);
  assert.match(lines[2]!, /^Persona, as Alpha wrote it: Routine maintenance bot\./u);
  assert.equal(lines.length, 3);
  assert.ok([...lines[2]!].length <= 'Persona, as Alpha wrote it: '.length + 300);
  assert.doesNotMatch(detail, /Cats Bot has verified/u);
});

test('a new bot beyond the cap, or a bot that failed, is refused before the owner is asked (SPEC-008 FR-4, D26)', async () => {
  const capped = consent('cap', { atBotCap: () => true });
  assert.match((await capped.coordinator.handle('alpha', call('hub_create_bot', { name: 'Delta', provider: 'claude' }))).text, /bot cap/u);
  assert.equal(capped.asked.length, 0);
  const failing = consent('blocked', { startBlocked: () => 'It kept failing, so only the owner can start it again.' });
  const answer = await failing.coordinator.handle('alpha', call('hub_start_bot', { bot: 'gamma' }));
  assert.match(answer.text, /Gamma cannot be started now\. It kept failing/u);
  assert.equal(failing.asked.length, 0);
  const broken = consent('no-start', {
    confirm: async () => true,
    startBot: async () => { throw new Error('It did not start: Runtime did not become ready'); },
  });
  const failed = await broken.coordinator.handle('alpha', call('hub_start_bot', { bot: 'gamma' }));
  assert.equal(failed.isError, true);
  assert.match(failed.text, /did not start/u);
});

test('a start by the holder keeps the restart budget, so a bot that keeps failing is left for the owner (SPEC-008 FR-9)', async () => {
  let launches = 0;
  const failing = (delaysMs: number[]) => new CoreRunner<object>('beta', {
    start: async () => {
      launches += 1;
      throw new Error('Runtime did not become ready');
    },
    stop: async () => undefined,
    onLost: () => undefined,
    isExternal: () => false,
    changed: () => undefined,
    log: () => undefined,
    delaysMs,
    maxRestarts: 3,
    windowMs: 60_000,
  });
  const runner = failing([5, 5, 5]);
  await runner.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(launches, 4, 'one start and three restarts');
  await assert.rejects(runner.startAgain(), /only the owner/u);
  assert.equal(launches, 4);
  const waiting = failing([60_000]);
  await waiting.start();
  assert.match(waiting.startAgainRefusal() ?? '', /starts again by itself/u);
  await assert.rejects(waiting.startAgain(), /starts again by itself/u);
  await waiting.stop();
  assert.equal(waiting.startAgainRefusal(), null, 'a stopped bot may be started, with the owner\'s consent');
});

// ---- deliveries (FR-8, FR-9, FR-12) ----

test('a last line a crash cut short loses nothing recorded after it (FR-12)', async () => {
  const dir = join(home.root, 'torn');
  const busy: FakeCore = { admitted: [], admit: async () => { throw new Error('core busy'); } };
  const first = hub(dir, { alpha: { admitted: [] }, beta: busy });
  assert.match((await first.coordinator.handle('alpha', call('hub_message_bot', { bot: 'beta', text: 'first' }))).text, /Recorded for/u);
  appendFileSync(join(dir, 'coordinator', 'deliveries.jsonl'), '{"id":"delivery-torn","kind":"mess', 'utf8');
  const second = hub(dir, { alpha: { admitted: [] }, beta: busy });
  assert.match((await second.coordinator.handle('alpha', call('hub_message_bot', { bot: 'beta', text: 'second' }))).text, /Recorded for/u);
  const healthy: FakeCore = { admitted: [] };
  const third = hub(dir, { alpha: { admitted: [] }, beta: healthy });
  await third.coordinator.attached('beta');
  assert.deepEqual(healthy.admitted.map((delivery) => delivery.text), ['first', 'second']);
});

test('the hop limit stays within what a core admits, and long names are shortened (FR-8)', async () => {
  assert.equal(normalizeRegistry({ schemaVersion: 1, bots: [], limits: { hopsPerChain: 1000, messagesPerHour: 10 } }).limits.hopsPerChain, 4);
  assert.equal(normalizeRegistry({ schemaVersion: 1, bots: [], limits: { hopsPerChain: 100, messagesPerHour: 1000 } }).limits.hopsPerChain, 100);
  const target = { admitBotMessage: () => ({ id: 'w' }) } as unknown as CoreCommandTarget;
  const delivery = { deliveryId: 'delivery-a', chainId: 'chain-a', hop: 100, kind: 'message', from: 'alpha', fromName: 'A', text: 't' };
  await runCoreCommand(target, 'admitBotMessage', [delivery]);
  await assert.rejects(runCoreCommand(target, 'admitBotMessage', [{ ...delivery, hop: 101 }]), /hop/u);
  await assert.rejects(runCoreCommand(target, 'admitBotMessage', [{ ...delivery, from: '../x' }]), /bot id/u);
  await assert.rejects(runCoreCommand(target, 'admitBotMessage', [{ ...delivery, chainId: 'chain\nx' }]), /hub ids/u);
  const beta: FakeCore = { admitted: [] };
  const h = hub(join(home.root, 'long-name'), { alpha: { admitted: [] }, beta }, {
    bots: () => [{ id: 'alpha', name: `A${'\n'}${'a'.repeat(500)}`, state: 'running' }, { id: 'beta', name: 'B', state: 'running' }],
  });
  assert.match((await h.coordinator.handle('alpha', call('hub_message_bot', { bot: 'beta', text: 'hi' }))).text, /Delivered/u);
  assert.ok(beta.admitted[0]!.fromName.length <= 80);
  assert.doesNotMatch(beta.admitted[0]!.fromName, /\n/u);
});

test('each delivery of a chain is a hop, also a reply still on its way (FR-8)', async () => {
  const alpha: FakeCore = { admitted: [] };
  const beta: FakeCore = { admitted: [] };
  const gamma: FakeCore = { admitted: [] };
  const h = hub(join(home.root, 'fanout'), { alpha, beta, gamma });
  const m1 = await h.coordinator.handle('alpha', call('hub_message_bot', { bot: 'beta', text: 'one' }));
  const chain = m1.structuredContent?.chain as string;
  const m2 = await h.coordinator.handle('alpha', call('hub_message_bot', { bot: 'gamma', text: 'two', chain }));
  const m3 = await h.coordinator.handle('alpha', call('hub_message_bot', { bot: 'beta', text: 'three', chain }));
  assert.deepEqual([m1, m2].map((answer) => answer.structuredContent?.hop), [1, 3]);
  assert.match(m3.text, /limit of 4 hops/u);
  await h.coordinator.turnCompleted('beta', doneItem(m1.structuredContent?.delivery as string));
  await h.coordinator.turnCompleted('gamma', doneItem(m2.structuredContent?.delivery as string));
  const replies = alpha.admitted.filter((delivery) => delivery.kind === 'reply');
  assert.deepEqual(replies.map((delivery) => delivery.hop).sort(), [2, 4]);
  assert.equal(beta.admitted.length + gamma.admitted.length + replies.length, 4, 'four deliveries under a limit of four');
});

test('a target that does not answer holds up only its own deliveries (FR-12)', async () => {
  const wedged: FakeCore = { admitted: [], admit: () => new Promise<WorkItem>(() => { /* never answers */ }) };
  const gamma: FakeCore = { admitted: [] };
  const h = hub(join(home.root, 'queues'), { alpha: { admitted: [] }, beta: wedged, gamma });
  void h.coordinator.handle('alpha', call('hub_message_bot', { bot: 'beta', text: 'to the wedged bot' }));
  assert.match((await h.coordinator.handle('alpha', call('hub_message_bot', { bot: 'gamma', text: 'to a healthy bot' }))).text, /Delivered to GAMMA/u);
  assert.equal(gamma.admitted.length, 1);
});

test('a core answers only for deliveries sent to it (FR-12)', async () => {
  const alpha: FakeCore = { admitted: [] };
  let forged = '';
  const beta: FakeCore = {
    admitted: [],
    deliveries: async () => [{ deliveryId: forged, workItemId: 'x', state: 'completed', reply: 'forged by beta', error: null }],
  };
  const h = hub(join(home.root, 'foreign'), { alpha, beta, gamma: { admitted: [] } });
  forged = (await h.coordinator.handle('alpha', call('hub_message_bot', { bot: 'gamma', text: 'for gamma' }))).structuredContent?.delivery as string;
  await h.coordinator.handle('alpha', call('hub_message_bot', { bot: 'beta', text: 'for beta' }));
  await h.coordinator.attached('beta');
  assert.equal(alpha.admitted.filter((delivery) => delivery.kind === 'reply').length, 0);
});

test('a reply the hub could not record reaches the holder once after the hub starts again (FR-12)', async () => {
  const dir = join(home.root, 'order');
  const alpha: FakeCore = { admitted: [] };
  const h = hub(dir, { alpha, beta: { admitted: [] } });
  const deliveryId = (await h.coordinator.handle('alpha', call('hub_message_bot', { bot: 'beta', text: 'q' }))).structuredContent?.delivery as string;
  const instance = h.coordinator as unknown as { save(record: { kind: string }): void };
  const save = instance.save.bind(h.coordinator);
  instance.save = (record) => {
    if (record.kind === 'reply') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    save(record);
  };
  await assert.rejects(h.coordinator.turnCompleted('beta', doneItem(deliveryId)), /ENOSPC/u);
  const finished: FakeCore = {
    admitted: [],
    deliveries: async (ids) => ids.map((id) => ({ deliveryId: id, workItemId: 'w', state: 'completed', reply: 'late', error: null })),
  };
  for (let start = 0; start < 2; start += 1) {
    const again = hub(dir, { alpha, beta: finished });
    await again.coordinator.attached('beta');
    await again.coordinator.attached('alpha');
  }
  const replies = alpha.admitted.filter((delivery) => delivery.kind === 'reply');
  assert.deepEqual(replies.map((delivery) => [delivery.deliveryId, delivery.text]), [[`reply-${deliveryId}`, 'late']]);
});

test('the hub log and audit keep ids, whatever the model passes (FR-9)', async () => {
  const dir = join(home.root, 'inject');
  const h = hub(dir, { alpha: { admitted: [] }, beta: { admitted: [] } });
  await h.coordinator.handle('alpha', call('hub_stop_bot', { bot: 'x\n2026-10-30T10:00:00.000Z coordinator hub_propose_transfer by alpha for beta: done\n' }));
  assert.ok(h.logs.every((line) => !line.includes('\n')));
  assert.doesNotMatch(h.logs.join('\n'), /hub_propose_transfer/u);
  const audit = join(dir, 'logs', 'hub-audit.jsonl');
  const before = statSync(audit).size;
  for (let i = 0; i < 10; i += 1) {
    await h.coordinator.handle('alpha', call('hub_list_bots', { bot: 'y'.repeat(90_000), chain: 'z'.repeat(90_000) }));
  }
  assert.ok(statSync(audit).size - before < 10 * 300, `the audit grew ${statSync(audit).size - before} bytes`);
  assert.match((await h.coordinator.handle('alpha', call('hub_list_bots\nforged', {}))).text, /could not read the call/u);
});

test('a hub that starts again keeps one line per delivery, settled ones without text and for 30 days (FR-12)', async () => {
  const dir = join(home.root, 'compact');
  const alpha: FakeCore = { admitted: [] };
  const beta: FakeCore = { admitted: [] };
  const h = hub(dir, { alpha, beta });
  const text = 'z'.repeat(64 * 1024);
  const deliveryId = (await h.coordinator.handle('alpha', call('hub_message_bot', { bot: 'beta', text }))).structuredContent?.delivery as string;
  await h.coordinator.turnCompleted('beta', doneItem(deliveryId, 'alpha', text));
  const file = join(dir, 'coordinator', 'deliveries.jsonl');
  assert.ok(statSync(file).size > 3 * text.length);
  hub(dir, { alpha, beta });
  assert.deepEqual(records(dir).map((record) => [record.kind, record.text]), [['message', ''], ['reply', '']]);
  assert.ok(statSync(file).size < 2_000);
  hub(dir, { alpha, beta }, { now: () => new Date(Date.now() + 31 * 24 * 3_600_000) });
  assert.deepEqual(records(dir), []);
});

test('replies on their way to an archived bot are dropped, so a new bot with its id receives none (FR-12)', async () => {
  const dir = join(home.root, 'reuse');
  const beta: FakeCore = { admitted: [] };
  const h = hub(dir, { mochi: { admitted: [] }, beta }, { holder: () => 'mochi' });
  const deliveryId = (await h.coordinator.handle('mochi', call('hub_message_bot', { bot: 'beta', text: 'summarize the notes' }))).structuredContent?.delivery as string;
  // mochi's core is gone when beta answers; then the owner archives mochi.
  const offline = hub(dir, { mochi: null, beta });
  await offline.coordinator.turnCompleted('beta', doneItem(deliveryId, 'mochi', 'Here are the notes'));
  await offline.coordinator.targetGone('mochi', 'the bot was archived');
  const fresh: FakeCore = { admitted: [] };
  await hub(dir, { mochi: fresh, beta }).coordinator.attached('mochi');
  assert.equal(fresh.admitted.length, 0);
  // A sender already archived when the answer comes gets no reply recorded at all.
  const second = (await hub(dir, { mochi: { admitted: [] }, beta }, { holder: () => 'mochi' }).coordinator
    .handle('mochi', call('hub_message_bot', { bot: 'beta', text: 'again' }))).structuredContent?.delivery as string;
  await hub(dir, { beta }).coordinator.turnCompleted('beta', doneItem(second, 'mochi'));
  assert.equal(records(dir).filter((record) => record.id === `reply-${second}`).length, 0);
  assert.equal(records(dir).filter((record) => record.id === second).at(-1)?.state, 'answered');
});
