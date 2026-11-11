import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationStore, TRANSCRIPT_PAGE_MAX } from '../../src/core/conversations/store.ts';
import { runCoreCommand, type CoreCommandTarget } from '../../src/core/host-api/commands.ts';
import { botPathsFor, stateDatabaseFile } from '../../src/core/store/paths.ts';
import { sqliteDriver } from '../../src/core/store/sqliteDriver.ts';
import type { BotStateStore } from '../../src/core/store/stateStore.ts';
import type { TranscriptEntry, TranscriptPage } from '../../src/core/types.ts';
import { makeTempHome, openTestBot, sendAndWait, waitForEvent } from '../support/harness.ts';
import { openTestStateStore } from '../support/stateData.ts';

/**
 * SPEC-014 FR-10: the note reads a conversation a page at a time. Every page projects the
 * reply presentations as the whole transcript does, so the pages read back to the start are
 * the whole conversation as `conversationTranscript` shows it.
 */

const AT = '2026-11-12T08:00:00.000Z';

function reply(
  workItemId: string,
  seq: number,
  covers: number[],
  text: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    seq,
    at: AT,
    kind: 'bot',
    origin: 'owner',
    text,
    workItemId,
    presentationRevision: 1,
    presentationSeqs: covers,
    presentation: {
      version: 1,
      id: `${workItemId}:execution`,
      phase: 'sealed',
      blocks: [
        {
          id: `${workItemId}:0`,
          index: 0,
          kind: 'text',
          status: 'complete',
          text,
          title: null,
          toolName: null,
          toolId: null,
        },
      ],
    },
    ...extra,
  };
}

/**
 * A conversation with every shape a page boundary can cut: a reply bound to its final entry,
 * one cancelled before it had one, one whose saved presentation predates its final entry,
 * a plain reply, and one still streaming.
 */
function conversationOfEveryShape(t: { after(fn: () => void): void }): {
  conversations: ConversationStore;
  id: string;
  db: BotStateStore;
  file: string;
} {
  const home = makeTempHome('cats-bot-paging-');
  const db = openTestStateStore(botPathsFor(home.botsHome), t);
  // After the store is closed: the hooks run in the order they were added.
  t.after(() => home.cleanup());
  const conversations = new ConversationStore({ store: () => db, now: () => new Date(AT) });
  conversations.load();
  const { id } = conversations.home();
  const add = (kind: TranscriptEntry['kind'], text: string, workItemId?: string) =>
    conversations.append(id, { kind, text, origin: 'owner', ...(workItemId ? { workItemId } : {}) })
      .seq;

  // Bound: tool lines and the final reply are covered.
  add('owner', 'q1', 'w1');
  const w1 = [
    add('tool_use', 'Read a', 'w1'),
    add('tool_result', 'a', 'w1'),
    add('progress', '…', 'w1'),
  ];
  const a1 = add('bot', 'a1', 'w1');
  conversations.savePresentation(
    id,
    reply('w1', w1[0]!, w1, 'a1', { presentationTerminalSeq: a1 }),
  );
  // Cancelled: no final reply, nothing after it of its work item.
  add('owner', 'q2', 'w2');
  const w2 = [add('tool_use', 'Read b', 'w2'), add('error', 'cancelled', 'w2')];
  conversations.savePresentation(id, reply('w2', w2[0]!, w2, 'partial'));
  // Saved before it was finished: its final reply comes after it, unbound.
  add('owner', 'q3', 'w3');
  const w3 = [add('tool_use', 'Read c', 'w3')];
  add('tool_result', 'c', 'w3');
  conversations.savePresentation(id, reply('w3', w3[0]!, w3, 'half of a3'));
  add('bot', 'a3', 'w3');
  // Plain.
  add('owner', 'q4', 'w4');
  add('system', 'note', 'w4');
  add('bot', 'a4', 'w4');
  // Streaming.
  add('owner', 'q5', 'w5');
  const w5 = [add('tool_use', 'Read d', 'w5')];
  conversations.savePresentation(
    id,
    reply('w5', w5[0]!, w5, 'so far', {
      presentation: { ...reply('w5', 0, [], 'so far').presentation!, phase: 'streaming' },
    }),
  );
  return { conversations, id, db, file: stateDatabaseFile(botPathsFor(home.botsHome)) };
}

function readAllPages(read: (beforeSeq?: number) => TranscriptPage): {
  entries: TranscriptEntry[];
  pages: number;
} {
  const pages: TranscriptPage[] = [];
  let beforeSeq: number | undefined;
  for (;;) {
    const page = read(beforeSeq);
    pages.push(page);
    if (page.olderBeforeSeq === null) break;
    assert.ok(beforeSeq === undefined || page.olderBeforeSeq < beforeSeq, 'pages go back');
    beforeSeq = page.olderBeforeSeq;
  }
  return { entries: pages.reverse().flatMap((page) => page.entries), pages: pages.length };
}

test('pages of any size read back to the start are the whole conversation as the note shows it', (t) => {
  const { conversations, id } = conversationOfEveryShape(t);
  for (const running of ['w5', undefined]) {
    const whole = conversations.presentationTranscript(id, running);
    // The cancelled reply and the bound one are shown; the one saved before its end is not.
    assert.deepEqual(
      whole.filter((entry) => entry.presentation).map((entry) => entry.workItemId),
      ['w1', 'w2', 'w5'],
    );
    for (let limit = 1; limit <= 24; limit += 1) {
      const read = readAllPages((beforeSeq) =>
        conversations.presentationPage(id, { limit, beforeSeq }, running),
      );
      assert.deepEqual(read.entries, whole, `limit ${limit}, running ${String(running)}`);
    }
  }
  // The streaming reply stays streaming only while its work item runs.
  const newest = conversations.presentationPage(id, { limit: 2 }, 'w5');
  assert.equal(newest.entries.at(-1)!.presentation!.phase, 'streaming');
  assert.equal(
    conversations.presentationPage(id, { limit: 2 }).entries.at(-1)!.presentation!.phase,
    'sealed',
  );
});

test('a page reaches back to the start of a presentation that covers its first entry', (t) => {
  const { conversations, id } = conversationOfEveryShape(t);
  const whole = conversations.transcript(id);
  // The final reply of w1 alone, as a limit of one before the next owner line would give it.
  const q2 = whole.find((entry) => entry.text === 'q2')!.seq;
  const page = conversations.presentationPage(id, { limit: 1, beforeSeq: q2 });
  assert.deepEqual(
    page.entries.map((entry) => [entry.seq, entry.kind, entry.presentation ? 'shown' : 'raw']),
    [[2, 'bot', 'shown']],
  );
  assert.equal(page.olderBeforeSeq, 2);
  const start = conversations.presentationPage(id, { limit: 5, beforeSeq: 2 });
  assert.deepEqual(
    start.entries.map((entry) => entry.text),
    ['q1'],
  );
  assert.equal(start.olderBeforeSeq, null);
  assert.deepEqual(conversations.presentationPage(id, { limit: 5, beforeSeq: 1 }), {
    entries: [],
    olderBeforeSeq: null,
  });
  assert.throws(
    () => conversations.presentationPage('nobody', { limit: 5 }),
    /Unknown conversation/u,
  );
});

test('the core reads a page of the note: newest, before a seq, bounded, and while a reply streams', async () => {
  const home = makeTempHome('cats-bot-paging-core-');
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'paging' });
  try {
    await core.start();
    await sendAndWait(core, 'home', 'tool please');
    await sendAndWait(core, 'home', 'tool again');
    const view = core.conversationTranscript('home');
    const all = readAllPages((beforeSeq) =>
      core.conversationTranscriptPage('home', { limit: 2, ...(beforeSeq ? { beforeSeq } : {}) }),
    );
    assert.deepEqual(all.entries, view);
    assert.ok(all.pages >= 2);
    assert.deepEqual(core.conversationTranscriptPage('home'), {
      entries: view,
      olderBeforeSeq: null,
    });
    // Out-of-range sizes are brought inside the bounds.
    assert.equal(core.conversationTranscriptPage('home', { limit: 0 }).entries.length, 1);
    assert.deepEqual(core.conversationTranscriptPage('home', { limit: 10_000 }).entries, view);
    assert.throws(() => core.conversationTranscriptPage('nobody'), /Unknown conversation/u);

    // A page read while a reply streams shows it streaming, and the reply sealed after it ends.
    const started = waitForEvent(
      core,
      (event) => event.type === 'turn.presentation' && event.entry.text === 'partial',
    );
    const done = waitForEvent(core, (event) => event.type === 'turn.completed');
    await core.sendOwnerMessage('home', 'partial-slow');
    await started;
    const streaming = core.conversationTranscriptPage('home', { limit: 3 }).entries.at(-1)!;
    assert.equal(streaming.presentation?.phase, 'streaming');
    await core.cancelTurn('home');
    await done;
    const sealed = core
      .conversationTranscriptPage('home', { limit: 3 })
      .entries.filter((entry) => entry.presentation)
      .at(-1)!;
    assert.equal(sealed.presentation!.phase, 'sealed');
    assert.equal(sealed.text, 'partial');
  } finally {
    await core.stop();
    home.cleanup();
  }
});

test('a page larger than its budget is read again with fewer entries, down to one', async () => {
  const home = makeTempHome('cats-bot-paging-budget-');
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'paging-budget' });
  try {
    await core.start();
    const big = 'x'.repeat(400 * 1024);
    for (let index = 0; index < 4; index += 1) await sendAndWait(core, 'home', `${index} ${big}`);
    const page = core.conversationTranscriptPage('home', { limit: 100 });
    const bytes = Buffer.byteLength(JSON.stringify(page.entries));
    assert.ok(bytes <= 1024 * 1024, `${bytes} bytes`);
    assert.ok(page.entries.length >= 1 && page.olderBeforeSeq !== null);
    const all = readAllPages((beforeSeq) =>
      core.conversationTranscriptPage('home', { limit: 100, ...(beforeSeq ? { beforeSeq } : {}) }),
    );
    assert.deepEqual(all.entries, core.conversationTranscript('home'));
  } finally {
    await core.stop();
    home.cleanup();
  }
});

test('the host command checks the page it is asked for', async () => {
  const asked: unknown[] = [];
  const target = {
    conversationTranscriptPage: (id: string, request: unknown) => {
      asked.push([id, request]);
      return { entries: [], olderBeforeSeq: null };
    },
  } as unknown as CoreCommandTarget;
  await runCoreCommand(target, 'conversationTranscriptPage', ['home']);
  await runCoreCommand(target, 'conversationTranscriptPage', ['home', { limit: 50, beforeSeq: 9 }]);
  await runCoreCommand(target, 'conversationTranscriptPage', [
    'home',
    { limit: TRANSCRIPT_PAGE_MAX },
  ]);
  assert.deepEqual(asked, [
    ['home', {}],
    ['home', { limit: 50, beforeSeq: 9 }],
    ['home', { limit: TRANSCRIPT_PAGE_MAX }],
  ]);
  for (const page of [
    { limit: 0 },
    { limit: TRANSCRIPT_PAGE_MAX + 1 },
    { limit: 1.5 },
    { beforeSeq: '9' },
    { beforeSeq: -1 },
    [1],
    'newest',
  ]) {
    await assert.rejects(
      runCoreCommand(target, 'conversationTranscriptPage', ['home', page]),
      /must be/u,
      JSON.stringify(page),
    );
  }
  await assert.rejects(runCoreCommand(target, 'conversationTranscriptPage', []), /conversationId/u);
});

test('the store finds which work items have a bot entry from a seq on, past one it cannot read', (t) => {
  const { conversations, id, db, file } = conversationOfEveryShape(t);
  const a3 = conversations.transcript(id).find((entry) => entry.text === 'a3')!.seq;
  const found = (from: number, ids: string[]) =>
    [...db.workItemsWithBotEntryFrom(id, from, ids)].sort();
  assert.deepEqual(found(1, ['w1', 'w2', 'w3', 'w4', 'w5']), ['w1', 'w3', 'w4']);
  assert.deepEqual(found(a3, ['w1', 'w3']), ['w3']);
  assert.deepEqual(found(a3 + 1, ['w3']), []);
  assert.deepEqual(found(1, []), []);
  assert.deepEqual([...db.workItemsWithBotEntryFrom('nobody', 1, ['w1'])], []);
  // A record that is no longer JSON is passed over, not an error.
  const { DatabaseSync } = sqliteDriver();
  const raw = new DatabaseSync(file);
  try {
    raw.exec(`update entries set json = 'not json' where seq = ${a3}`);
  } finally {
    raw.close();
  }
  assert.deepEqual(found(1, ['w1', 'w3']), ['w1']);
});
