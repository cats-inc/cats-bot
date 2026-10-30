import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { BotCore } from '../../src/core/bot.ts';
import { HostChannelClient } from '../../src/core/host-api/channel.ts';
import { remoteBotCore, type RemoteBotCore } from '../../src/core/host-api/remote.ts';
import { HUB_SERVER_NAME } from '../../src/core/tools/hubTools.ts';
import type { BotDelivery, BotHostEvent, TranscriptEntry, WorkItem } from '../../src/core/types.ts';
import { Coordinator, type ToolAnswer } from '../../src/shell/electron/hub/coordinator.ts';
import { makeTempHome, openTestBot, type TempHome } from '../support/harness.ts';

/**
 * PLAN-009 Phase 5 (SPEC-009): the hub's coordinator with two real cores on the fake
 * runtime, reached only through their host channels as the hub reaches them.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-coordinator-');
});
after(() => home.cleanup());

interface Bot {
  core: BotCore;
  client: HostChannelClient;
  remote: RemoteBotCore;
}

async function setUp(prefix: string, limits = { hopsPerChain: 4, messagesPerHour: 10 }) {
  const holder = { id: `${prefix}-alpha` as string | null };
  const answers: boolean[] = [];
  const asked: string[] = [];
  const created: string[] = [];
  const bots = new Map<string, Bot>();
  const names: Record<string, string> = { [`${prefix}-alpha`]: 'Alpha', [`${prefix}-beta`]: 'Beta' };
  const clock = { now: Date.now() };
  let coordinator: Coordinator;
  const coordinatorHome = join(home.root, prefix);
  const make = () => new Coordinator({
    home: coordinatorHome,
    holder: () => holder.id,
    limits: () => limits,
    bots: () => Object.entries(names).map(([id, name]) => ({ id, name, state: bots.has(id) ? 'running' : 'stopped' })),
    core: (id) => bots.get(id)?.remote ?? null,
    atBotCap: () => false,
    createBot: async ({ name }) => {
      created.push(name);
      return 'new-bot';
    },
    startBlocked: () => null,
    startBot: async () => undefined,
    stopBot: async () => undefined,
    setHolder: async (id) => { holder.id = id; },
    confirm: async (_holder, question) => {
      asked.push(question);
      return answers.shift() ?? false;
    },
    log: () => undefined,
    now: () => new Date(clock.now),
  });
  coordinator = make();
  for (const [id, name] of Object.entries(names)) {
    const { core } = openTestBot({ botsHome: home.botsHome, id, profile: { name } });
    await core.start();
    // The channel names the calling bot; the hub never trusts the core's claim.
    const client = await HostChannelClient.connect(core.paths.root, {
      host: { pid: process.pid, executable: process.execPath, installationId: 'test' },
      services: { hub: (call) => coordinator.handle(id, call) },
    });
    bots.set(id, { core, client, remote: remoteBotCore(client) });
  }
  const stop = async () => {
    for (const bot of bots.values()) {
      bot.client.close();
      await bot.core.stop();
    }
  };
  return {
    holder, answers, asked, created, bots, names, stop, clock,
    get coordinator() { return coordinator; },
    reload() { coordinator = make(); return coordinator; },
    alpha: `${prefix}-alpha`, beta: `${prefix}-beta`, coordinatorHome,
  };
}

function completedIn(core: BotCore, predicate: (item: WorkItem) => boolean): Promise<WorkItem> {
  return new Promise((resolve) => {
    const off = core.subscribe((event: BotHostEvent) => {
      if (event.type === 'turn.completed' && predicate(event.workItem)) {
        off();
        resolve(event.workItem);
      }
    });
  });
}

const call = (tool: string, args: Record<string, unknown>, conversationId = 'home') => ({ tool, args, conversationId });

test('only the holder is answered, only the listed tools exist, and the role offers cats-hub (SPEC-009 FR-3, FR-6)', async () => {
  const f = await setUp('auth');
  try {
    const refused = await f.coordinator.handle(f.beta, call('hub_list_bots', {}));
    assert.equal(refused.isError, true);
    assert.match(refused.text, /does not hold the coordinator role/u);
    const listed = await f.coordinator.handle(f.alpha, call('hub_list_bots', {}));
    assert.equal(listed.isError, undefined);
    assert.deepEqual((listed.structuredContent?.bots as Array<{ id: string }>).map((bot) => bot.id), [f.alpha, f.beta]);
    for (const tool of ['hub_delete_bot', 'hub_respond_interaction', 'hub_set_policy', 'hub_assign_role']) {
      assert.match((await f.coordinator.handle(f.alpha, call(tool, { bot: f.beta }))).text, /no such tool/u, tool);
    }
    // FR-3: the core offers cats-hub only while the hub says it holds the role.
    const alpha = f.bots.get(f.alpha)!.core as unknown as { mcpServersFor(id: string, session: string | null): Array<{ name: string }> };
    assert.equal(alpha.mcpServersFor('home', null).some((server) => server.name === HUB_SERVER_NAME), false);
    await f.bots.get(f.alpha)!.remote.setCoordinator(true);
    assert.equal(alpha.mcpServersFor('home', null).some((server) => server.name === HUB_SERVER_NAME), true);
    // A call from a session that kept the descriptor after a transfer is still refused by the hub.
    f.holder.id = f.beta;
    assert.match((await f.coordinator.handle(f.alpha, call('hub_list_bots', {}))).text, /does not hold/u);
    const audit = readFileSync(join(f.coordinatorHome, 'logs', 'hub-audit.jsonl'), 'utf8');
    assert.match(audit, /"tool":"hub_list_bots"/u);
  } finally {
    await f.stop();
  }
});

test('a message reaches the other bot once, and its answer returns to the coordinator\'s conversation (FR-4, FR-7, FR-8, FR-12)', async () => {
  const f = await setUp('chain');
  try {
    const beta = f.bots.get(f.beta)!;
    const alpha = f.bots.get(f.alpha)!;
    const handed = completedIn(beta.core, (item) => item.source === 'bot');
    const sent = await f.coordinator.handle(f.alpha, call('hub_message_bot', { bot: f.beta, text: 'Please count to three.' }));
    assert.equal(sent.isError, undefined, sent.text);
    const chain = sent.structuredContent?.chain as string;
    assert.equal(sent.structuredContent?.hop, 1);
    const work = await handed;
    assert.equal(work.kind, 'event', 'background work, not an owner turn (FR-7)');
    assert.equal(work.chain?.from, f.alpha);
    // FR-6: it runs in the conversation beta keeps for alpha's messages, apart from the owner's.
    assert.equal(work.conversationId, `bot-${f.alpha}`);
    const betaTranscript = beta.core.transcript(`bot-${f.alpha}`) as TranscriptEntry[];
    assert.ok(betaTranscript.some((entry) => entry.origin === 'bot' && entry.from === 'Alpha' && entry.text === 'Please count to three.'));
    assert.equal((beta.core.transcript('home') as TranscriptEntry[]).length, 0, 'the owner\'s direct message holds none of it');

    const replied = completedIn(alpha.core, (item) => item.chain?.kind === 'reply');
    await f.coordinator.turnCompleted(f.beta, work);
    const reply = await replied;
    assert.equal(reply.chain?.hop, 2);
    assert.equal(reply.chain?.id, chain);
    assert.ok((alpha.core.transcript('home') as TranscriptEntry[]).some((entry) => entry.origin === 'bot' && entry.from === 'Beta'));

    // FR-12: a hub that starts again resends nothing twice and answers nothing twice.
    const again = f.reload();
    await again.attached(f.beta);
    await again.attached(f.alpha);
    await again.turnCompleted(f.beta, work);
    assert.equal(beta.core.listWorkItems().filter((item) => item.source === 'bot').length, 1);
    assert.equal(alpha.core.listWorkItems().filter((item) => item.source === 'bot').length, 1);
    // The same delivery admitted again is the same work item.
    const first = beta.core.listWorkItems().find((item) => item.source === 'bot')!;
    const repeated = beta.core.admitBotMessage({
      deliveryId: first.chain!.deliveryId, chainId: chain, hop: 1, kind: 'message', from: f.alpha, fromName: 'Alpha', text: 'x',
    });
    assert.equal(repeated.id, first.id);
  } finally {
    await f.stop();
  }
});

test('each message and each reply is a hop, messages per hour are limited, and only the holder continues its chains (FR-8)', async () => {
  const f = await setUp('limits', { hopsPerChain: 4, messagesPerHour: 3 });
  try {
    const message = (args: Record<string, unknown>): Promise<ToolAnswer> =>
      f.coordinator.handle(f.alpha, call('hub_message_bot', { bot: f.beta, text: 'hello', ...args }));
    const first = await message({});
    assert.equal(first.structuredContent?.hop, 1);
    const chain = first.structuredContent?.chain as string;
    // The first message's reply is hop 2, also while it is still on its way.
    assert.equal((await message({ chain })).structuredContent?.hop, 3, 'hop 3 leaves room for its reply');
    assert.match((await message({ chain })).text, /limit of 4 hops/u, 'a third message and its reply would make six');
    assert.match((await message({ chain: 'chain-unknown' })).text, /unknown/u);
    assert.equal((await message({})).isError, undefined);
    assert.match((await message({})).text, /3 messages in the last hour/u);
    assert.match((await f.coordinator.handle(f.alpha, call('hub_message_bot', { bot: f.alpha, text: 'me' }))).text, /other bots/u);
  } finally {
    await f.stop();
  }
});

test('creating a bot, starting a stopped one and passing the role wait for the owner (FR-5)', async () => {
  const f = await setUp('consent');
  try {
    f.answers.push(false);
    const declined = await f.coordinator.handle(f.alpha, call('hub_create_bot', { name: 'Gamma', persona: 'tidy', provider: 'claude' }));
    assert.match(declined.text, /declined/u);
    assert.deepEqual(f.created, []);
    // A declined request is not asked again at once.
    assert.match((await f.coordinator.handle(f.alpha, call('hub_create_bot', { name: 'Gamma', provider: 'claude' }))).text, /a moment ago/u);
    f.clock.now += 61_000;
    f.answers.push(true);
    assert.equal((await f.coordinator.handle(f.alpha, call('hub_create_bot', { name: 'Gamma', provider: 'claude' }))).isError, undefined);
    assert.deepEqual(f.created, ['Gamma']);
    assert.match((await f.coordinator.handle(f.alpha, call('hub_create_bot', { name: 'Delta', provider: 'not-a-cli' }))).text, /Choose one/u);
    f.answers.push(true);
    assert.equal((await f.coordinator.handle(f.alpha, call('hub_propose_transfer', { bot: f.beta }))).isError, undefined);
    assert.equal(f.holder.id, f.beta);
    assert.equal(f.asked.length, 3, 'every one of them asked the owner');
    // The former holder is refused at once.
    assert.match((await f.coordinator.handle(f.alpha, call('hub_list_bots', {}))).text, /does not hold/u);
    assert.ok(existsSync(join(f.coordinatorHome, 'logs', 'hub-audit.jsonl')));
  } finally {
    await f.stop();
  }
});

test('a message waiting in the conversation the owner deletes is answered as cancelled at once (FR-12, D29)', async () => {
  const { core } = openTestBot({
    botsHome: home.botsHome, id: 'deleted-beta', profile: { name: 'Beta' },
    core: { turnRetry: { ownerBusyMs: 200, backgroundBusyMs: 200, runtimeUnavailableMs: 200 } },
  });
  await core.start();
  try {
    const admitted: BotDelivery[] = [];
    const alpha = {
      admitBotMessage: async (delivery: BotDelivery) => {
        admitted.push(delivery);
        return { id: 'w' } as WorkItem;
      },
      botDeliveries: async () => [],
    } as unknown as RemoteBotCore;
    const beta = {
      admitBotMessage: async (delivery: BotDelivery) => core.admitBotMessage(delivery),
      botDeliveries: async (ids: string[]) => core.botDeliveries(ids),
    } as unknown as RemoteBotCore;
    const coordinator = new Coordinator({
      home: join(home.root, 'deleted'),
      holder: () => 'alpha',
      limits: () => ({ hopsPerChain: 4, messagesPerHour: 10 }),
      bots: () => [{ id: 'alpha', name: 'Alpha', state: 'running' }, { id: 'deleted-beta', name: 'Beta', state: 'running' }],
      core: (id) => (id === 'alpha' ? alpha : beta),
      atBotCap: () => false,
      createBot: async () => 'x',
      startBlocked: () => null,
      startBot: async () => undefined,
      stopBot: async () => undefined,
      setHolder: async () => undefined,
      confirm: async () => false,
      log: () => undefined,
    });
    // As the hub does: a finished turn answers the coordinator.
    const answered = new Promise<void>((resolve) => core.subscribe((event) => {
      if (event.type !== 'turn.completed') return;
      void coordinator.turnCompleted('deleted-beta', event.workItem).then(() => {
        if (admitted.length > 0) resolve();
      });
    }));
    // The owner keeps Beta busy, so Alpha's message waits in its queue.
    await core.sendOwnerMessage('home', 'slow:1500');
    assert.match((await coordinator.handle('alpha', call('hub_message_bot', { bot: 'deleted-beta', text: 'Summarize the notes.' }))).text, /Delivered to Beta/u);
    await core.deleteConversation('bot-alpha');
    await answered;
    assert.match(admitted[0]!.text, /ended cancelled \(conversation deleted\)/u);
  } finally {
    await core.stop();
  }
});
