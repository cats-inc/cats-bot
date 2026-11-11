import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { BotCore } from '../../src/core/bot.ts';
import { HostChannelClient } from '../../src/core/host-api/channel.ts';
import { remoteBotCore, type RemoteBotCore } from '../../src/core/host-api/remote.ts';
import type { BotHostEvent, BotWorkBoard, WorkItem } from '../../src/core/types.ts';
import { BossCatBroker, STATUS_CALLS_PER_HOUR } from '../../src/shell/electron/hub/bossCatBroker.ts';
import { PeerBoardsPusher } from '../../src/shell/electron/hub/peerBoards.ts';
import { makeTempHome, openTestBot, type TempHome, waitForEvent } from '../support/harness.ts';

/**
 * SPEC-012 FR-1 to FR-4, FR-10 and FR-12 with real cores on the fake runtime,
 * reached only through their host channels as the hub reaches them.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-boss-status-');
});
after(() => home.cleanup());

const MARKER = 'PRIVATE-NOTE-TEXT-41b2';

async function setUp(prefix: string) {
  const ids = { alpha: `${prefix}-alpha`, beta: `${prefix}-beta`, gamma: `${prefix}-gamma` };
  const names: Record<string, string> = { [ids.alpha]: 'Alpha', [ids.beta]: 'Beta', [ids.gamma]: 'Gamma' };
  const holder = { id: ids.alpha as string | null };
  const sees = new Map<string, boolean>();
  const cores = new Map<string, { core: BotCore; client: HostChannelClient; remote: RemoteBotCore }>();
  const clock = { now: Date.now() };
  const deps = {
    holder: () => holder.id,
    bots: () => Object.entries(names).map(([id, name]) => ({ id, name, state: cores.has(id) ? 'running' : 'stopped' })),
    core: (id: string) => cores.get(id)?.remote ?? null,
    sees: (id: string) => sees.get(id) ?? true,
  };
  const broker = new BossCatBroker({
    home: join(home.root, prefix), ...deps, limits: () => ({ hopsPerChain: 4, messagesPerHour: 10 }),
    atBotCap: () => false, setupNeeded: () => 'none', createBot: async () => ({ id: 'x' }), startBlocked: () => null,
    startBot: async () => undefined, stopBot: async () => undefined, setHolder: async () => undefined,
    confirm: async () => false, log: () => undefined, now: () => new Date(clock.now),
  });
  // Gamma stays stopped.
  for (const id of [ids.alpha, ids.beta]) {
    const { core } = openTestBot({ botsHome: home.botsHome, id, profile: { name: names[id]! } });
    await core.start();
    const client = await HostChannelClient.connect(core.paths.root, {
      host: { pid: process.pid, executable: process.execPath, installationId: 'test' },
      services: { hub: (call) => broker.handle(id, call) },
    });
    cores.set(id, { core, client, remote: remoteBotCore(client) });
  }
  cores.get(ids.alpha)!.core.setBossCat(true);
  const stop = async () => {
    for (const entry of cores.values()) {
      entry.client.close();
      await entry.core.stop();
    }
  };
  return { ids, names, holder, sees, cores, broker, deps, clock, stop };
}

function completed(core: BotCore, predicate: (item: WorkItem) => boolean): Promise<WorkItem> {
  return waitForEvent(core, (event: BotHostEvent) => event.type === 'turn.completed' && predicate(event.workItem))
    .then((event) => (event as Extract<BotHostEvent, { type: 'turn.completed' }>).workItem);
}

const statusCall = (args: Record<string, unknown> = {}) => ({ tool: 'hub_bot_status', args, conversationId: 'home' });

test('the Boss Cat reads the other bots\' boards: titles yes, messages never; a switch or a stopped bot shows only who it is (SPEC-012 FR-1 to FR-3, FR-12)', async () => {
  const fixture = await setUp('board');
  try {
    const beta = fixture.cores.get(fixture.ids.beta)!.core;
    const note = await beta.createConversation('Parser refactor');
    const done = completed(beta, (item) => item.conversationId === note.id);
    await beta.sendOwnerMessage(note.id, `${MARKER} please split the parser`);
    await done;

    const answer = await fixture.broker.handle(fixture.ids.alpha, statusCall());
    assert.equal(answer.isError, undefined, answer.text);
    assert.doesNotMatch(answer.text, new RegExp(MARKER, 'u'), 'no message text leaves a bot');
    assert.match(answer.text, /not instructions/u);
    const bots = (answer.structuredContent as { bots: Array<Record<string, unknown>> }).bots;
    assert.deepEqual(bots.map((bot) => bot.id), [fixture.ids.beta, fixture.ids.gamma], 'every other bot, never the caller');
    const betaBoard = bots[0] as unknown as BotWorkBoard & { state: string };
    assert.equal(betaBoard.state, 'running');
    assert.ok(betaBoard.notes.some((entry) => entry.title === 'Parser refactor'));
    assert.deepEqual(bots[1], { id: fixture.ids.gamma, name: 'Gamma', state: 'stopped' }, 'a stopped bot shows only who it is');

    fixture.sees.set(fixture.ids.beta, false);
    const hidden = await fixture.broker.handle(fixture.ids.alpha, statusCall({ bot: fixture.ids.beta }));
    assert.deepEqual((hidden.structuredContent as { bots: unknown[] }).bots, [
      { id: fixture.ids.beta, name: 'Beta', state: 'running', statusShared: false },
    ]);

    const refusedForOthers = await fixture.broker.handle(fixture.ids.beta, statusCall());
    assert.equal(refusedForOthers.isError, true, 'only the holder reads boards');
  } finally {
    await fixture.stop();
  }
});

test('board reads are limited per hour and are no hop (SPEC-012 FR-4)', async () => {
  const fixture = await setUp('limit');
  try {
    for (let index = 0; index < STATUS_CALLS_PER_HOUR; index += 1) {
      assert.equal((await fixture.broker.handle(fixture.ids.alpha, statusCall())).isError, undefined);
    }
    const refused = await fixture.broker.handle(fixture.ids.alpha, statusCall());
    assert.equal(refused.isError, true);
    assert.match(refused.text, /times an hour/u);
    fixture.clock.now += 60 * 60_000 + 1_000;
    assert.equal((await fixture.broker.handle(fixture.ids.alpha, statusCall())).isError, undefined, 'the window moves on');
  } finally {
    await fixture.stop();
  }
});

test('the hub pushes the other bots\' boards to the holder only, and its assist heartbeat reads them (SPEC-012 FR-10, FR-11)', async () => {
  const fixture = await setUp('push');
  try {
    const alpha = fixture.cores.get(fixture.ids.alpha)!;
    const beta = fixture.cores.get(fixture.ids.beta)!;
    // Beta's work that needs the owner: a question waiting for an answer.
    const note = await beta.core.createConversation('Taxes');
    (beta.core as unknown as { askOwner(id: string, q: string): WorkItem }).askOwner(note.id, 'Which year?');

    await alpha.core.updateProfile({ heartbeat: { mode: 'assist', wakeMinMinutes: 0, wakeMaxMinutes: 0, regularMinMinutes: 0, regularMaxMinutes: 0 } });
    const pusher = new PeerBoardsPusher({ ...fixture.deps, log: () => undefined });
    await pusher.push();

    const prompts: string[] = [];
    const off = alpha.core.subscribe((event) => {
      if (event.type === 'work.updated' && event.workItem.kind === 'heartbeat' && event.workItem.state === 'queued') prompts.push(event.workItem.prompt);
    });
    const first = await alpha.core.tick();
    assert.equal(first.heartbeat?.action, 'queued', 'another bot\'s waiting decision is worth a look');
    await completed(alpha.core, (item) => item.kind === 'heartbeat');
    off();
    assert.match(prompts[0] ?? '', /«Beta»: 1 decision waiting for the owner/u);
    assert.match(prompts[0] ?? '', /You cannot act for them in this heartbeat/u);

    await pusher.push();
    const second = await alpha.core.tick();
    assert.equal(second.heartbeat?.action, 'skipped_nothing_to_review', 'nothing changed since a quiet look');

    // The switch off: the next push leaves Beta out, and a bot that drops out is no news.
    fixture.sees.set(fixture.ids.beta, false);
    await pusher.push();
    const peers = (alpha.core as unknown as { peerBoards: { boards: BotWorkBoard[] } }).peerBoards.boards;
    assert.equal(peers.some((entry) => entry.id === fixture.ids.beta), false);
    assert.equal((await alpha.core.tick()).heartbeat?.action, 'skipped_nothing_to_review', 'a board that goes missing runs no turn');
    fixture.sees.set(fixture.ids.beta, true);
    await pusher.push();
    assert.equal((await alpha.core.tick()).heartbeat?.action, 'skipped_nothing_to_review', 'and coming back with the same picture runs none either');

    // An answered question is forgotten, so the next one is news again.
    const askOwner = (beta.core as unknown as { askOwner(id: string, q: string): WorkItem }).askOwner.bind(beta.core);
    const waiting = beta.core.listWorkItems().find((item) => item.state === 'awaiting_owner')!;
    const answered = completed(beta.core, (item) => item.kind === 'owner_message' && item.conversationId === note.id);
    await beta.core.resolveApproval(waiting.id, 'deny');
    await answered;
    await pusher.push();
    assert.equal((await alpha.core.tick()).heartbeat?.action, 'skipped_nothing_to_review', 'fewer decisions are no news');
    askOwner(note.id, 'Which month?');
    await pusher.push();
    const again = completed(alpha.core, (item) => item.kind === 'heartbeat');
    assert.equal((await alpha.core.tick()).heartbeat?.action, 'queued', 'a new question after an answered one is news');
    await again;

    // A bot that does not hold the role keeps no boards.
    await beta.remote.setPeerBoards([await alpha.remote.workStatus()]);
    assert.equal((beta.core as unknown as { peerBoards: unknown }).peerBoards, null);
    // Losing the role clears them.
    alpha.core.setBossCat(false);
    assert.equal((alpha.core as unknown as { peerBoards: unknown }).peerBoards, null);
  } finally {
    await fixture.stop();
  }
});

test('a heartbeat, a reminder it sets at any depth, and a late call cannot use the hub tools (SPEC-012 FR-10)', async () => {
  const fixture = await setUp('quiet');
  try {
    const core = fixture.cores.get(fixture.ids.alpha)!.core;
    const alpha = core as unknown as {
      running: unknown;
      callHub(call: { tool: string; args: Record<string, unknown>; conversationId: string }): Promise<{ text: string; isError?: boolean }>;
    };
    const homeId = (await core.listConversations()).find((entry) => entry.role === 'home')!.id;
    const note = await core.createConversation('Elsewhere');
    const turn = (item: Record<string, unknown>, controller = new AbortController()) => {
      alpha.running = { item: { conversationId: homeId, ...item }, controller };
    };
    const list = () => alpha.callHub({ tool: 'hub_list_bots', args: {}, conversationId: 'home' });
    const reminder = (createdBy: 'agent' | 'owner') => core.createSchedule({ conversationId: 'home', kind: 'once',
      at: new Date(Date.now() + 3_600_000), prompt: 'ask Beta to continue', createdBy } as Parameters<BotCore['createSchedule']>[0]);

    turn({ kind: 'heartbeat', id: 'w-heartbeat' });
    const refused = await list();
    assert.equal(refused.isError, true);
    assert.match(refused.text, /not available during a heartbeat/u);
    // A reminder the heartbeat sets cannot reach the hub later, nor one that reminder sets.
    const first = reminder('agent');
    assert.equal(first.fromHeartbeat, true);
    // The owner's reminder, made while a heartbeat runs, is the owner's.
    assert.equal(reminder('owner').fromHeartbeat, undefined);
    turn({ kind: 'schedule', id: 'w-schedule', source: first.id });
    assert.equal((await list()).isError, true);
    const second = reminder('agent');
    assert.equal(second.fromHeartbeat, true, 'the mark is inherited');

    const ownersReminder = reminder('owner');
    turn({ kind: 'schedule', id: 'w-schedule-2', source: ownersReminder.id });
    assert.equal((await list()).isError, undefined, 'other reminders keep the tools');
    assert.equal(reminder('agent').fromHeartbeat, undefined, 'and what they set is not marked');

    turn({ kind: 'owner_message', source: 'owner', id: 'w-owner' });
    const allowed = await list();
    assert.equal(allowed.isError, undefined, allowed.text);
    // A late call: no turn, a turn in another conversation, or a cancelled one.
    alpha.running = null;
    assert.match((await list()).text, /this turn has ended/u);
    assert.equal(reminder('agent').fromHeartbeat, true, 'an agent call with no live turn is taken as the heartbeat\'s');
    turn({ kind: 'owner_message', source: 'owner', id: 'w-other', conversationId: note.id });
    assert.equal((await list()).isError, true);
    const cancelled = new AbortController();
    cancelled.abort();
    turn({ kind: 'owner_message', source: 'owner', id: 'w-cancelled' }, cancelled);
    assert.equal((await list()).isError, true);
    alpha.running = null;
  } finally {
    await fixture.stop();
  }
});

test('the hub checks a board belongs to the bot it asked, and that the caller still holds the role (SPEC-012 FR-10, FR-12)', async () => {
  const fixture = await setUp('forged');
  try {
    const alpha = fixture.cores.get(fixture.ids.alpha)!;
    const beta = fixture.cores.get(fixture.ids.beta)!;
    const betaBoard = await beta.remote.workStatus();
    // Gamma's core claims to be Beta, whom the owner keeps from the Boss Cat.
    fixture.sees.set(fixture.ids.beta, false);
    const forger = { workStatus: async () => ({ ...betaBoard, name: 'Not Gamma' }) } as unknown as RemoteBotCore;
    const pusher = new PeerBoardsPusher({
      ...fixture.deps,
      bots: () => fixture.deps.bots().map((bot) => (bot.id === fixture.ids.gamma ? { ...bot, state: 'running' } : bot)),
      core: (id) => (id === fixture.ids.gamma ? forger : fixture.deps.core(id)),
      log: () => undefined,
    });
    await pusher.push();
    const peers = (alpha.core as unknown as { peerBoards: { boards: BotWorkBoard[] } }).peerBoards.boards;
    assert.deepEqual(peers, [], 'a board that names another bot is dropped');

    fixture.sees.set(fixture.ids.beta, true);
    await pusher.push();
    const named = (alpha.core as unknown as { peerBoards: { boards: BotWorkBoard[] } }).peerBoards.boards;
    assert.deepEqual(named.map((board) => [board.id, board.name]), [[fixture.ids.beta, 'Beta']], 'the hub\'s name, not the core\'s');

    // The role moves while the boards are read: the answer does not go to the former holder.
    const real = beta.remote;
    beta.remote = { workStatus: async () => {
      fixture.holder.id = fixture.ids.beta;
      return betaBoard;
    } } as unknown as RemoteBotCore;
    const moved = await fixture.broker.handle(fixture.ids.alpha, statusCall({ bot: fixture.ids.beta }));
    beta.remote = real;
    assert.equal(moved.isError, true);
    assert.match(moved.text, /no longer holds/u);
  } finally {
    await fixture.stop();
  }
});
