import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { sqliteDriver } from '../../src/core/store/sqliteDriver.ts';
import { StateDatabaseError } from '../../src/core/store/stateDatabase.ts';
import { openBotStateStore, type BotStateStore } from '../../src/core/store/stateStore.ts';
import type {
  ConversationRecord,
  ScheduleRecord,
  TranscriptEntry,
  WorkItem,
} from '../../src/core/types.ts';

/**
 * PLAN-014 tasks 1.2 and 1.3, SPEC-014 FR-3 and FR-5 to FR-10: a bot's records in its state
 * database. Nothing in the core uses this store yet. The file also runs inside Electron in
 * CI (`npm run test:electron`).
 */

const scratch = mkdtempSync(join(tmpdir(), 'cats bot 紀錄 '));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

let directories = 0;
function freshFile(): string {
  directories += 1;
  const directory = join(scratch, `case ${directories}`);
  mkdirSync(directory);
  return join(directory, 'bot.db');
}

function withStore<T>(
  file: string,
  mode: 'writer' | 'reader',
  work: (store: BotStateStore) => T,
): T {
  const store = openBotStateStore({ file, mode });
  try {
    return work(store);
  } finally {
    store.close();
  }
}

const AT = '2026-11-11T08:00:00.000Z';
const NUL = String.fromCharCode(0);

function conversation(id: string, extra: Record<string, unknown> = {}): ConversationRecord {
  return {
    schemaVersion: 1,
    id,
    role: id === 'home' ? 'home' : 'note',
    title: id,
    createdAt: AT,
    updatedAt: AT,
    attachment: {
      state: 'none',
      sessionId: null,
      providerSessionId: null,
      provider: null,
      model: null,
      configRevision: null,
      updatedAt: AT,
    },
    unreadCount: 0,
    lastOwnerMessageAt: null,
    lastBotMessageAt: null,
    checkpoint: null,
    contactOf: null,
    contactName: null,
    ...extra,
  };
}

function entry(text: string, extra: Partial<TranscriptEntry> = {}): Omit<TranscriptEntry, 'seq'> {
  return { at: AT, kind: 'owner', origin: 'owner', text, ...extra };
}

function workItem(
  id: string,
  conversationId: string,
  state: WorkItem['state'],
  extra: Partial<WorkItem> = {},
): WorkItem {
  return {
    id,
    kind: 'owner_message',
    source: 'note',
    conversationId,
    prompt: `prompt of ${id}`,
    createdAt: AT,
    admittedAt: null,
    configRevision: 1,
    state,
    attempts: 0,
    updatedAt: AT,
    ...extra,
  };
}

function schedule(
  id: string,
  conversationId: string,
  state: ScheduleRecord['state'],
): ScheduleRecord {
  return {
    id,
    conversationId,
    kind: 'once',
    at: '2026-12-01T00:00:00.000Z',
    timezone: 'Asia/Taipei',
    prompt: 'water the plants',
    missedPolicy: 'run_once',
    graceMinutes: 30,
    createdBy: 'owner',
    receipt: 'r-1',
    state,
    createdAt: AT,
    lastFiredAt: null,
    nextAt: state === 'active' ? '2026-12-01T00:00:00.000Z' : null,
  };
}

function hits(store: BotStateStore, query: string, conversationId?: string): string[] {
  return store
    .search(query, conversationId === undefined ? {} : { conversationId })
    .map((hit) => `${hit.conversationId}#${hit.entry.seq}`)
    .sort();
}

function count(file: string, table: string): number {
  const { DatabaseSync } = sqliteDriver();
  const database = new DatabaseSync(file);
  try {
    return Number(database.prepare(`select count(*) as n from ${table}`).get()?.n);
  } finally {
    database.close();
  }
}

test('a conversation record is stored whole, replaced in place and read back as it was given', () => {
  const file = freshFile();
  withStore(file, 'writer', (store) => {
    assert.deepEqual(store.conversations(), []);
    const home = conversation('home', {
      futureField: { kept: true },
      title: `emoji ${String.fromCodePoint(0x1f431)} and${NUL}nul`,
    });
    store.saveConversation(home);
    store.saveConversation(conversation('note-1'));
    store.saveConversation({
      ...conversation('note-1'),
      title: 'renamed',
      updatedAt: '2026-11-12T00:00:00.000Z',
    });
    const stored = store.conversations() as ConversationRecord[];
    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.find((record) => record.id === 'home'),
      home,
    );
    assert.equal(stored.find((record) => record.id === 'note-1')?.title, 'renamed');
  });
  // And after the bot stops.
  withStore(file, 'writer', (store) => {
    assert.equal(store.conversations().length, 2);
  });
});

test('an entry gets the next seq of its conversation and comes back exactly', () => {
  const file = freshFile();
  const awkward = `before${NUL}after ${String.fromCharCode(0xd83d)} lone, "quoted" \\ and\r\nlines`;
  withStore(file, 'writer', (store) => {
    store.saveConversation(conversation('home'));
    store.saveConversation(conversation('note-1'));
    const first = store.appendEntry('home', entry('first'));
    assert.deepEqual(first, { at: AT, kind: 'owner', origin: 'owner', text: 'first', seq: 1 });
    const tool = store.appendEntry(
      'home',
      entry(awkward, {
        kind: 'tool_result',
        origin: 'system',
        workItemId: 'w1',
        toolName: 'read',
        toolId: 't1',
        isError: true,
      }),
    );
    assert.equal(tool.seq, 2);
    assert.equal(store.appendEntry('note-1', entry('elsewhere')).seq, 1);
    // A field this version does not know stays with the entry.
    const future = store.appendEntry('home', { ...entry('third'), futureField: [1, 2] } as Omit<
      TranscriptEntry,
      'seq'
    >);
    assert.equal(future.seq, 3);

    const transcript = store.entries('home');
    assert.deepEqual(
      transcript.map((item) => item.seq),
      [1, 2, 3],
    );
    assert.deepEqual(transcript[1], tool);
    assert.equal(transcript[1]?.text, awkward);
    assert.deepEqual(
      (transcript[2] as TranscriptEntry & { futureField?: unknown }).futureField,
      [1, 2],
    );
    assert.deepEqual(store.entries('nobody'), []);
  });
  // The numbering carries on after a restart.
  withStore(file, 'writer', (store) => {
    assert.equal(store.appendEntry('home', entry('fourth')).seq, 4);
    assert.equal(store.appendEntry('note-1', entry('again')).seq, 2);
  });
});

test('a page is the newest entries, or the ones before a seq, in order', () => {
  withStore(freshFile(), 'writer', (store) => {
    store.saveConversation(conversation('home'));
    for (let index = 1; index <= 7; index += 1) store.appendEntry('home', entry(`entry ${index}`));
    const seqs = (entries: TranscriptEntry[]): number[] => entries.map((item) => item.seq);

    assert.deepEqual(seqs(store.entriesPage('home', { limit: 3 })), [5, 6, 7]);
    assert.deepEqual(seqs(store.entriesPage('home', { limit: 3, beforeSeq: 5 })), [2, 3, 4]);
    assert.deepEqual(seqs(store.entriesPage('home', { limit: 3, beforeSeq: 2 })), [1]);
    assert.deepEqual(seqs(store.entriesPage('home', { limit: 3, beforeSeq: 1 })), []);
    assert.deepEqual(seqs(store.entriesPage('home', { limit: 50 })), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(store.entriesPage('nobody', { limit: 3 }), []);
    assert.throws(() => store.entriesPage('home', { limit: 0 }), RangeError);
    assert.throws(() => store.entriesPage('home', { limit: 1.5 }), RangeError);
  });
});

test('a reply presentation is one row, replaced at each checkpoint', () => {
  withStore(freshFile(), 'writer', (store) => {
    const reply = (id: string, seq: number, revision: number, text: string): TranscriptEntry =>
      ({
        seq,
        at: AT,
        kind: 'bot',
        origin: 'owner',
        text,
        workItemId: 'w1',
        presentation: { version: 1, id, phase: revision > 1 ? 'sealed' : 'streaming', blocks: [] },
        presentationRevision: revision,
        presentationSeqs: [seq],
      }) as unknown as TranscriptEntry;
    store.saveResponse('home', reply('p2', 9, 1, 'second reply'));
    store.saveResponse('home', reply('p1', 4, 1, 'first rep'));
    store.saveResponse('home', reply('p1', 4, 2, 'first reply, finished'));
    store.saveResponse('note-1', reply('p1', 2, 1, 'another conversation'));

    const stored = store.responses('home');
    assert.deepEqual(
      stored.map((item) => [item.seq, item.text, item.presentationRevision]),
      [
        [4, 'first reply, finished', 2],
        [9, 'second reply', 1],
      ],
    );
    assert.deepEqual(stored[0], reply('p1', 4, 2, 'first reply, finished'));
    assert.equal(store.responses('note-1').length, 1);
    assert.throws(
      () => store.saveResponse('home', { ...reply('p3', 1, 1, 'x'), presentation: undefined }),
      /needs an id/u,
    );
  });
});

test('a work item has one current row and every transition; schedules and events are kept', () => {
  const file = freshFile();
  withStore(file, 'writer', (store) => {
    const queued = workItem('w1', 'home', 'queued', { sourceRef: 'telegram:1:2' });
    const running = {
      ...queued,
      state: 'running' as const,
      attempts: 1,
      updatedAt: '2026-11-11T08:00:01.000Z',
    };
    const done = {
      ...running,
      state: 'completed' as const,
      result: { text: 'ok', completedAt: '2026-11-11T08:00:05.000Z' },
    };
    store.saveWorkItem(queued, AT);
    store.saveWorkItem(running, '2026-11-11T08:00:01.000Z');
    store.saveWorkItem(done, '2026-11-11T08:00:05.000Z');
    store.saveWorkItem(
      workItem('w0', 'home', 'failed', { createdAt: '2026-11-10T00:00:00.000Z', error: 'boom' }),
      AT,
    );

    assert.deepEqual(
      store.workItems().map((item) => [item.id, item.state]),
      [
        ['w0', 'failed'],
        ['w1', 'completed'],
      ],
    );
    assert.deepEqual(store.workItems()[1], done);
    assert.deepEqual(store.workItemHistory('w1'), [queued, running, done]);
    assert.deepEqual(store.workItemHistory('nobody'), []);

    store.saveSchedule(schedule('s1', 'home', 'active'));
    store.saveSchedule(schedule('s2', 'note-1', 'active'));
    store.saveSchedule(schedule('s1', 'home', 'cancelled'));
    assert.deepEqual(
      store.schedules().map((item) => [item.id, item.state, item.nextAt]),
      [
        ['s1', 'cancelled', null],
        ['s2', 'active', '2026-12-01T00:00:00.000Z'],
      ],
    );

    store.appendEvent({
      type: 'presence',
      at: AT,
      conversationId: 'home',
      presence: 'awake',
      reason: 'startup',
    });
    store.appendEvent({ type: 'runtime', at: AT, event: 'ready' });
    store.appendEvent({ type: 'heartbeat', at: AT, kind: 'regular', result: 'quiet' });
    store.appendEvent({ type: 'bossCat', at: AT, tool: 'send', target: 'other', outcome: 'sent' });
  });
  assert.equal(count(file, 'work_items'), 2);
  assert.equal(count(file, 'work_events'), 4);
  assert.equal(count(file, 'events'), 4);
});

test('search finds Chinese words of one, two and three characters, and English ones', () => {
  withStore(freshFile(), 'writer', (store) => {
    store.saveConversation(conversation('home'));
    store.saveConversation(conversation('note-1'));
    store.appendEntry('home', entry('今天下午去公園散步'));
    store.appendEntry(
      'home',
      entry('Please remember the kettle', { kind: 'bot', origin: 'owner' }),
    );
    store.appendEntry('home', entry('用iPhone拍照，再買茶葉'));
    store.appendEntry(
      'home',
      entry(`alpha${NUL}omega 記得關瓦斯`, { kind: 'tool_result', origin: 'system' }),
    );
    store.appendEntry('home', entry(''));
    store.appendEntry('note-1', entry('明天早上要去看牙醫，公園改天再去'));
    store.appendEntry('note-1', entry('The kettle is in the kitchen'));

    // Two and three characters use the index.
    assert.deepEqual(hits(store, '公園'), ['home#1', 'note-1#1']);
    assert.deepEqual(hits(store, '去公園'), ['home#1']);
    assert.deepEqual(hits(store, '牙醫'), ['note-1#1']);
    assert.deepEqual(hits(store, '園公'), []);
    // One character is a substring test on the text.
    assert.deepEqual(hits(store, '園'), ['home#1', 'note-1#1']);
    assert.deepEqual(hits(store, '醫'), ['note-1#1']);
    assert.deepEqual(hits(store, '瓦'), ['home#4']);
    assert.deepEqual(hits(store, '貓'), []);
    // English, whatever its case, and a Latin word written against Chinese.
    assert.deepEqual(hits(store, 'KETTLE'), ['home#2', 'note-1#2']);
    assert.deepEqual(hits(store, 'iphone'), ['home#3']);
    assert.deepEqual(hits(store, 'omega'), ['home#4']);
    // Every word must be there.
    assert.deepEqual(hits(store, 'kettle kitchen'), ['note-1#2']);
    assert.deepEqual(hits(store, '公園 牙醫'), ['note-1#1']);
    assert.deepEqual(hits(store, '園 散步'), ['home#1']);
    assert.deepEqual(hits(store, 'iPhone 茶葉'), ['home#3']);
    assert.deepEqual(hits(store, 'kettle 園'), []);
    // Nothing typed is query syntax.
    assert.deepEqual(hits(store, 'kettle OR nothing'), []);
    assert.deepEqual(hits(store, '"kettle'), ['home#2', 'note-1#2']);
    assert.deepEqual(hits(store, '，。 !?'), []);
    assert.deepEqual(hits(store, ''), []);

    // One conversation, a limit, and what a caller filters on.
    assert.deepEqual(hits(store, '公園', 'note-1'), ['note-1#1']);
    assert.deepEqual(hits(store, '園', 'home'), ['home#1']);
    assert.equal(store.search('kettle', { limit: 1 }).length, 1);
    assert.throws(() => store.search('kettle', { limit: 0 }), RangeError);
    const [tool] = store.search('omega');
    assert.deepEqual([tool?.entry.kind, tool?.entry.origin], ['tool_result', 'system']);
    // The newest first when the index has no ranking to offer.
    assert.deepEqual(
      store.search('園').map((hit) => `${hit.conversationId}#${hit.entry.seq}`),
      ['note-1#1', 'home#1'],
    );
  });
});

test('the index can be thrown away and rebuilt from the entries', () => {
  const file = freshFile();
  withStore(file, 'writer', (store) => {
    store.saveConversation(conversation('home'));
    store.appendEntry('home', entry('今天下午去公園散步'));
    store.appendEntry('home', entry(`alpha${NUL}omega`));
    store.appendEntry('home', entry(''));
  });
  // As after a damaged index: the rows are there, the index is empty.
  const { DatabaseSync } = sqliteDriver();
  const raw = new DatabaseSync(file);
  raw.exec('delete from entries_fts');
  raw.close();

  withStore(file, 'writer', (store) => {
    assert.deepEqual(hits(store, '公園'), []);
    assert.equal(store.rebuildIndex(), 2);
    assert.deepEqual(hits(store, '公園'), ['home#1']);
    // The words after a NUL character are still found: the rebuild reads the JSON record.
    assert.deepEqual(hits(store, 'omega'), ['home#2']);
    assert.equal(store.rebuildIndex(), 2);
    assert.deepEqual(hits(store, '公園'), ['home#1']);
  });
});

test('deleting a conversation removes its entries, index rows, presentations and work items', () => {
  const file = freshFile();
  withStore(file, 'writer', (store) => {
    for (const id of ['home', 'note-1']) {
      store.saveConversation(conversation(id));
      store.appendEntry(id, entry('去公園散步'));
      store.appendEntry(id, entry('remember the kettle'));
      store.saveResponse(id, {
        ...entry('reply', { kind: 'bot' }),
        seq: 2,
        workItemId: `w-${id}`,
        presentation: { version: 1, id: 'p1', phase: 'sealed', blocks: [] },
        presentationRevision: 1,
      } as unknown as TranscriptEntry);
      store.saveWorkItem(workItem(`w-${id}`, id, 'queued'), AT);
      store.saveWorkItem(workItem(`w-${id}`, id, 'completed'), AT);
      store.saveSchedule(schedule(`s-${id}`, id, 'cancelled'));
    }

    store.deleteConversation('note-1');

    assert.deepEqual(
      (store.conversations() as ConversationRecord[]).map((record) => record.id),
      ['home'],
    );
    assert.deepEqual(store.entries('note-1'), []);
    assert.deepEqual(store.responses('note-1'), []);
    assert.deepEqual(
      store.workItems().map((item) => item.id),
      ['w-home'],
    );
    assert.deepEqual(store.workItemHistory('w-note-1'), []);
    assert.deepEqual(hits(store, '公園'), ['home#1']);
    assert.deepEqual(hits(store, '園'), ['home#1']);
    assert.deepEqual(hits(store, 'kettle'), ['home#2']);
    // Schedules are the caller's to cancel, and stay as its record of that.
    assert.equal(store.schedules().length, 2);
    // The other conversation is whole.
    assert.equal(store.entries('home').length, 2);
    assert.equal(store.responses('home').length, 1);
    assert.equal(store.workItemHistory('w-home').length, 2);
    // A new conversation under the old id starts from nothing.
    store.saveConversation(conversation('note-1'));
    assert.equal(store.appendEntry('note-1', entry('fresh')).seq, 1);
    store.deleteConversation('nobody');
  });
  assert.equal(count(file, 'entries'), 3);
  assert.equal(count(file, 'work_events'), 2);
});

test('an entry and its conversation change together or not at all', () => {
  withStore(freshFile(), 'writer', (store) => {
    store.saveConversation(conversation('home'));
    assert.throws(
      () =>
        store.transaction(() => {
          store.appendEntry('home', entry('去公園散步'));
          store.saveConversation(conversation('home', { lastOwnerMessageAt: AT }));
          throw new Error('stop');
        }),
      /stop/u,
    );
    assert.deepEqual(store.entries('home'), []);
    assert.deepEqual(hits(store, '公園'), []);
    assert.equal((store.conversations() as ConversationRecord[])[0]?.lastOwnerMessageAt, null);

    store.transaction(() => {
      store.appendEntry('home', entry('去公園散步'));
      store.saveConversation(conversation('home', { lastOwnerMessageAt: AT }));
    });
    assert.equal(store.entries('home').length, 1);
    assert.deepEqual(hits(store, '公園'), ['home#1']);
    assert.equal((store.conversations() as ConversationRecord[])[0]?.lastOwnerMessageAt, AT);
  });
});

test('a reader reads and searches beside the writer, and changes nothing', () => {
  const file = freshFile();
  const writing = openBotStateStore({ file, mode: 'writer' });
  let reading: BotStateStore | undefined;
  const readOnly = (work: () => unknown): void => {
    assert.throws(
      work,
      (error: unknown) => error instanceof StateDatabaseError && error.code === 'read_only',
    );
  };
  try {
    writing.saveConversation(conversation('home'));
    writing.appendEntry('home', entry('今天下午去公園散步'));
    writing.saveWorkItem(workItem('w1', 'home', 'queued'), AT);
    writing.saveSchedule(schedule('s1', 'home', 'active'));

    reading = openBotStateStore({ file, mode: 'reader' });
    assert.equal(reading.mode, 'reader');
    assert.equal(reading.conversations().length, 1);
    assert.equal(reading.entries('home').length, 1);
    assert.equal(reading.entriesPage('home', { limit: 5 }).length, 1);
    assert.equal(reading.workItems().length, 1);
    assert.equal(reading.schedules().length, 1);
    assert.deepEqual(hits(reading, '公園'), ['home#1']);
    assert.deepEqual(hits(reading, '園'), ['home#1']);

    readOnly(() => reading!.saveConversation(conversation('note-1')));
    readOnly(() => reading!.appendEntry('home', entry('no')));
    readOnly(() =>
      reading!.saveResponse('home', { presentation: { id: 'p1' } } as unknown as TranscriptEntry),
    );
    readOnly(() => reading!.saveWorkItem(workItem('w2', 'home', 'queued'), AT));
    readOnly(() => reading!.saveSchedule(schedule('s2', 'home', 'active')));
    readOnly(() => reading!.appendEvent({ type: 'runtime', at: AT, event: 'ready' }));
    readOnly(() => reading!.deleteConversation('home'));
    readOnly(() => reading!.rebuildIndex());
    readOnly(() => reading!.transaction(() => undefined));

    // The reader sees what the writer commits next, and one snapshot does not move.
    writing.appendEntry('home', entry('second'));
    assert.equal(reading.entries('home').length, 2);
    reading.snapshot(() => {
      writing.appendEntry('home', entry('third'));
      assert.equal(reading!.entries('home').length, 2);
    });
    assert.equal(reading.entries('home').length, 3);
  } finally {
    reading?.close();
    writing.close();
  }
  assert.deepEqual(readdirSync(join(file, '..')), ['bot.db']);
});
