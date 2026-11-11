import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConversationStore,
  newestWithinBudget,
  TRANSCRIPT_PAGE_MAX,
} from '../../src/core/conversations/store.ts';
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

test('the core keeps a page within its budget, and reads every page back to the start', async () => {
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

test('the store answers a page by index: its window, the reach, its presentations and later bot entries', (t) => {
  const { conversations, id, db, file } = conversationOfEveryShape(t);
  const seqOf = (text: string) =>
    conversations.transcript(id).find((entry) => entry.text === text)!.seq;
  const a3 = seqOf('a3');
  assert.equal(db.hasBotEntryOf(id, 'w3', 1), true);
  assert.equal(db.hasBotEntryOf(id, 'w3', a3), true);
  assert.equal(db.hasBotEntryOf(id, 'w3', a3 + 1), false);
  assert.equal(db.hasBotEntryOf(id, 'w2', 1), false, 'a cancelled reply wrote no bot entry');
  assert.equal(db.hasBotEntryOf('nobody', 'w1', 1), false);
  // w1's presentation starts at 2 and covers up to its final entry.
  const a1 = seqOf('a1');
  assert.equal(db.presentationReach(id, a1), 2);
  assert.equal(db.presentationReach(id, 2), null);
  assert.equal(db.presentationReach(id, seqOf('q2')), null);
  assert.deepEqual(
    db.responsesBetween(id, 2, seqOf('q3')).map((raw) => (raw as TranscriptEntry).workItemId),
    ['w1', 'w2'],
  );
  assert.deepEqual(
    db.responsesBetween(id, seqOf('q5')).map((raw) => (raw as TranscriptEntry).workItemId),
    ['w5'],
  );
  assert.deepEqual(
    db.entriesBetween(id, 1, 3).map((entry) => entry.seq),
    [1, 2],
  );
  assert.equal(db.hasEntryBefore(id, 1), false);
  assert.equal(db.hasEntryBefore(id, 2), true);

  const { DatabaseSync } = sqliteDriver();
  const raw = new DatabaseSync(file);
  const q4 = seqOf('q4');
  try {
    // A bot entry that is no longer JSON is written, and passed over, not an error.
    raw.exec(`update entries set json = 'not json' where seq = ${a3}`);
    // S5: a record that lost its own seq still has its row's.
    raw.exec(
      `update entries set json = '{"kind":"owner","origin":"owner","text":"no seq"}' where seq = ${q4}`,
    );
  } finally {
    raw.close();
  }
  assert.equal(db.hasBotEntryOf(id, 'w3', 1), false);
  const window = db.entriesWindow(id, { limit: 3, beforeSeq: seqOf('q5') });
  assert.equal(window.firstSeq, q4);
  assert.deepEqual(
    window.entries.map((entry) => entry.text),
    ['no seq', 'note', 'a4'],
  );
  const page = conversations.presentationPage(id, { limit: 3, beforeSeq: seqOf('q5') });
  assert.equal(page.olderBeforeSeq, q4);
});

test('a page over its budget keeps its newest part, cut where no shown presentation is parted', (t) => {
  const { conversations, id } = conversationOfEveryShape(t);
  for (const running of ['w5', undefined]) {
    const whole = conversations.presentationTranscript(id, running);
    const largest = Math.max(...whole.map((entry) => Buffer.byteLength(JSON.stringify(entry))));
    for (const budget of [1, 200, 400, 700, 1200, 2500, largest * 3]) {
      for (const limit of [1, 3, 7, 24]) {
        const read = readAllPages((beforeSeq) =>
          conversations.presentationPage(id, { limit, beforeSeq }, running, budget),
        );
        assert.deepEqual(read.entries, whole, `budget ${budget}, limit ${limit}`);
      }
    }
  }
  // Each page within its budget, unless one part that cannot be cut is larger.
  const page = conversations.presentationPage(id, { limit: 24 }, 'w5', 700);
  assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) <= 700 || page.entries.length <= 2);
  assert.notEqual(page.olderBeforeSeq, null);
});

test('the cut keeps every entry of a seq and the whole span of a shown presentation', () => {
  const sized = (
    seq: number,
    bytes: number,
    extra: Partial<TranscriptEntry> = {},
  ): TranscriptEntry => ({
    seq,
    at: AT,
    kind: 'owner',
    origin: 'owner',
    text: 'x'.repeat(bytes),
    ...extra,
  });
  const shown = reply('w', 3, [3, 4], 'shown', { presentationTerminalSeq: 6 });
  const page = [sized(1, 100), sized(2, 100), shown, sized(5, 100), sized(7, 100), sized(7, 100)];
  const size = (entries: readonly TranscriptEntry[]) =>
    entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1, 1);
  assert.deepEqual(newestWithinBudget(page, size(page)), { entries: page, cut: null });
  // The two entries of seq 7 stay together; seq 5 lies in the span of the reply at 3.
  assert.deepEqual(newestWithinBudget(page, size(page.slice(4))), {
    entries: page.slice(4),
    cut: 7,
  });
  assert.deepEqual(newestWithinBudget(page, size(page.slice(3))), {
    entries: page.slice(4),
    cut: 7,
  });
  assert.deepEqual(newestWithinBudget(page, size(page.slice(2))), {
    entries: page.slice(2),
    cut: 3,
  });
  // Over the budget even at its newest part: that part, whatever its size.
  assert.deepEqual(newestWithinBudget(page, 1), { entries: page.slice(4), cut: 7 });
  const one = [shown, sized(5, 100)];
  assert.deepEqual(newestWithinBudget(one, 1), { entries: one, cut: null });
});

test('a presentation larger than the budget is read once and is the whole page', (t) => {
  const { conversations, id, db } = conversationOfEveryShape(t);
  const tools = Array.from(
    { length: 300 },
    (_, index) =>
      conversations.append(id, {
        kind: 'tool_use',
        text: 'y'.repeat(4000),
        origin: 'owner',
        workItemId: 'w-long',
      }).seq,
  );
  const final = conversations.append(id, {
    kind: 'bot',
    text: 'done',
    origin: 'owner',
    workItemId: 'w-long',
  }).seq;
  conversations.savePresentation(
    id,
    reply('w-long', tools[0]!, tools, 'done', {
      presentationTerminalSeq: final,
      presentation: {
        ...reply('w-long', 0, [], 'done').presentation!,
        blocks: tools.map((seq, index) => ({
          id: `w-long:${index}`,
          index,
          kind: 'tool' as const,
          status: 'complete' as const,
          text: 'y'.repeat(4000),
          title: null,
          toolName: 'Read',
          toolId: String(seq),
        })),
      },
    }),
  );
  let windows = 0;
  const window = db.entriesWindow.bind(db);
  (db as { entriesWindow: typeof db.entriesWindow }).entriesWindow = (...args) => {
    windows += 1;
    return window(...args);
  };
  const page = conversations.presentationPage(id, { limit: 100 }, undefined, 1024 * 1024);
  assert.equal(windows, 1);
  assert.deepEqual(
    page.entries.map((entry) => (entry.presentation ? `reply ${entry.workItemId}` : entry.kind)),
    ['reply w-long'],
  );
  assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) > 1024 * 1024);
  assert.equal(page.olderBeforeSeq, tools[0]);
});
