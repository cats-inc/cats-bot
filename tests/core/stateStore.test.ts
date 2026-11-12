import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { conversationTerm, INDEX_FORM, MAX_QUERY_LENGTH } from '../../src/core/store/searchText.ts';
import { sqliteDriver } from '../../src/core/store/sqliteDriver.ts';
import { StateDatabaseError } from '../../src/core/store/stateDatabase.ts';
import {
  openBotStateStore,
  RANKED_MATCHES,
  SEARCH_CANDIDATES_SQL,
  SEARCH_ENTRY_SQL,
  type BotStateStore,
} from '../../src/core/store/stateStore.ts';
import type {
  ConversationRecord,
  JournalEntry,
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

type RawDatabase = InstanceType<ReturnType<typeof sqliteDriver>['DatabaseSync']>;

/** The file through the driver itself: what the store does not offer, or must not have changed. */
function raw<T>(file: string, work: (database: RawDatabase) => T): T {
  const { DatabaseSync } = sqliteDriver();
  // Node.js 26 keeps the index's own tables from being written unless told otherwise.
  const database = new DatabaseSync(file, { defensive: false } as never);
  try {
    return work(database);
  } finally {
    database.close();
  }
}

function count(file: string, table: string): number {
  return raw(file, (database) =>
    Number(database.prepare(`select count(*) as n from ${table}`).get()?.n),
  );
}

const AT = '2026-11-11T08:00:00.000Z';
const NUL = String.fromCharCode(0);
const emoji = (codePoint: number): string => String.fromCodePoint(codePoint);

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

const work = (item: WorkItem, at = AT): JournalEntry => ({ type: 'work', at, item });
const scheduled = (record: ScheduleRecord, at = AT): JournalEntry => ({
  type: 'schedule',
  at,
  schedule: record,
});

/** In ranked order. */
function ranked(store: BotStateStore, query: string, conversationId?: string): string[] {
  return store
    .search(query, { limit: 1000, ...(conversationId === undefined ? {} : { conversationId }) })
    .map((hit) => `${hit.conversationId}#${hit.entry.seq}`);
}

function hits(store: BotStateStore, query: string, conversationId?: string): string[] {
  return ranked(store, query, conversationId).sort();
}

/** A bot with a home conversation and a note, each with the entries given. */
function filled(home: string[], note: string[] = []): { file: string; store: BotStateStore } {
  const file = freshFile();
  const store = openBotStateStore({ file, mode: 'writer' });
  store.saveConversation(conversation('home'));
  store.saveConversation(conversation('note-1'));
  for (const text of home) store.appendEntry('home', entry(text));
  for (const text of note) store.appendEntry('note-1', entry(text));
  return { file, store };
}

test('a conversation record is stored whole, replaced in place and read back as it was given', () => {
  const file = freshFile();
  withStore(file, 'writer', (store) => {
    assert.deepEqual(store.conversations(), []);
    const home = conversation('home', {
      futureField: { kept: true },
      title: `emoji ${emoji(0x1f431)} and${NUL}nul`,
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
    assert.equal(store.lastSeq('home'), 0);
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
    // A field this version does not know stays with the entry, and a seq it came with does not.
    const future = store.appendEntry('home', {
      ...entry('third'),
      futureField: [1, 2],
      seq: 99,
    } as Omit<TranscriptEntry, 'seq'>);
    assert.equal(future.seq, 3);
    // Text that is not text is kept as it is, and not indexed.
    store.appendEntry('home', { ...entry('x'), text: 42 } as unknown as Omit<
      TranscriptEntry,
      'seq'
    >);

    const transcript = store.entries('home');
    assert.deepEqual(
      transcript.map((item) => item.seq),
      [1, 2, 3, 4],
    );
    assert.deepEqual(transcript[1], tool);
    assert.equal(transcript[1]?.text, awkward);
    assert.deepEqual(
      (transcript[2] as TranscriptEntry & { futureField?: unknown }).futureField,
      [1, 2],
    );
    assert.equal((transcript[3] as unknown as { text: unknown }).text, 42);
    assert.equal(store.lastSeq('home'), 4);
    assert.deepEqual(
      store.entriesAfter('home', 2).map((item) => item.seq),
      [3, 4],
    );
    assert.deepEqual(store.entriesAfter('home', 4), []);
    assert.deepEqual(store.entries('nobody'), []);
    assert.equal(store.lastSeq('nobody'), 0);
    // Nothing is kept for a conversation that is not there.
    assert.throws(() => store.appendEntry('nobody', entry('lost')), /Unknown conversation nobody/u);
    assert.deepEqual(store.entries('nobody'), []);
  });
  // The numbering carries on after a restart.
  withStore(file, 'writer', (store) => {
    assert.equal(store.appendEntry('home', entry('fifth')).seq, 5);
    assert.equal(store.appendEntry('note-1', entry('again')).seq, 2);
  });
});

test('a page is the newest entries, or the ones before a seq, in order', () => {
  const { store } = filled(Array.from({ length: 7 }, (_, index) => `entry ${index + 1}`));
  try {
    const seqs = (entries: TranscriptEntry[]): number[] => entries.map((item) => item.seq);
    assert.deepEqual(seqs(store.entriesPage('home', { limit: 3 })), [5, 6, 7]);
    assert.deepEqual(seqs(store.entriesPage('home', { limit: 3, beforeSeq: 5 })), [2, 3, 4]);
    assert.deepEqual(seqs(store.entriesPage('home', { limit: 3, beforeSeq: 2 })), [1]);
    assert.deepEqual(seqs(store.entriesPage('home', { limit: 3, beforeSeq: 1 })), []);
    assert.deepEqual(seqs(store.entriesPage('home', { limit: 50 })), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(store.entriesPage('nobody', { limit: 3 }), []);
    assert.throws(() => store.entriesPage('home', { limit: 0 }), RangeError);
    assert.throws(() => store.entriesPage('home', { limit: 1.5 }), RangeError);
  } finally {
    store.close();
  }
});

test('a reply presentation is one row, replaced at each checkpoint', () => {
  const { store } = filled([]);
  try {
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

    const stored = store.responses('home') as TranscriptEntry[];
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
    assert.throws(
      () => store.saveResponse('nobody', reply('p1', 1, 1, 'x')),
      /Unknown conversation nobody/u,
    );
    assert.deepEqual(store.responses('nobody'), []);
  } finally {
    store.close();
  }
});

test('the journal keeps every line in order, and the last state of each work item and schedule', () => {
  const file = freshFile();
  // Ids as random as real ones, and all made in the same millisecond.
  const second = workItem('aaa', 'home', 'queued', { sourceRef: 'telegram:1:2' });
  const first = workItem('zzz', 'home', 'queued');
  const lines: JournalEntry[] = [
    { type: 'runtime', at: AT, event: 'started', detail: 'attempt 1' },
    work(first),
    work(second),
    { type: 'presence', at: AT, conversationId: 'home', presence: 'awake', reason: 'startup' },
    work({ ...first, state: 'running', attempts: 1 }, '2026-11-11T08:00:01.000Z'),
    scheduled(schedule('s-b', 'home', 'active')),
    scheduled(schedule('s-a', 'note-1', 'active')),
    work(
      { ...first, state: 'completed', result: { text: 'ok', completedAt: AT } },
      '2026-11-11T08:00:05.000Z',
    ),
    scheduled(schedule('s-b', 'home', 'cancelled'), '2026-11-11T08:00:06.000Z'),
    { type: 'heartbeat', at: AT, kind: 'regular', result: 'quiet' },
    {
      type: 'config',
      at: AT,
      configRevision: 2,
      executionTarget: { provider: 'claude', model: null } as never,
    },
    { type: 'bossCat', at: AT, tool: 'send', target: 'other', outcome: 'sent' },
  ];
  withStore(file, 'writer', (store) => {
    for (const line of lines) store.appendJournal(line);

    assert.deepEqual(store.journal(), lines);
    assert.deepEqual(store.journal('zzz'), [lines[1], lines[4], lines[7]]);
    assert.deepEqual(store.journal('s-b'), [lines[5], lines[8]]);
    assert.deepEqual(store.journal('nobody'), []);
    // The order each first appeared in, as today's replay of the journal gives.
    assert.deepEqual(
      store.workItems().map((item) => [item.id, item.state]),
      [
        ['zzz', 'completed'],
        ['aaa', 'queued'],
      ],
    );
    assert.deepEqual(store.workItems()[1], second);
    assert.deepEqual(
      store.schedules().map((item) => [item.id, item.state, item.nextAt]),
      [
        ['s-b', 'cancelled', null],
        ['s-a', 'active', '2026-12-01T00:00:00.000Z'],
      ],
    );
  });
  withStore(file, 'reader', (store) => {
    assert.equal(store.journal().length, lines.length);
    assert.equal(store.workItems().length, 2);
  });
  assert.equal(count(file, 'work_items'), 2);
  assert.equal(count(file, 'schedules'), 2);
});

test('a journal line that names no work item or schedule is kept and becomes nobody', () => {
  // What a version-1 journal can hold and today's replay passes over.
  const odd = [
    { type: 'work', at: AT },
    { type: 'work', at: AT, item: { state: 'queued' } },
    { type: 'work', at: AT, item: { id: 7, state: 'queued' } },
    { type: 'work', at: AT, item: 'not an item' },
    { type: 'schedule', at: AT },
    { type: 'schedule', at: AT, schedule: { id: 9 } },
    { type: 'something new', at: AT, payload: [1, 2] },
    { at: 42 },
    null,
    'a line of text',
  ] as unknown as JournalEntry[];
  const file = freshFile();
  withStore(file, 'writer', (store) => {
    for (const line of odd) store.appendJournal(line);
    assert.deepEqual(store.journal(), odd);
    assert.deepEqual(store.workItems(), []);
    assert.deepEqual(store.schedules(), []);
  });
  assert.equal(count(file, 'journal'), odd.length);
});

test('a record that cannot be read is left out and reported once, and the rest is read', () => {
  const { file, store } = filled([
    'first about the kettle',
    'second',
    'third about the kettle',
    'fourth about the kettle',
    'fifth',
  ]);
  store.appendJournal(work(workItem('w1', 'home', 'queued')));
  store.appendJournal(work(workItem('w2', 'home', 'queued')));
  store.close();
  // As a damaged page would leave them: text that is no longer JSON, or no longer a record.
  raw(file, (database) => {
    database.exec(
      `update entries set json = '{"seq":2,"text":"sec' where conversation_id = 'home' and seq = 2`,
    );
    database.exec(`update entries set json = 'null' where conversation_id = 'home' and seq = 5`);
    database.exec(`update conversations set json = 'null and void' where id = 'note-1'`);
    database.exec(`update work_items set json = '' where id = 'w1'`);
    database.exec(`update meta set value = '0' where key = 'index_form'`);
  });
  const warnings: string[] = [];
  const opened = openBotStateStore({
    file,
    mode: 'writer',
    warn: (message) => warnings.push(message),
  });
  try {
    // The writer opened, and rebuilt the index without the entries it could not read.
    assert.deepEqual(warnings, [
      'entry 2 of conversation home cannot be read and was left out',
      'entry 5 of conversation home cannot be read and was left out',
    ]);
    assert.deepEqual(hits(opened, 'kettle'), ['home#1', 'home#3', 'home#4']);

    assert.deepEqual(
      opened.entries('home').map((item) => item.seq),
      [1, 3, 4],
    );
    // A page is filled from further back, so that a damaged entry is not taken for the end.
    assert.deepEqual(
      opened.entriesPage('home', { limit: 1 }).map((item) => item.seq),
      [4],
    );
    assert.deepEqual(
      opened.entriesPage('home', { limit: 2 }).map((item) => item.seq),
      [3, 4],
    );
    assert.deepEqual(
      opened.entriesPage('home', { limit: 2, beforeSeq: 3 }).map((item) => item.seq),
      [1],
    );
    assert.deepEqual(
      (opened.conversations() as ConversationRecord[]).map((record) => record.id),
      ['home'],
    );
    assert.deepEqual(
      opened.workItems().map((item) => item.id),
      ['w2'],
    );
    // Each is reported once, however often it is read.
    assert.deepEqual(warnings.slice(2), [
      'conversation note-1 cannot be read and was left out',
      'work item w1 cannot be read and was left out',
    ]);
    // The numbering does not reuse the place of an entry that cannot be read.
    assert.equal(opened.appendEntry('home', entry('sixth')).seq, 6);
  } finally {
    opened.close();
  }

  // An entry damaged after it was indexed is still in the index. A search skips it and
  // gives the next best ones instead of fewer than were asked for.
  raw(file, (database) => {
    database.exec(
      `update entries set json = 'not json' where conversation_id = 'home' and seq = 4`,
    );
  });
  withStore(file, 'writer', (again) => {
    assert.deepEqual(
      again.search('kettle', { limit: 2 }).map((hit) => hit.entry.seq),
      [3, 1],
    );
    assert.deepEqual(
      again.search('kettle', { limit: 1, conversationId: 'home' }).map((hit) => hit.entry.seq),
      [3],
    );
  });
});

test('a page filled from further back holds no more entries than were asked for', () => {
  const { file, store } = filled(['one', 'two', 'three', 'four', 'five', 'six']);
  store.close();
  raw(file, (database) => {
    database.exec(
      `update entries set json = 'not json' where conversation_id = 'home' and seq = 6`,
    );
  });
  const warnings: string[] = [];
  const opened = openBotStateStore({
    file,
    mode: 'writer',
    warn: (message) => warnings.push(message),
  });
  try {
    // Two asked for: the first two rows hold one entry, the next four hold three.
    assert.deepEqual(
      opened.entriesPage('home', { limit: 2 }).map((item) => item.text),
      ['four', 'five'],
    );
    assert.deepEqual(warnings, ['entry 6 of conversation home cannot be read and was left out']);
  } finally {
    opened.close();
  }
});

test('the version-1 import keeps each seq, in order and after what a conversation holds', () => {
  const file = freshFile();
  const at = (seq: number, text: string): TranscriptEntry => ({ seq, ...entry(text) });
  withStore(file, 'writer', (store) => {
    assert.equal(store.isEmpty(), true);
    store.saveConversation(conversation('home'));
    assert.equal(store.isEmpty(), false);

    store.importEntries('home', [at(2, 'one kettle'), at(7, 'two')]);
    assert.deepEqual(
      store.entries('home').map((item) => item.seq),
      [2, 7],
    );
    // Imported entries are indexed, and the numbering goes on after them.
    assert.deepEqual(hits(store, 'kettle'), ['home#2']);
    assert.equal(store.appendEntry('home', entry('three')).seq, 8);

    for (const seq of [8, 3, 9.5, Number.NaN, '9']) {
      assert.throws(
        () => store.importEntries('home', [{ ...at(9, 'bad'), seq } as unknown as TranscriptEntry]),
        /does not come after entry 8/u,
        String(seq),
      );
    }
    // A batch is all or nothing.
    assert.throws(
      () => store.importEntries('home', [at(9, 'nine'), at(9, 'again')]),
      /Entry 9 of conversation home does not come after entry 9/u,
    );
    assert.deepEqual(
      store.entries('home').map((item) => item.seq),
      [2, 7, 8],
    );
    assert.throws(
      () => store.importEntries('nobody', [at(1, 'x')]),
      /Unknown conversation nobody/u,
    );

    // The largest `seq` a number holds may be imported, and nothing after it appended.
    store.saveConversation(conversation('note-1'));
    store.importEntries('note-1', [at(Number.MAX_SAFE_INTEGER, 'last')]);
    assert.throws(() => store.appendEntry('note-1', entry('one more')), /holds no more entries/u);
    assert.deepEqual(
      store.entries('note-1').map((item) => item.seq),
      [Number.MAX_SAFE_INTEGER],
    );

    assert.equal(store.importMarker(), undefined);
    store.setImportMarker('{"from":1}');
    assert.equal(store.importMarker(), '{"from":1}');
  });
  withStore(file, 'reader', (store) => assert.equal(store.importMarker(), '{"from":1}'));

  // Any kind of record makes a store not empty.
  for (const make of [
    (store: BotStateStore) => store.appendJournal(work(workItem('w1', 'home', 'queued'))),
    (store: BotStateStore) =>
      store.appendJournal({ type: 'presence', at: AT } as unknown as JournalEntry),
  ]) {
    withStore(freshFile(), 'writer', (store) => {
      make(store);
      assert.equal(store.isEmpty(), false);
    });
  }
});

test('search finds Chinese words of any length, English ones, and words written against each other', () => {
  const { store } = filled(
    [
      '今天下午去公園散步',
      'Please remember the kettle',
      '用iPhone拍照，再買茶葉',
      `alpha${NUL}omega 記得關瓦斯`,
      '',
      `這個bug${emoji(0x1f914)}怎麼修 OK${emoji(0x1f642)}`,
      '訂單編號ＡＢ１２３，２０２６年',
      '今天買股票',
    ],
    [
      '明天早上要去看牙醫，公園改天再去',
      'The kettle is in the kitchen',
      '謝謝你，你好嗎',
      '買A股',
      'ㅋㅋㅋㅠㅠ 아니',
      `iPhone™ 今天好開心 (￣▽￣)`,
      `first line${String.fromCharCode(0xfeff)}second line`,
    ],
  );
  try {
    // Two and three characters, and one: every place the character occurs.
    assert.deepEqual(hits(store, '公園'), ['home#1', 'note-1#1']);
    assert.deepEqual(hits(store, '去公園'), ['home#1']);
    assert.deepEqual(hits(store, '牙醫'), ['note-1#1']);
    assert.deepEqual(hits(store, '園公'), []);
    assert.deepEqual(hits(store, '園'), ['home#1', 'note-1#1']);
    assert.deepEqual(hits(store, '步'), ['home#1']);
    assert.deepEqual(hits(store, '醫'), ['note-1#1']);
    assert.deepEqual(hits(store, '瓦'), ['home#4']);
    assert.deepEqual(hits(store, '貓'), []);
    // English in any case, and a Latin word written against Chinese or an emoji.
    assert.deepEqual(hits(store, 'KETTLE'), ['home#2', 'note-1#2']);
    assert.deepEqual(hits(store, 'omega'), ['home#4']);
    assert.deepEqual(hits(store, 'bug'), ['home#6']);
    assert.deepEqual(hits(store, 'ok'), ['home#6']);
    // Full-width forms are the words they spell.
    assert.deepEqual(hits(store, 'AB123'), ['home#7']);
    assert.deepEqual(hits(store, '2026'), ['home#7']);
    assert.deepEqual(hits(store, '２０２６年'), ['home#7']);
    // Every word must be there, and a word keeps its order.
    assert.deepEqual(hits(store, 'kettle kitchen'), ['note-1#2']);
    assert.deepEqual(hits(store, '公園 牙醫'), ['note-1#1']);
    assert.deepEqual(hits(store, '園 散步'), ['home#1']);
    assert.deepEqual(hits(store, 'iPhone 茶葉'), ['home#3']);
    assert.deepEqual(hits(store, 'iPhone拍照'), ['home#3']);
    assert.deepEqual(hits(store, '拍照iPhone'), []);
    assert.deepEqual(hits(store, 'kettle 園'), []);
    // A phrase does not match across punctuation, nor a lone character across other words.
    assert.deepEqual(hits(store, '謝謝你'), ['note-1#3']);
    assert.deepEqual(hits(store, '謝你好'), []);
    assert.deepEqual(hits(store, 'A股'), ['note-1#4']);
    assert.deepEqual(hits(store, '股'), ['home#8', 'note-1#4']);
    // Nothing typed is query syntax, and nothing typed is an error.
    assert.deepEqual(hits(store, 'kettle OR nothing'), []);
    assert.deepEqual(hits(store, '"kettle'), ['home#2', 'note-1#2']);
    assert.deepEqual(hits(store, `alpha${NUL}omega`), ['home#4']);
    assert.deepEqual(hits(store, '，。 !?'), []);
    assert.deepEqual(hits(store, ''), []);
    assert.throws(() => store.search('貓'.repeat(MAX_QUERY_LENGTH + 1)), RangeError);

    // Punctuation next to a CJK word parts two words, as a space does.
    assert.deepEqual(hits(store, '公園、牙醫'), ['note-1#1']);
    assert.deepEqual(hits(store, '牙醫，公園'), ['note-1#1']);
    // Hangul letters typed on their own, a word before a trade mark sign, words on either
    // side of a byte-order mark, and a word typed with a face after it.
    assert.deepEqual(hits(store, 'ㅋㅋㅋ'), ['note-1#5']);
    assert.deepEqual(hits(store, 'ㅠㅠ'), ['note-1#5']);
    assert.deepEqual(hits(store, 'iphone'), ['home#3', 'note-1#6']);
    assert.deepEqual(hits(store, 'second'), ['note-1#7']);
    assert.deepEqual(hits(store, '開心 (￣▽￣)'), ['note-1#6']);

    // One conversation, a limit, and what a caller filters on.
    assert.deepEqual(hits(store, '公園', 'note-1'), ['note-1#1']);
    assert.deepEqual(hits(store, '園', 'home'), ['home#1']);
    assert.deepEqual(hits(store, 'kettle', 'nobody'), []);
    assert.equal(store.search('kettle', { limit: 1 }).length, 1);
    assert.equal(store.search('kettle', { limit: 1, conversationId: 'home' }).length, 1);
    assert.throws(() => store.search('kettle', { limit: 0 }), RangeError);
    const [tool] = store.search('omega');
    assert.deepEqual([tool?.entry.kind, tool?.entry.origin], ['owner', 'owner']);
  } finally {
    store.close();
  }
});

test('the best match comes first, with and without a conversation', () => {
  const { store } = filled(
    [
      'a long note that mentions the kettle once among many other words about the house and the garden',
      'kettle kettle kettle',
    ],
    ['the kettle and the kettle again, in a sentence of middling length'],
  );
  try {
    assert.deepEqual(ranked(store, 'kettle'), ['home#2', 'note-1#1', 'home#1']);
    assert.deepEqual(ranked(store, 'kettle', 'home'), ['home#2', 'home#1']);
    // The limit keeps the best ones.
    assert.deepEqual(
      store.search('kettle', { limit: 2 }).map((hit) => `${hit.conversationId}#${hit.entry.seq}`),
      ['home#2', 'note-1#1'],
    );
    // Equal matches: the newest first.
    store.appendEntry('home', entry('same words'));
    store.appendEntry('home', entry('same words'));
    assert.deepEqual(ranked(store, 'same words'), ['home#4', 'home#3']);
    assert.deepEqual(ranked(store, 'same words', 'home'), ['home#4', 'home#3']);
  } finally {
    store.close();
  }
});

test('a search reads the newest matches backwards in the index, and their records by row id', () => {
  // Ranking every match, or reading forwards from a row id, takes seconds on a million
  // entries; reading the newest ones backwards takes milliseconds (PLAN-014 task 1.7).
  const { file, store } = filled(
    Array.from({ length: 300 }, (_, index) => `entry ${index} about the kettle`),
  );
  store.close();
  raw(file, (database) => {
    const candidates = database
      .prepare(`explain query plan ${SEARCH_CANDIDATES_SQL}`)
      .all('"kettle"', 50)
      .map((row) => String(row.detail));
    assert.deepEqual(candidates.length, 1, candidates.join(' | '));
    assert.match(candidates[0]!, /^SCAN entries_fts VIRTUAL TABLE INDEX/u);
    // No sort of its own: the index gives the rows newest first.
    assert.equal(
      candidates.some((step) => /TEMP B-TREE/u.test(step)),
      false,
      candidates.join(' | '),
    );
    const entry = database
      .prepare(`explain query plan ${SEARCH_ENTRY_SQL}`)
      .all(1)
      .map((row) => String(row.detail));
    assert.deepEqual(entry, ['SEARCH entries USING INTEGER PRIMARY KEY (rowid=?)']);
  });
});

test('a search ranks the newest matches, so a better match older than them is not found', () => {
  const file = freshFile();
  withStore(file, 'writer', (store) => {
    store.saveConversation(conversation('home'));
    store.saveConversation(conversation('note-1'));
    store.transaction(() => {
      // The best match of all, and older than the newest RANKED_MATCHES.
      store.appendEntry('home', entry('kettle kettle kettle kettle'));
      for (let index = 0; index < RANKED_MATCHES; index += 1) {
        store.appendEntry(
          index % 2 ? 'home' : 'note-1',
          entry(`a kettle and a long line of other words, number ${index}`),
        );
      }
      // The best of the newest.
      store.appendEntry('home', entry('kettle kettle'));
    });
    const best = store.search('kettle', { limit: 1 });
    assert.equal(best[0]!.entry.text, 'kettle kettle');
    assert.equal(
      store
        .search('kettle', { limit: RANKED_MATCHES })
        .some((hit) => hit.entry.text === 'kettle kettle kettle kettle'),
      false,
    );
    // No more than it ranks is asked for.
    assert.throws(() => store.search('kettle', { limit: RANKED_MATCHES + 1 }), RangeError);
    // Within one conversation the newest of its own matches are ranked, by its term: home
    // holds fewer than RANKED_MATCHES of them, so its oldest and best is found there.
    const inHome = store.search('kettle', { limit: 3, conversationId: 'home' });
    assert.equal(inHome[0]!.entry.text, 'kettle kettle kettle kettle');
    assert.ok(inHome.every((hit) => hit.conversationId === 'home'));
    assert.ok(
      store
        .search('kettle', { limit: 3, conversationId: 'note-1' })
        .every((hit) => hit.conversationId === 'note-1'),
    );
  });
});

test("a conversation's term can be neither typed nor written into another conversation's entries", () => {
  const term = conversationTerm('home');
  const { store } = filled(['remember the kettle', 'the garden'], ['a note']);
  try {
    // Typed in any form, it finds nothing: what a person types is rewritten into other tokens.
    for (const typed of [term, term.slice(1), `zc${term.slice(1)}`, term.toUpperCase()]) {
      assert.deepEqual(hits(store, typed), [], JSON.stringify(typed));
    }
    // Entries of another conversation that carry it, newer than all of home's: they neither
    // hide home's matches from a search of home nor show up in it.
    store.transaction(() => {
      for (let index = 0; index < RANKED_MATCHES + 5; index += 1) {
        store.appendEntry('note-1', entry(`${term} kettle ${term.slice(1)}`));
      }
    });
    assert.deepEqual(hits(store, 'kettle', 'home'), ['home#1']);
    assert.equal(hits(store, 'kettle', 'note-1').length, RANKED_MATCHES);
  } finally {
    store.close();
  }
});

test('every piece of a CJK run is found, and nothing that is in no run', () => {
  // A small alphabet, so that the same characters meet in many orders.
  const alphabet = Array.from('貓狗魚鳥花草山水日月');
  let state = 20261111;
  const random = (below: number): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % below;
  };
  const run = (): string =>
    Array.from({ length: 1 + random(6) }, () => alphabet[random(alphabet.length)]!).join('');
  const separators = ['，', ' ', 'abc', '。', '\n', ' 12 ', emoji(0x1f642)];
  const documents = Array.from({ length: 80 }, () => {
    const runs = Array.from({ length: 1 + random(4) }, run);
    return {
      runs,
      text: runs.map((part) => part + separators[random(separators.length)]!).join(''),
    };
  });
  const { store } = filled(documents.map((document) => document.text));
  try {
    const pieces = new Map<string, Set<number>>();
    documents.forEach((document, index) => {
      for (const part of document.runs) {
        for (let start = 0; start < part.length; start += 1) {
          for (let length = 1; length <= 4 && start + length <= part.length; length += 1) {
            const piece = part.slice(start, start + length);
            pieces.set(piece, (pieces.get(piece) ?? new Set()).add(index + 1));
          }
        }
      }
    });
    assert.ok(pieces.size > 300, `${pieces.size} pieces`);
    // The same character twice in a row, and more than half of the hundred possible pairs.
    const pairs = [...pieces.keys()].filter((piece) => piece.length === 2);
    assert.ok(
      pairs.some((pair) => pair[0] === pair[1]),
      'no doubled character',
    );
    assert.ok(pairs.length > 60, `${pairs.length} pairs`);
    for (const [piece, where] of pieces) {
      assert.deepEqual(
        store
          .search(piece, { limit: 1000 })
          .map((hit) => hit.entry.seq)
          .sort((a, b) => a - b),
        [...where].sort((a, b) => a - b),
        piece,
      );
    }
    let absent = 0;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const piece = Array.from(
        { length: 2 + random(3) },
        () => alphabet[random(alphabet.length)]!,
      ).join('');
      if (pieces.has(piece)) continue;
      absent += 1;
      assert.deepEqual(store.search(piece), [], piece);
    }
    assert.ok(absent > 100, `${absent} absent pieces`);
  } finally {
    store.close();
  }
});

test('a failed search inside a transaction is the caller to handle, and the transaction goes on', () => {
  const { store } = filled(['remember the kettle']);
  try {
    store.transaction(() => {
      store.appendEntry('home', entry('before'));
      assert.throws(() => store.search('貓'.repeat(MAX_QUERY_LENGTH + 1)), RangeError);
      assert.deepEqual(hits(store, 'kettle'), ['home#1']);
      store.appendEntry('home', entry('after'));
    });
    assert.equal(store.entries('home').length, 3);
  } finally {
    store.close();
  }
});

test('the index is rebuilt from the entries, even when it is damaged', () => {
  const texts = ['今天下午去公園散步', `alpha${NUL}omega`, '', 'remember the kettle'];
  const { file, store } = filled(texts);
  store.close();
  assert.equal(count(file, 'entries_fts_docsize'), 3);

  // Emptied: the rows are there and the index is not.
  raw(file, (database) =>
    database.exec(`insert into entries_fts(entries_fts) values('delete-all')`),
  );
  withStore(file, 'writer', (opened) => {
    assert.deepEqual(hits(opened, '公園'), []);
    assert.equal(opened.rebuildIndex(), 3);
    assert.deepEqual(hits(opened, '公園'), ['home#1']);
    // The words after a NUL character are found: the rebuild reads the JSON record.
    assert.deepEqual(hits(opened, 'omega'), ['home#2']);
    assert.equal(opened.rebuildIndex(), 3);
    assert.deepEqual(hits(opened, 'kettle'), ['home#4']);
  });

  // Damaged for real: the index has lost its blocks. Searching it and adding to it both
  // fail, and so would emptying it row by row, which has to read it. The rebuild does not.
  raw(file, (database) => {
    assert.ok(Number(database.prepare('delete from entries_fts_data').run().changes) > 0);
  });
  withStore(file, 'writer', (opened) => {
    assert.throws(() => opened.search('kettle'), /corruption/u);
    assert.throws(() => opened.appendEntry('home', entry('cannot be indexed')), /corruption/u);
    // The entry that could not be indexed was not kept either.
    assert.equal(opened.entries('home').length, 4);

    assert.equal(opened.rebuildIndex(), 3);
    assert.deepEqual(hits(opened, '公園'), ['home#1']);
    assert.deepEqual(hits(opened, 'kettle'), ['home#4']);
    opened.appendEntry('home', entry('and the index takes new entries'));
    assert.deepEqual(hits(opened, 'takes'), ['home#5']);
  });
  assert.equal(
    raw(file, (database) => {
      database.exec(`insert into entries_fts(entries_fts) values('integrity-check')`);
      return 'ok';
    }),
    'ok',
  );
});

test('an index made the way another version searched is rebuilt when a writer opens', () => {
  const { file, store } = filled(['今天下午去公園散步', 'remember the kettle']);
  store.close();
  // As an older version would have left it: another form number, and tokens this version
  // does not look for.
  raw(file, (database) => {
    database.exec(`insert into entries_fts(entries_fts) values('delete-all')`);
    database
      .prepare('insert into entries_fts(rowid, terms) values (?, ?)')
      .run(1, 'something else entirely');
    database.prepare(`update meta set value = '0' where key = 'index_form'`).run();
  });
  // A reader leaves it alone, and does not pretend to have searched it.
  withStore(file, 'reader', (reading) => {
    assert.throws(() => reading.search('公園'), /made by another version/u);
    assert.equal(reading.entries('home').length, 2);
  });
  assert.equal(
    raw(
      file,
      (database) =>
        database.prepare(`select value from meta where key = 'index_form'`).get()?.value,
    ),
    '0',
  );

  withStore(file, 'writer', (opened) => {
    assert.deepEqual(hits(opened, '公園'), ['home#1']);
    assert.deepEqual(hits(opened, 'kettle'), ['home#2']);
    assert.deepEqual(hits(opened, 'something'), []);
    // A search of one conversation finds its entries by the terms the rebuild gave them.
    assert.deepEqual(hits(opened, '公園', 'home'), ['home#1']);
    assert.deepEqual(hits(opened, 'kettle', 'note-1'), []);
  });
  assert.equal(
    raw(
      file,
      (database) =>
        database.prepare(`select value from meta where key = 'index_form'`).get()?.value,
    ),
    String(INDEX_FORM),
  );
  assert.equal(count(file, 'entries_fts_docsize'), 2);
});

test('deleting a conversation removes its entries, index rows, presentations and work items', () => {
  const file = freshFile();
  withStore(file, 'writer', (store) => {
    for (const id of ['home', 'note-1']) {
      store.saveConversation(conversation(id));
      // In one transaction, so that the index rows share a segment, as they do once the
      // index has merged: deleting those is what the adapter's big integers are for.
      store.transaction(() => {
        store.appendEntry(id, entry('去公園散步'));
        store.appendEntry(id, entry('remember the kettle'));
        store.appendEntry(id, entry(''));
        store.appendEntry(id, entry('one more about the kettle'));
      });
      store.saveResponse(id, {
        ...entry('reply', { kind: 'bot' }),
        seq: 2,
        workItemId: `w-${id}`,
        presentation: { version: 1, id: 'p1', phase: 'sealed', blocks: [] },
        presentationRevision: 1,
      } as unknown as TranscriptEntry);
      store.appendJournal(work(workItem(`w-${id}`, id, 'queued')));
      store.appendJournal(work(workItem(`w-${id}`, id, 'completed')));
      store.appendJournal(scheduled(schedule(`s-${id}`, id, 'cancelled')));
      store.appendJournal({
        type: 'presence',
        at: AT,
        conversationId: id,
        presence: 'awake',
        reason: 'startup',
      });
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
    assert.deepEqual(store.journal('w-note-1'), []);
    assert.deepEqual(hits(store, '公園'), ['home#1']);
    assert.deepEqual(hits(store, '園'), ['home#1']);
    assert.deepEqual(hits(store, 'kettle'), ['home#2', 'home#4']);
    // Schedules are the caller's to cancel, and stay as its record of that.
    assert.equal(store.schedules().length, 2);
    assert.equal(store.journal('s-note-1').length, 1);
    // The other conversation is whole.
    assert.equal(store.entries('home').length, 4);
    assert.equal(store.responses('home').length, 1);
    assert.equal(store.journal('w-home').length, 2);
    // A new conversation under the old id starts from nothing.
    store.saveConversation(conversation('note-1'));
    assert.equal(store.appendEntry('note-1', entry('fresh')).seq, 1);
    store.deleteConversation('nobody');
  });
  // Counted in the tables themselves: a search joins the entries, and would hide an index
  // row left behind.
  assert.equal(count(file, 'entries'), 5);
  assert.equal(count(file, 'entries_fts_docsize'), 4);
  assert.equal(count(file, 'journal'), 6);
  assert.equal(count(file, 'work_items'), 1);
});

test('a work item that cannot be read never stops its conversation from being deleted', () => {
  const file = freshFile();
  withStore(file, 'writer', (store) => {
    store.saveConversation(conversation('note-1'));
    store.appendJournal(
      work(
        workItem('w1', 'note-1', 'queued', {
          sourceRef: 'note:1',
          chain: { deliveryId: 'd1' },
        } as never),
      ),
    );
    store.appendJournal(work(workItem('w2', 'note-1', 'queued')));
  });
  raw(file, (database) => database.exec(`update work_items set json = 'not json' where id = 'w2'`));
  withStore(file, 'writer', (store) => {
    store.deleteConversation('note-1');
    assert.deepEqual(store.workItems(), []);
    assert.equal(store.isDeletedSource('note:1'), true);
    assert.deepEqual(store.deletedDeliveries(['d1', 'd2']), [{ id: 'w1', deliveryId: 'd1' }]);
  });
  // The unreadable one keeps only its id.
  assert.equal(count(file, 'deleted_work'), 2);
});

test('work items whose conversation is gone are forgotten as a deletion would, the others kept', () => {
  const file = freshFile();
  withStore(file, 'writer', (store) => {
    store.saveConversation(conversation('note-1'));
    store.appendJournal(work(workItem('w-note', 'note-1', 'running')));
    // As 0.5 kept them after deleting a note: a work item of a conversation that is gone.
    store.appendJournal(
      work(workItem('w-gone', 'gone-note', 'queued', { sourceRef: 'note:9' } as never)),
    );
    store.appendJournal(
      work(workItem('w-gone', 'gone-note', 'running', { sourceRef: 'note:9' } as never)),
    );
    store.appendJournal(work(workItem('w-gone-2', 'gone-note', 'awaiting_owner')));
    // The home conversation's, before its record is made at the first start: it is made on
    // first use and never deleted.
    store.appendJournal(work(workItem('w-home', 'home', 'queued')));
    assert.equal(store.forgetWorkWithoutConversation(), 2);
    assert.deepEqual(
      store
        .workItems()
        .map((item) => item.id)
        .sort(),
      ['w-home', 'w-note'],
    );
    assert.deepEqual(store.journal('w-gone'), []);
    assert.equal(store.journal('w-note').length, 1);
    assert.equal(store.isDeletedSource('note:9'), true);
    // Nothing left to forget the next time.
    assert.equal(store.forgetWorkWithoutConversation(), 0);
  });
});

test('an entry and its conversation change together or not at all', () => {
  const { store } = filled([]);
  try {
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
    const home = (): ConversationRecord | undefined =>
      (store.conversations() as ConversationRecord[]).find((record) => record.id === 'home');
    assert.equal(home()?.lastOwnerMessageAt, null);

    store.transaction(() => {
      store.appendEntry('home', entry('去公園散步'));
      store.saveConversation(conversation('home', { lastOwnerMessageAt: AT }));
    });
    assert.equal(store.entries('home').length, 1);
    assert.deepEqual(hits(store, '公園'), ['home#1']);
    assert.equal(home()?.lastOwnerMessageAt, AT);
  } finally {
    store.close();
  }
});

test('a reader beside a reply that streams sees each checkpoint once committed, and holds up no write', () => {
  // SPEC-014 acceptance: WAL behaviour with a reader while a reply streams.
  const { file, store: writing } = filled(['a question']);
  const reading = openBotStateStore({ file, mode: 'reader' });
  const checkpoint = (revision: number, text: string) =>
    ({
      ...entry(text, { kind: 'bot' }),
      seq: 2,
      workItemId: 'w-1',
      presentation: {
        version: 1,
        id: 'p1',
        phase: revision < 3 ? 'streaming' : 'sealed',
        blocks: [],
      },
      presentationRevision: revision,
      presentationSeqs: [2],
    }) as unknown as TranscriptEntry;
  const shown = (): unknown[] =>
    reading.responses('home').map((response) => (response as { text: string }).text);
  try {
    writing.saveResponse('home', checkpoint(1, 'Thinking'));
    assert.deepEqual(shown(), ['Thinking']);
    // The reader holds one snapshot open across the next checkpoints.
    reading.snapshot(() => {
      writing.transaction(() => {
        writing.saveResponse('home', checkpoint(2, 'Thinking about the kettle'));
        // Not committed: the reader still sees the checkpoint before.
        assert.deepEqual(shown(), ['Thinking']);
      });
      // Committed after the reader's snapshot began: still the one before, until it ends.
      assert.deepEqual(shown(), ['Thinking']);
      writing.saveResponse('home', checkpoint(3, 'The kettle is on'));
      writing.appendEntry('home', entry('The kettle is on', { kind: 'bot' }));
    });
    assert.deepEqual(shown(), ['The kettle is on']);
    assert.equal(reading.entries('home').length, 2);
    assert.deepEqual(hits(reading, 'kettle'), ['home#2']);
  } finally {
    reading.close();
    writing.close();
  }
});

test('a reader reads and searches beside the writer, and changes nothing', () => {
  const { file, store: writing } = filled(['今天下午去公園散步']);
  let reading: BotStateStore | undefined;
  const readOnly = (change: () => unknown): void => {
    assert.throws(
      change,
      (error: unknown) => error instanceof StateDatabaseError && error.code === 'read_only',
    );
  };
  try {
    writing.appendJournal(work(workItem('w1', 'home', 'queued')));
    writing.appendJournal(scheduled(schedule('s1', 'home', 'active')));

    reading = openBotStateStore({ file, mode: 'reader' });
    assert.equal(reading.mode, 'reader');
    assert.equal(reading.conversations().length, 2);
    assert.equal(reading.entries('home').length, 1);
    assert.equal(reading.entriesPage('home', { limit: 5 }).length, 1);
    assert.equal(reading.lastSeq('home'), 1);
    assert.equal(reading.workItems().length, 1);
    assert.equal(reading.schedules().length, 1);
    assert.equal(reading.journal().length, 2);
    assert.deepEqual(hits(reading, '公園'), ['home#1']);
    assert.deepEqual(hits(reading, '園', 'home'), ['home#1']);

    readOnly(() => reading!.saveConversation(conversation('note-2')));
    readOnly(() => reading!.appendEntry('home', entry('no')));
    readOnly(() =>
      reading!.saveResponse('home', { presentation: { id: 'p1' } } as unknown as TranscriptEntry),
    );
    readOnly(() => reading!.appendJournal(work(workItem('w2', 'home', 'queued'))));
    readOnly(() => reading!.appendJournal({ type: 'runtime', at: AT, event: 'ready' }));
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
