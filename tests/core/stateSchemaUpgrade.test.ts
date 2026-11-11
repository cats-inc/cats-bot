import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { ConversationStore } from '../../src/core/conversations/store.ts';
import { botPathsFor, stateDatabaseFile } from '../../src/core/store/paths.ts';
import { sqliteDriver } from '../../src/core/store/sqliteDriver.ts';
import { responseCovers, STATE_SCHEMA_VERSION } from '../../src/core/store/stateSchema.ts';
import { openBotStateStore } from '../../src/core/store/stateStore.ts';
import type { TranscriptEntry } from '../../src/core/types.ts';
import { makeTempHome } from '../support/harness.ts';

/**
 * SPEC-014 FR-10: version 2 of the state database adds `responses.covers` and the indexes a
 * page of the note reads by. A writer brings a version-1 database, as builds of `main` made
 * them before, to version 2 in one transaction; a reader reads it as it is.
 */

const AT = '2026-11-12T08:00:00.000Z';
const NEW_INDEXES = ['entries_bot_by_work_item', 'responses_by_seq', 'responses_by_span'];

function presentation(
  workItemId: string,
  seq: number,
  covers: number[],
  terminal?: number,
): TranscriptEntry {
  return {
    seq,
    at: AT,
    kind: 'bot',
    origin: 'owner',
    text: `reply of ${workItemId}`,
    workItemId,
    presentationRevision: 1,
    presentationSeqs: covers,
    ...(terminal === undefined ? {} : { presentationTerminalSeq: terminal }),
    presentation: { version: 1, id: `${workItemId}:p`, phase: 'sealed', blocks: [] },
  };
}

/** A version-2 database with two replies, brought back to version 1's shape. */
function versionOneDatabase(t: { after(fn: () => void): void }): { file: string; id: string } {
  const home = makeTempHome('cats-bot-schema-upgrade-');
  t.after(() => home.cleanup());
  const paths = botPathsFor(home.botsHome);
  mkdirSync(paths.root, { recursive: true });
  const file = stateDatabaseFile(paths);
  const db = openBotStateStore({ file, mode: 'writer' });
  let id: string;
  try {
    const conversations = new ConversationStore({ store: () => db, now: () => new Date(AT) });
    conversations.load();
    ({ id } = conversations.home());
    const add = (kind: TranscriptEntry['kind'], workItemId: string) =>
      conversations.append(id, { kind, text: kind, origin: 'owner', workItemId }).seq;
    add('owner', 'w1');
    const w1 = [add('tool_use', 'w1'), add('tool_result', 'w1')];
    const a1 = add('bot', 'w1');
    conversations.savePresentation(id, presentation('w1', w1[0]!, w1, a1));
    add('owner', 'w2');
    const w2 = [add('tool_use', 'w2'), add('error', 'w2')];
    conversations.savePresentation(id, presentation('w2', w2[0]!, w2));
  } finally {
    db.close();
  }
  const { DatabaseSync } = sqliteDriver();
  const raw = new DatabaseSync(file);
  try {
    for (const index of NEW_INDEXES) raw.exec(`drop index ${index}`);
    raw.exec('alter table responses drop column covers');
    // One presentation that is no longer JSON, which the upgrade must pass over.
    raw.exec(
      `insert into responses(conversation_id, presentation_id, seq, json) values ('${id}', 'broken', 9, '{"seq":')`,
    );
    raw.exec(`update meta set value = '1' where key = 'schema_version'`);
  } finally {
    raw.close();
  }
  return { file, id };
}

function inspect(file: string): {
  version: unknown;
  columns: string[];
  indexes: string[];
  covers: Array<[string, unknown]>;
} {
  const { DatabaseSync } = sqliteDriver();
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const columns = raw
      .prepare('pragma table_info(responses)')
      .all()
      .map((row) => String(row.name));
    return {
      version: raw.prepare(`select value from meta where key = 'schema_version'`).get()?.value,
      columns,
      indexes: raw
        .prepare(
          `select name from sqlite_master where type = 'index' and name not like 'sqlite_%' order by name`,
        )
        .all()
        .map((row) => String(row.name))
        .filter((name) => NEW_INDEXES.includes(name)),
      covers: columns.includes('covers')
        ? raw
            .prepare('select presentation_id, covers from responses order by presentation_id')
            .all()
            .map((row) => [String(row.presentation_id), row.covers])
        : [],
    };
  } finally {
    raw.close();
  }
}

test('a writer brings a version-1 database to version 2: the column filled, the indexes made', (t) => {
  const { file, id } = versionOneDatabase(t);
  assert.equal(STATE_SCHEMA_VERSION, 2);
  // A reader reads it as it is, and changes nothing.
  const reader = openBotStateStore({ file, mode: 'reader' });
  try {
    assert.equal(reader.responses(id).length, 2);
  } finally {
    reader.close();
  }
  assert.deepEqual(inspect(file), {
    version: '1',
    columns: ['conversation_id', 'presentation_id', 'seq', 'revision', 'phase', 'json'],
    indexes: [],
    covers: [],
  });

  const writer = openBotStateStore({ file, mode: 'writer' });
  try {
    const conversations = new ConversationStore({ store: () => writer, now: () => new Date(AT) });
    conversations.load();
    const whole = conversations.presentationTranscript(id);
    for (let limit = 1; limit <= 9; limit += 1) {
      const pages: TranscriptEntry[][] = [];
      let beforeSeq: number | undefined;
      for (;;) {
        const page = conversations.presentationPage(id, { limit, beforeSeq });
        pages.unshift(page.entries);
        if (page.olderBeforeSeq === null) break;
        beforeSeq = page.olderBeforeSeq;
      }
      assert.deepEqual(pages.flat(), whole, `limit ${limit}`);
    }
    const stored = writer
      .responses(id)
      .map((raw) => [(raw as TranscriptEntry).presentation!.id, responseCovers(raw)]);
    assert.deepEqual(stored, [
      ['w1:p', 4],
      ['w2:p', 7],
    ]);
  } finally {
    writer.close();
  }
  const upgraded = inspect(file);
  assert.equal(upgraded.version, String(STATE_SCHEMA_VERSION));
  assert.ok(upgraded.columns.includes('covers'));
  assert.deepEqual(upgraded.indexes, NEW_INDEXES);
  assert.deepEqual(upgraded.covers, [
    ['broken', null],
    ['w1:p', 4],
    ['w2:p', 7],
  ]);
  // Opened again, nothing is left to do.
  openBotStateStore({ file, mode: 'writer' }).close();
  assert.deepEqual(inspect(file), upgraded);
});

test('an upgrade that fails leaves the database at version 1, as it was', (t) => {
  const { file } = versionOneDatabase(t);
  // Something in the way of one of the indexes the upgrade makes.
  const { DatabaseSync } = sqliteDriver();
  const raw = new DatabaseSync(file);
  try {
    raw.exec('create index responses_by_span on responses(seq)');
  } finally {
    raw.close();
  }
  const before = inspect(file);
  assert.throws(() => openBotStateStore({ file, mode: 'writer' }), /responses_by_span/u);
  assert.deepEqual(inspect(file), before);
  assert.equal(before.version, '1');
  assert.equal(before.columns.includes('covers'), false);
});

test('covers is the highest seq a presentation covers, from a loop over any number of seqs', () => {
  assert.equal(responseCovers(presentation('w', 5, [5, 6, 9], 12)), 12);
  assert.equal(responseCovers(presentation('w', 5, [5, 6, 9])), 9);
  assert.equal(responseCovers(presentation('w', 5, [])), 5);
  assert.equal(
    responseCovers({
      seq: 5,
      presentationSeqs: [7, '99', 1.5, null],
      presentationTerminalSeq: 'x',
    }),
    7,
  );
  assert.equal(responseCovers({ seq: 'five' }), null);
  assert.equal(responseCovers(null), null);
  const long = Array.from({ length: 300_000 }, (_, index) => index + 10);
  assert.equal(responseCovers({ seq: 10, presentationSeqs: long }), 300_009);
});
