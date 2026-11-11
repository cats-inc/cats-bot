import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ConversationStore, normalizeConversation } from '../../src/core/conversations/store.ts';
import { writeJsonAtomic } from '../../src/core/store/atomicFile.ts';
import { appendJournal, readJournal } from '../../src/core/store/journal.ts';
import {
  botPathsFor,
  conversationFile,
  transcriptFile,
  type BotPaths,
} from '../../src/core/store/paths.ts';
import { presentationsDirectory, savePresentation } from '../../src/core/store/presentation.ts';
import {
  openBotStateStore,
  type BotStateStore,
  type OpenBotStateStoreOptions,
} from '../../src/core/store/stateStore.ts';
import { appendTranscript, readTranscript } from '../../src/core/store/transcript.ts';
import {
  BLOCKS,
  importVersion1,
  type Version1ImportReport,
  type Version1Problem,
} from '../../src/core/store/version1Import.ts';
import type {
  ConversationRecord,
  JournalEntry,
  ScheduleRecord,
  TranscriptEntry,
  WorkItem,
} from '../../src/core/types.ts';

// A space and a CJK name in the path, as a bot root under a user's profile can have.
const scratch = mkdtempSync(join(tmpdir(), 'cats bot 匯入 '));
after(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;

const AT = '2026-11-11T08:00:00.000Z';
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);

function freshRoot(): BotPaths {
  made += 1;
  const root = join(scratch, `bot-${made}`);
  mkdirSync(root, { recursive: true });
  return botPathsFor(root);
}

function databaseOf(paths: BotPaths): string {
  return join(paths.root, 'bot.db');
}

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

/** As today's core writes an entry: `seq` and `at` first. */
function entry(seq: number, text: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { seq, at: AT, kind: 'owner', origin: 'owner', text, ...extra };
}

function workItem(id: string, conversationId: string, state: WorkItem['state']): WorkItem {
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

function response(seq: number, id: string, revision = 1): TranscriptEntry {
  return {
    seq,
    at: AT,
    kind: 'bot',
    origin: 'owner',
    text: `reply ${id}`,
    workItemId: 'w1',
    presentationRevision: revision,
    presentationSeqs: [seq],
    presentationTerminalSeq: seq,
    presentation: { version: 1, id, phase: 'sealed', blocks: [] },
  } as TranscriptEntry;
}

/** A bot as today's core leaves it: written with today's own writers. */
function versionOneBot(): BotPaths {
  const paths = freshRoot();
  writeJsonAtomic(conversationFile(paths, 'home'), conversation('home'));
  // A field this version does not know survives, and so does the record's own order.
  writeJsonAtomic(conversationFile(paths, 'note-a'), {
    future: { kept: true },
    ...conversation('note-a', { title: '公園的筆記' }),
  });
  appendTranscript(paths, 'home', entry(1, 'hello there'));
  appendTranscript(paths, 'home', entry(2, `zero ${NUL} byte and ${LONE_SURROGATE} half`));
  // A gap, as a line a crash cut short leaves after the next start.
  appendTranscript(
    paths,
    'home',
    entry(5, '我們去公園', { workItemId: 'w1', unknown: [1, 2] } as never),
  );
  appendTranscript(paths, 'note-a', entry(1, 'a note'));
  savePresentation(paths, 'home', response(5, 'p1'));
  savePresentation(paths, 'home', response(5, 'p2'));
  savePresentation(paths, 'home', response(5, 'p1', 2));
  appendJournal(paths, { type: 'work', at: AT, item: workItem('w1', 'home', 'queued') });
  appendJournal(paths, { type: 'presence', at: AT, state: 'online' } as unknown as JournalEntry);
  appendJournal(paths, { type: 'work', at: AT, item: workItem('w2', 'gone', 'completed') });
  appendJournal(paths, { type: 'schedule', at: AT, schedule: schedule('s1', 'home', 'active') });
  appendJournal(paths, { type: 'work', at: AT, item: workItem('w1', 'home', 'completed') });
  appendJournal(paths, { type: 'schedule', at: AT, schedule: schedule('s1', 'home', 'cancelled') });
  return paths;
}

function imported(paths: BotPaths, batchSize?: number): Version1ImportReport {
  return importVersion1({
    paths,
    file: databaseOf(paths),
    now: () => new Date(AT),
    ...(batchSize === undefined ? {} : { batchSize }),
  });
}

function withStore<T>(paths: BotPaths, work: (store: BotStateStore) => T): T {
  const store = openBotStateStore({ file: databaseOf(paths), mode: 'reader' });
  try {
    return work(store);
  } finally {
    store.close();
  }
}

function kinds(report: Version1ImportReport): string[] {
  return report.problems.map((found) => `${found.kind} ${found.file}`).sort();
}

test('a version-1 data root is imported whole, keeping every seq, and marked finished', () => {
  const paths = versionOneBot();
  const report = imported(paths, 2);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.finished, true);
  assert.deepEqual(JSON.parse(JSON.stringify(report.counts)), {
    conversations: 2,
    entries: 4,
    responses: 2,
    journalLines: 6,
    workItems: 2,
    schedules: 1,
    workItemsWithoutConversation: 1,
    perConversation: { home: { entries: 3, responses: 2 }, 'note-a': { entries: 1, responses: 0 } },
  });

  withStore(paths, (store) => {
    // Entries are what today's reader reads, field order and all.
    for (const id of ['home', 'note-a']) {
      assert.equal(
        JSON.stringify(store.entries(id)),
        JSON.stringify(readTranscript(paths, id)),
        id,
      );
    }
    assert.deepEqual(
      store.entries('home').map((item) => item.seq),
      [1, 2, 5],
    );
    assert.equal(store.entries('home')[1]!.text, `zero ${NUL} byte and ${LONE_SURROGATE} half`);
    // The entries are indexed as they are imported.
    assert.deepEqual(
      store.search('公園').map((hit) => `${hit.conversationId}#${hit.entry.seq}`),
      ['home#5'],
    );

    // Conversation records are kept as their files hold them, and today's loader reads them
    // to the same records it reads from the files.
    const loader = new ConversationStore({ paths, now: () => new Date(AT) });
    loader.load();
    const records = store.conversations() as ConversationRecord[];
    assert.deepEqual(
      records.map((record) => record.id).sort(),
      loader
        .list()
        .map((record) => record.id)
        .sort(),
    );
    for (const record of records) {
      assert.deepEqual(normalizeConversation(record, AT), loader.get(record.id), record.id);
    }
    assert.deepEqual(Object.keys(records.find((record) => record.id === 'note-a')!)[0], 'future');

    // The presentation of a reply is its last revision; one row each.
    const replies = store.responses('home') as TranscriptEntry[];
    assert.deepEqual(
      replies.map((reply) => `${reply.presentation!.id}@${reply.presentationRevision}`).sort(),
      ['p1@2', 'p2@1'],
    );

    // The journal line by line, and the current state of each work item and schedule as
    // today's replay finds it.
    const journal = readJournal(paths);
    assert.equal(JSON.stringify(store.journal()), JSON.stringify(journal.entries));
    assert.deepEqual(store.workItems(), [...journal.workItems.values()]);
    assert.deepEqual(store.schedules(), [...journal.schedules.values()]);

    const marker = JSON.parse(store.importMarker()!) as Record<string, unknown>;
    assert.deepEqual(marker, {
      from: 1,
      finishedAt: AT,
      conversations: 2,
      entries: 4,
      responses: 2,
      journalLines: 6,
    });
  });

  // The version-1 files are only read.
  assert.equal(readTranscript(paths, 'home').length, 3);
  // A database that holds records, a finished one included, is refused.
  assert.throws(() => imported(paths), /already holds records/u);
});

test('an empty data root imports to an empty database that is marked finished', () => {
  const paths = freshRoot();
  const report = imported(paths);
  assert.equal(report.finished, true);
  assert.equal(report.counts.conversations, 0);
  withStore(paths, (store) => {
    assert.equal(store.isEmpty(), true);
    assert.notEqual(store.importMarker(), undefined);
  });
});

test('what a crash leaves behind is reported, and the rest imported', () => {
  const paths = versionOneBot();
  // A transcript line cut short by a crash, and one more written after the next start.
  appendFileSync(transcriptFile(paths, 'note-a'), '{"seq":2,"at":"2026-11-1');
  appendFileSync(
    transcriptFile(paths, 'note-a'),
    `${JSON.stringify(entry(3, 'after the crash'))}\n`,
  );
  appendFileSync(transcriptFile(paths, 'note-a'), `${JSON.stringify(entry(4, 'next'))}\n`);
  // A journal line cut short in the middle, and a line that is JSON but not a record.
  appendFileSync(paths.journal, '{"type":"work","at"\n');
  appendFileSync(paths.journal, 'null\n');
  appendJournal(paths, { type: 'work', at: AT, item: workItem('w3', 'note-a', 'queued') });
  // A delete that a crash interrupted after the record went.
  appendTranscript(paths, 'note-gone', entry(1, 'left behind'));
  savePresentation(paths, 'note-gone', response(1, 'p9'));
  // Files no reader of today reads.
  mkdirSync(join(paths.conversations, '.backup'), { recursive: true });
  writeJsonAtomic(join(paths.conversations, '.backup', 'note-a.before-contact-note.json'), {});
  writeFileSync(join(paths.conversations, 'note-a.json.1234.abcd.tmp'), '{');
  writeFileSync(join(paths.transcripts, 'notes.txt'), 'x');

  const report = imported(paths);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.finished, true);
  assert.deepEqual(kinds(report), [
    'no_conversation presentations/note-gone.json',
    'no_conversation transcripts/note-gone.jsonl',
    'not_read conversations/.backup',
    'not_read conversations/note-a.json.1234.abcd.tmp',
    'not_read transcripts/notes.txt',
    'unreadable_line journal.jsonl',
    'unreadable_line transcripts/note-a.jsonl',
  ]);
  const at = (kind: string, file: string): Version1Problem =>
    report.problems.find((found) => found.kind === kind && found.file === file)!;
  // The cut line and the one written onto it are one line that is not JSON.
  assert.deepEqual(at('unreadable_line', 'transcripts/note-a.jsonl').lines, [2]);
  assert.ok(report.problems.every((found) => !found.blocks));

  withStore(paths, (store) => {
    assert.deepEqual(
      store.entries('note-a').map((item) => item.seq),
      [1, 4],
    );
    assert.deepEqual(
      store.entries('home').map((item) => item.seq),
      [1, 2, 5],
    );
    assert.deepEqual(
      (store.conversations() as ConversationRecord[]).map((record) => record.id).sort(),
      ['home', 'note-a'],
    );
    // A line that is JSON is kept as a line, whatever it holds.
    assert.equal(store.journal().length, 8);
    assert.deepEqual(
      store.workItems().map((item) => item.id),
      ['w1', 'w2', 'w3'],
    );
  });
});

test('a sidecar that cannot be read is replaced by its backup, as today, or left out', () => {
  const fromBackup = versionOneBot();
  writeFileSync(join(presentationsDirectory(fromBackup), 'home.json'), '{"version":1,');
  const first = imported(fromBackup);
  assert.deepEqual(first.mismatches, []);
  assert.equal(first.finished, true);
  assert.deepEqual(kinds(first), ['presentation_from_backup presentations/home.json']);
  withStore(fromBackup, (store) => {
    // The backup holds the generation before the last save: p1 at its first revision.
    assert.deepEqual(
      (store.responses('home') as TranscriptEntry[])
        .map((reply) => `${reply.presentation!.id}@${reply.presentationRevision}`)
        .sort(),
      ['p1@1', 'p2@1'],
    );
  });

  const neither = versionOneBot();
  writeFileSync(join(presentationsDirectory(neither), 'home.json'), '{"version":1,');
  writeFileSync(join(presentationsDirectory(neither), 'home.json.bak'), '{"version":1');
  const second = imported(neither);
  assert.equal(second.finished, true);
  assert.deepEqual(kinds(second), ['unreadable_presentation presentations/home.json']);
  withStore(neither, (store) => {
    assert.deepEqual(store.responses('home'), []);
    assert.equal(store.entries('home').length, 3);
  });
});

test('what would lose or change a record shown today stops the import, and every problem is listed', () => {
  const cases: Array<{ name: string; make: (paths: BotPaths) => void; expect: string[] }> = [
    {
      name: 'an entry that does not come after the one before it',
      make: (paths) => {
        appendTranscript(paths, 'note-a', entry(1, 'written twice'));
        appendTranscript(paths, 'home', entry(3, 'earlier than 5'));
      },
      expect: [
        'seq_out_of_order transcripts/home.jsonl',
        'seq_out_of_order transcripts/note-a.jsonl',
      ],
    },
    {
      name: 'a conversation file that is not JSON',
      make: (paths) => writeFileSync(conversationFile(paths, 'note-b'), '{"id":'),
      expect: ['unreadable_conversation conversations/note-b.json'],
    },
    {
      name: 'a conversation record with no id',
      make: (paths) => writeJsonAtomic(conversationFile(paths, 'note-b'), { title: 'no id' }),
      expect: ['unreadable_conversation conversations/note-b.json'],
    },
    {
      name: 'two files that hold one conversation',
      make: (paths) =>
        writeJsonAtomic(conversationFile(paths, 'note-copy'), conversation('note-a')),
      expect: ['conversation_in_two_files conversations/note-a.json'],
    },
    {
      name: 'a sidecar of a later version',
      make: (paths) =>
        writeFileSync(
          join(presentationsDirectory(paths), 'home.json'),
          JSON.stringify({ version: 2, conversationId: 'home', responses: [] }),
        ),
      expect: ['unsupported_presentation presentations/home.json'],
    },
    {
      name: 'a sidecar with no version, or one written as text',
      make: (paths) => {
        writeFileSync(
          join(presentationsDirectory(paths), 'home.json'),
          JSON.stringify({ version: '1', conversationId: 'home', responses: [] }),
        );
      },
      expect: ['unsupported_presentation presentations/home.json'],
    },
    {
      name: 'a sidecar that cannot be read, with a backup that is no sidecar of version 1',
      make: (paths) => {
        writeFileSync(join(presentationsDirectory(paths), 'home.json'), '{');
        writeFileSync(join(presentationsDirectory(paths), 'home.json.bak'), '[]');
      },
      expect: ['unsupported_presentation presentations/home.json'],
    },
    {
      name: 'a transcript line that is JSON but no entry, and what today numbers after it',
      make: (paths) => {
        appendFileSync(
          transcriptFile(paths, 'home'),
          '{"text":"no seq"}\n[6]\n"seven"\n{"seq":0}\n',
        );
        // Today's writer numbers on from the last line it reads.
        appendFileSync(
          transcriptFile(paths, 'note-a'),
          `${JSON.stringify(entry(1.5, 'edited'))}\n`,
        );
        appendFileSync(transcriptFile(paths, 'note-a'), `${JSON.stringify(entry(2.5, 'next'))}\n`);
      },
      expect: ['not_an_entry transcripts/home.jsonl', 'not_an_entry transcripts/note-a.jsonl'],
    },
    {
      name: 'a transcript that cannot be read',
      make: (paths) => {
        rmSync(transcriptFile(paths, 'note-a'));
        mkdirSync(transcriptFile(paths, 'note-a'));
      },
      expect: ['unreadable_file transcripts/note-a.jsonl'],
    },
    {
      name: 'a sidecar that cannot be read, with a backup of a later version',
      make: (paths) => {
        writeFileSync(join(presentationsDirectory(paths), 'home.json'), '{');
        writeFileSync(
          join(presentationsDirectory(paths), 'home.json.bak'),
          JSON.stringify({ version: 2, conversationId: 'home', responses: [] }),
        );
      },
      expect: ['unsupported_presentation presentations/home.json'],
    },
  ];
  for (const { name, make, expect } of cases) {
    const paths = versionOneBot();
    make(paths);
    // A problem that does not block is listed beside the ones that do.
    appendFileSync(paths.journal, '{"cut');
    const report = imported(paths);
    assert.equal(report.finished, false, name);
    // Stopped before the check, which nothing reached.
    assert.deepEqual(report.mismatches, [], name);
    assert.deepEqual(
      kinds(report).filter((line) => !line.startsWith('unreadable_line')),
      expect,
      name,
    );
    assert.ok(kinds(report).includes('unreadable_line journal.jsonl'), name);
    assert.ok(
      report.problems.every((found) => found.blocks === BLOCKS[found.kind]),
      name,
    );
    withStore(paths, (store) => {
      // Nothing is marked finished, and no journal line was written.
      assert.equal(store.importMarker(), undefined, name);
      assert.deepEqual(store.journal(), [], name);
    });
  }
});

test('a conversation is keyed by the id its file holds, as today', () => {
  const paths = freshRoot();
  writeJsonAtomic(join(paths.conversations, 'renamed.json'), conversation('note-a'));
  appendTranscript(paths, 'note-a', entry(1, 'found by its id'));
  const report = imported(paths);
  assert.equal(report.finished, true);
  assert.deepEqual(report.problems, []);
  withStore(paths, (store) => {
    assert.deepEqual(
      store.entries('note-a').map((item) => item.text),
      ['found by its id'],
    );
  });
});

test('a transcript is imported in batches of any size', () => {
  for (const batchSize of [1, 2, 3, 1000]) {
    const paths = freshRoot();
    writeJsonAtomic(conversationFile(paths, 'home'), conversation('home'));
    for (let seq = 1; seq <= 7; seq += 1)
      appendTranscript(paths, 'home', entry(seq * 2, `line ${seq}`));
    const report = imported(paths, batchSize);
    assert.equal(report.finished, true, String(batchSize));
    withStore(paths, (store) => {
      assert.deepEqual(
        store.entries('home').map((item) => item.seq),
        [2, 4, 6, 8, 10, 12, 14],
      );
    });
  }
  assert.throws(() => imported(freshRoot(), 0), /batchSize/u);
});

test('the import needs a new database', () => {
  const paths = versionOneBot();
  const store = openBotStateStore({ file: databaseOf(paths), mode: 'writer' });
  store.appendJournal({ type: 'presence', at: AT } as unknown as JournalEntry);
  store.close();
  assert.throws(() => imported(paths), /already holds records/u);
  assert.equal(existsSync(databaseOf(paths)), true);
});

/** The real store, with one of its calls replaced. */
function opener(
  replace: (store: BotStateStore) => Partial<BotStateStore>,
): (options: OpenBotStateStoreOptions) => BotStateStore {
  return (options) => {
    const store = openBotStateStore(options);
    const replaced = replace(store);
    return new Proxy(store, {
      get: (target, name) =>
        name in replaced ? (replaced as Record<string | symbol, unknown>)[name] : own(target, name),
    });
  };
}

/** A method of the store itself, which reads its private fields through `this`. */
function own(store: BotStateStore, name: string | symbol): unknown {
  const value = Reflect.get(store, name) as unknown;
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => unknown).bind(store)
    : value;
}

function unfinished(paths: BotPaths): void {
  withStore(paths, (store) => {
    assert.equal(store.importMarker(), undefined);
    // The last batch, which holds the journal, was rolled back with the marker.
    assert.deepEqual(store.journal(), []);
    assert.deepEqual(store.workItems(), []);
  });
}

test('a database that does not match the files is not marked finished', () => {
  const paths = versionOneBot();
  const report = importVersion1({
    paths,
    file: databaseOf(paths),
    open: opener((store) => ({
      entries: (id: string) => (id === 'home' ? store.entries(id).slice(1) : store.entries(id)),
    })),
  });
  assert.equal(report.finished, false);
  assert.deepEqual(report.mismatches, [
    'entries of conversation home: 3 in the files, 2 in the database',
    'entry 1 of conversation home differs',
  ]);
  unfinished(paths);

  const unreadable = versionOneBot();
  const second = importVersion1({
    paths: unreadable,
    file: databaseOf(unreadable),
    open: (options) => {
      const store = openBotStateStore(options);
      return new Proxy(store, {
        get: (target, name) =>
          name === 'journal'
            ? () => {
                options.warn?.('journal line 3 cannot be read and was left out');
                return target.journal();
              }
            : own(target, name),
      });
    },
  });
  assert.equal(second.finished, false);
  assert.deepEqual(second.mismatches, [
    'the database holds a record it cannot read: journal line 3 cannot be read and was left out',
  ]);
  unfinished(unreadable);
});

test('an import that stops before its marker leaves no marker and no journal', () => {
  for (const failing of ['setImportMarker', 'appendJournal', 'schedules'] as const) {
    const paths = versionOneBot();
    assert.throws(
      () =>
        importVersion1({
          paths,
          file: databaseOf(paths),
          open: opener(() => ({
            [failing]: () => {
              throw new Error(`stopped at ${failing}`);
            },
          })),
        }),
      new RegExp(`stopped at ${failing}`, 'u'),
    );
    unfinished(paths);
  }
});

test('the journal and the marker are written in one durable transaction, after the rest', () => {
  const paths = versionOneBot();
  const calls: string[] = [];
  let durable = false;
  const report = importVersion1({
    paths,
    file: databaseOf(paths),
    open: opener((store) => ({
      transaction: ((work: () => never, options?: { durable?: boolean }) => {
        calls.push(options?.durable ? 'durable transaction' : 'transaction');
        if (!options?.durable) return store.transaction(work, options);
        durable = true;
        try {
          return store.transaction(work, options);
        } finally {
          durable = false;
        }
      }) as BotStateStore['transaction'],
      importEntries: (id: string, entries: readonly TranscriptEntry[]) => {
        calls.push(durable ? 'entries, durable' : 'entries');
        store.importEntries(id, entries);
      },
      appendJournal: (line: JournalEntry) => {
        calls.push(durable ? 'journal line, durable' : 'journal line');
        store.appendJournal(line);
      },
      setImportMarker: (value: string) => {
        calls.push(durable ? 'marker, durable' : 'marker');
        store.setImportMarker(value);
      },
    })),
  });
  assert.equal(report.finished, true);
  const steps = calls.filter((call, index) => call !== calls[index - 1]);
  assert.deepEqual(steps, [
    'transaction',
    'entries',
    'transaction',
    'entries',
    'transaction',
    'durable transaction',
    'journal line, durable',
    'marker, durable',
  ]);
});

test('the check reads the files again, the directories as well', () => {
  const changes: Array<{ name: string; change: (paths: BotPaths) => void; expect: string }> = [
    {
      name: 'a conversation file changed',
      change: (paths) =>
        writeJsonAtomic(
          conversationFile(paths, 'note-a'),
          conversation('note-a', { title: 'new' }),
        ),
      expect: 'conversation note-a differs',
    },
    {
      name: 'a conversation added',
      change: (paths) => writeJsonAtomic(conversationFile(paths, 'note-b'), conversation('note-b')),
      expect: 'conversations: 3 in the files, 2 in the database',
    },
    {
      name: 'a conversation removed',
      change: (paths) => rmSync(conversationFile(paths, 'note-a')),
      expect: 'conversations: 1 in the files, 2 in the database',
    },
  ];
  for (const { name, change, expect } of changes) {
    const paths = versionOneBot();
    let changed = false;
    const report = importVersion1({
      paths,
      file: databaseOf(paths),
      open: opener((store) => ({
        // The files change after they were read, while the last transaction is open.
        appendJournal: (line: JournalEntry) => {
          if (!changed) change(paths);
          changed = true;
          store.appendJournal(line);
        },
      })),
    });
    assert.equal(report.finished, false, name);
    assert.ok(report.mismatches.includes(expect), `${name}: ${report.mismatches.join('; ')}`);
    unfinished(paths);
  }
});

test('a sidecar read as today reads it, a directory in its place and a later backup too', () => {
  const directory = versionOneBot();
  rmSync(join(presentationsDirectory(directory), 'home.json'));
  mkdirSync(join(presentationsDirectory(directory), 'home.json'));
  const first = imported(directory);
  assert.equal(first.finished, true);
  assert.deepEqual(kinds(first), ['presentation_from_backup presentations/home.json']);
  withStore(directory, (store) => assert.equal(store.responses('home').length, 2));

  // A backup of a later version beside a sidecar that is read: today's writer leaves it.
  const later = versionOneBot();
  writeFileSync(
    join(presentationsDirectory(later), 'home.json.bak'),
    JSON.stringify({ version: 2, conversationId: 'home', responses: [] }),
  );
  const second = imported(later);
  assert.equal(second.finished, true);
  assert.deepEqual(kinds(second), ['not_read presentations/home.json.bak']);
});

test('a number JSON cannot keep is a difference, and odd ids are counted', () => {
  const paths = versionOneBot();
  // Too large for a double: read as Infinity, which JSON writes as null.
  writeFileSync(
    conversationFile(paths, 'note-b'),
    '{"id":"note-b","role":"note","unreadCount":1e999}',
  );
  const report = imported(paths);
  assert.equal(report.finished, false);
  assert.deepEqual(report.mismatches, ['conversation note-b differs']);
  unfinished(paths);

  const odd = freshRoot();
  writeJsonAtomic(conversationFile(odd, '__proto__'), conversation('__proto__'));
  appendTranscript(odd, '__proto__', entry(1, 'kept'));
  const counted = imported(odd);
  assert.equal(counted.finished, true);
  assert.equal(
    JSON.stringify(counted.counts.perConversation),
    '{"__proto__":{"entries":1,"responses":0}}',
  );
});

test(
  "a file named in another case is the conversation's own where the file system ignores case",
  { skip: process.platform !== 'win32' && process.platform !== 'darwin' },
  () => {
    const paths = freshRoot();
    writeJsonAtomic(conversationFile(paths, 'Note-A'), conversation('Note-A'));
    mkdirSync(paths.transcripts, { recursive: true });
    writeFileSync(join(paths.transcripts, 'note-a.jsonl'), `${JSON.stringify(entry(1, 'one'))}\n`);
    const report = imported(paths);
    assert.equal(report.finished, true);
    assert.deepEqual(report.problems, []);
    withStore(paths, (store) => assert.equal(store.entries('Note-A').length, 1));
  },
);
