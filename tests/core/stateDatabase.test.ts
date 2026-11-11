import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { sqliteDriver } from '../../src/core/store/sqliteDriver.ts';
import {
  existingDatabaseUri,
  openStateDatabase,
  StateDatabaseError,
  type StateDatabase,
  type StateDatabaseErrorCode,
} from '../../src/core/store/stateDatabase.ts';
import { STATE_APPLICATION_ID, STATE_SCHEMA_VERSION } from '../../src/core/store/stateSchema.ts';

/**
 * PLAN-014 task 1.1, SPEC-014 FR-1, FR-2 and FR-4: the storage adapter. Like the driver
 * acceptance, this file also runs inside Electron in CI (`npm run test:electron`).
 */

const scratch = mkdtempSync(join(tmpdir(), 'cats bot 狀態 '));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

let directories = 0;
function freshDirectory(): string {
  directories += 1;
  const directory = join(scratch, `case ${directories}`);
  mkdirSync(directory);
  return directory;
}

function files(directory: string): string[] {
  return readdirSync(directory).sort();
}

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function throwsCode(work: () => unknown, code: StateDatabaseErrorCode): void {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof StateDatabaseError, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}

function writer(file: string): StateDatabase {
  return openStateDatabase({ file, mode: 'writer' });
}

function reader(file: string): StateDatabase {
  return openStateDatabase({ file, mode: 'reader' });
}

/** A cleanly stopped bot's database holding one conversation. */
function stoppedBot(): { directory: string; file: string } {
  const directory = freshDirectory();
  const file = join(directory, 'bot.db');
  const database = writer(file);
  try {
    database.run('insert into conversations(id, json) values (?, ?)', 'home', '{"id":"home"}');
  } finally {
    database.close();
  }
  return { directory, file };
}

function conversations(database: StateDatabase): string[] {
  return database.all('select id from conversations order by id').map((row) => String(row.id));
}

/** A second look through the driver itself, for what the adapter must not have changed. */
function raw<T>(
  file: string,
  read: (database: InstanceType<ReturnType<typeof sqliteDriver>['DatabaseSync']>) => T,
): T {
  const { DatabaseSync } = sqliteDriver();
  const database = new DatabaseSync(file);
  try {
    return read(database);
  } finally {
    database.close();
  }
}

test('a writer creates the schema on a new file and records what wrote it', () => {
  const directory = freshDirectory();
  const file = join(directory, 'bot.db');
  const database = openStateDatabase({
    file,
    mode: 'writer',
    now: () => new Date('2026-11-11T08:00:00.000Z'),
  });
  try {
    assert.equal(database.mode, 'writer');
    assert.equal(database.file, file);
    assert.equal(database.isOpen, true);
    const tables = database
      .all(
        `select name from sqlite_master where type = 'table' and name not like 'entries_fts_%' and name not like 'sqlite_%' order by name`,
      )
      .map((row) => row.name);
    assert.deepEqual(tables, [
      'conversations',
      'deleted_work',
      'entries',
      'entries_fts',
      'journal',
      'meta',
      'responses',
      'schedules',
      'work_items',
    ]);
    assert.equal(database.meta('schema_version'), String(STATE_SCHEMA_VERSION));
    assert.equal(database.meta('created_at'), '2026-11-11T08:00:00.000Z');
    assert.equal(database.meta('absent'), undefined);
    const runtime = JSON.parse(database.meta('runtime') ?? 'null') as {
      node: string;
      electron: string | null;
      sqlite: string;
      unicode: string | null;
    };
    assert.equal(runtime.node, process.versions.node);
    assert.equal(runtime.electron, process.versions.electron ?? null);
    assert.match(runtime.sqlite, /^\d+\.\d+\.\d+/u);
    assert.equal(runtime.unicode, process.versions.unicode ?? null);
    assert.equal(database.get('pragma application_id')?.application_id, STATE_APPLICATION_ID);
    assert.equal(database.get('pragma journal_mode')?.journal_mode, 'wal');
    assert.equal(database.get('pragma synchronous')?.synchronous, 1);
  } finally {
    database.close();
  }
  assert.deepEqual(files(directory), ['bot.db']);

  // A later start keeps what the first one stored.
  const later = openStateDatabase({
    file,
    mode: 'writer',
    now: () => new Date('2030-01-01T00:00:00.000Z'),
  });
  try {
    assert.equal(later.meta('created_at'), '2026-11-11T08:00:00.000Z');
    later.setMeta('note', 'first');
    later.setMeta('note', 'second');
    assert.equal(later.meta('note'), 'second');
  } finally {
    later.close();
  }
  const third = writer(file);
  try {
    assert.equal(third.meta('note'), 'second');
  } finally {
    third.close();
  }
});

test('each table keeps a JSON record, with index columns that may be empty', () => {
  const database = writer(join(freshDirectory(), 'bot.db'));
  try {
    database.run('insert into conversations(id, json) values (?, ?)', 'c1', '{}');
    assert.throws(
      () => database.run('insert into conversations(id, json) values (?, ?)', 'c2', null),
      /NOT NULL constraint failed: conversations\.json/u,
    );
    assert.throws(
      () => database.run('insert into conversations(id, json) values (?, ?)', 'c1', '{}'),
      /UNIQUE constraint failed: conversations\.id/u,
    );

    const insertEntry = 'insert into entries(conversation_id, seq, json) values (?, ?, ?)';
    const first = database.insert(insertEntry, 'c1', 1, '{}');
    assert.throws(
      () => database.run(insertEntry, 'c1', 1, '{}'),
      /UNIQUE constraint failed: entries\.conversation_id, entries\.seq/u,
    );
    assert.throws(
      () => database.run(insertEntry, 'c1', 'two', '{}'),
      /cannot store TEXT value in INTEGER column/u,
    );
    const second = database.insert(insertEntry, 'c1', 2, '{}');
    // A deleted entry's row id is never handed out again.
    assert.equal(database.run('delete from entries where id = ?', second), 1);
    assert.equal(database.run('delete from entries where id = ?', second), 0);
    const third = database.insert(insertEntry, 'c1', 2, '{}');
    assert.ok(third > second, `${third} reuses ${second}`);

    database.run(
      'insert into entries_fts(rowid, terms) values (?, ?)',
      first,
      'remember the kettle',
    );
    assert.equal(
      database.get(`select rowid from entries_fts where entries_fts match 'kettle'`)?.rowid,
      first,
    );
    database.run('delete from entries_fts where rowid = ?', first);
    assert.equal(
      database.get(`select rowid from entries_fts where entries_fts match 'kettle'`),
      undefined,
    );

    const saveResponse =
      'insert into responses(conversation_id, presentation_id, revision, json) values (?, ?, ?, ?) on conflict(conversation_id, presentation_id) do update set revision = excluded.revision, json = excluded.json';
    database.run(saveResponse, 'c1', 'p1', 1, '{"revision":1}');
    database.run(saveResponse, 'c1', 'p1', 2, '{"revision":2}');
    assert.deepEqual(
      { ...database.get('select count(*) as n, max(revision) as revision from responses') },
      { n: 1, revision: 2 },
    );

    database.run('insert into work_items(id, json) values (?, ?)', 'w1', '{}');
    database.run('insert into schedules(id, json) values (?, ?)', 's1', '{}');
    // The journal keeps its lines in the order they were written, and never reuses an id.
    const line = 'insert into journal(type, ref, json) values (?, ?, ?)';
    const ids = [
      database.insert(line, 'work', 'w1', '{}'),
      database.insert(line, 'runtime', null, '{}'),
      database.insert(line, 'work', 'w1', '{}'),
    ];
    assert.deepEqual(
      database.all(`select id from journal where ref = ? order by id`, 'w1').map((row) => row.id),
      [ids[0], ids[2]],
    );
    database.run('delete from journal where id = ?', ids[2]!);
    assert.ok(database.insert(line, 'runtime', null, '{}') > ids[2]!);
  } finally {
    database.close();
  }
});

test('a database from a newer version is refused and left as it was', () => {
  const { directory, file } = stoppedBot();
  raw(file, (database) =>
    database
      .prepare(`update meta set value = ? where key = 'schema_version'`)
      .run(String(STATE_SCHEMA_VERSION + 1)),
  );
  const before = digest(file);

  throwsCode(() => writer(file), 'newer_schema');
  throwsCode(() => reader(file), 'newer_schema');
  assert.throws(
    () => writer(file),
    /written by a newer Cats Bot \(schema 2; this version reads up to 1\)/u,
  );

  assert.equal(digest(file), before);
  assert.deepEqual(files(directory), ['bot.db']);
  assert.equal(
    raw(file, (database) => database.prepare('select count(*) as n from conversations').get()?.n),
    1,
  );
});

test('a file that is not a bot state database is refused and left as it was', () => {
  const directory = freshDirectory();

  const text = join(directory, 'text.db');
  const words = 'this is a note somebody saved under the wrong name. '.repeat(8);
  writeFileSync(text, words);
  throwsCode(() => writer(text), 'not_a_bot_database');
  throwsCode(() => reader(text), 'not_a_bot_database');
  assert.equal(readFileSync(text, 'utf8'), words);

  // Someone else's database, in the journal mode SQLite gives a new file. Neither its bytes
  // nor that mode may change: a writer switches to write-ahead logging only once it knows
  // the file is a bot's.
  const refusedUntouched = (file: string): void => {
    const before = digest(file);
    throwsCode(() => writer(file), 'not_a_bot_database');
    throwsCode(() => reader(file), 'not_a_bot_database');
    assert.equal(digest(file), before);
    assert.equal(
      raw(file, (database) => database.prepare('pragma journal_mode').get()?.journal_mode),
      'delete',
    );
  };

  const foreign = join(directory, 'foreign.db');
  raw(foreign, (database) =>
    database.exec(`create table theirs(a); insert into theirs values ('kept')`),
  );
  refusedUntouched(foreign);

  const unversioned = join(directory, 'unversioned.db');
  raw(unversioned, (database) =>
    database.exec(`pragma application_id=${STATE_APPLICATION_ID}; create table other(a)`),
  );
  refusedUntouched(unversioned);

  // The right mark, and a table of the right name that is something else.
  const misshapen = join(directory, 'misshapen.db');
  raw(misshapen, (database) =>
    database.exec(`pragma application_id=${STATE_APPLICATION_ID}; create table meta(k, v)`),
  );
  refusedUntouched(misshapen);

  const garbled = join(directory, 'garbled.db');
  writer(garbled).close();
  raw(garbled, (database) =>
    database.exec(`update meta set value = 'one' where key = 'schema_version'`),
  );
  const before = digest(garbled);
  throwsCode(() => writer(garbled), 'not_a_bot_database');
  throwsCode(() => reader(garbled), 'not_a_bot_database');
  assert.equal(digest(garbled), before);
  assert.deepEqual(files(directory), [
    'foreign.db',
    'garbled.db',
    'misshapen.db',
    'text.db',
    'unversioned.db',
  ]);
});

test('a reader never creates a database, and reads none that a writer has not finished', () => {
  const directory = freshDirectory();
  throwsCode(() => reader(join(directory, 'bot.db')), 'missing');
  assert.deepEqual(files(directory), []);

  // What a writer leaves if it stops before anything is written.
  const empty = join(directory, 'empty.db');
  writeFileSync(empty, '');
  throwsCode(() => reader(empty), 'missing');
  assert.equal(statSync(empty).size, 0);

  // And if it stops after switching to write-ahead logging, before the schema.
  const started = join(directory, 'started.db');
  raw(started, (database) => database.exec('pragma journal_mode=wal'));
  assert.ok(statSync(started).size > 0);
  throwsCode(() => reader(started), 'missing');
  assert.deepEqual(files(directory), ['empty.db', 'started.db']);

  // The next writer finishes both.
  for (const file of [empty, started]) {
    writer(file).close();
    const reading = reader(file);
    try {
      assert.equal(reading.meta('schema_version'), String(STATE_SCHEMA_VERSION));
    } finally {
      reading.close();
    }
  }
  assert.deepEqual(files(directory), ['empty.db', 'started.db']);
});

test('a schema that could not be finished leaves nothing behind', () => {
  const directory = freshDirectory();
  const file = join(directory, 'bot.db');
  // The clock is read after the tables are made, inside the same transaction.
  assert.throws(
    () =>
      openStateDatabase({
        file,
        mode: 'writer',
        now: () => {
          throw new Error('stopped half-way');
        },
      }),
    /stopped half-way/u,
  );
  assert.deepEqual(files(directory), ['bot.db']);
  assert.deepEqual(
    raw(file, (database) => [
      database.prepare('select count(*) as n from sqlite_master').get()?.n,
      database.prepare('pragma application_id').get()?.application_id,
    ]),
    [0, 0],
  );
  throwsCode(() => reader(file), 'missing');

  const database = writer(file);
  try {
    assert.equal(database.meta('schema_version'), String(STATE_SCHEMA_VERSION));
    assert.equal(database.get('pragma application_id')?.application_id, STATE_APPLICATION_ID);
  } finally {
    database.close();
  }
});

test('a reader beside the writer sees its commits and accepts only queries', () => {
  const { directory, file } = stoppedBot();
  const writing = writer(file);
  let reading: StateDatabase | undefined;
  try {
    reading = reader(file);
    assert.equal(reading.mode, 'reader');
    assert.deepEqual(conversations(reading), ['home']);
    assert.equal(reading.meta('schema_version'), String(STATE_SCHEMA_VERSION));
    assert.deepEqual(
      reading
        .all('with recent as (select id from conversations) select id from recent')
        .map((row) => row.id),
      ['home'],
    );

    const insert = `insert into conversations(id, json) values ('from the reader', '{}')`;
    throwsCode(() => reading!.run(insert), 'read_only');
    throwsCode(() => reading!.setMeta('note', 'no'), 'read_only');
    throwsCode(() => reading!.transaction(() => undefined), 'read_only');
    // Statements SQLite itself would let a `query_only` connection run.
    throwsCode(() => reading!.get('pragma journal_mode=delete'), 'read_only');
    throwsCode(() => reading!.get('pragma query_only=off'), 'read_only');
    throwsCode(() => reading!.get('pragma wal_checkpoint(truncate)'), 'read_only');
    throwsCode(() => reading!.all(insert), 'read_only');
    // And a change dressed as a query, which `query_only` would reject in any case.
    assert.throws(
      () => reading!.get(`with one as (select 1) ${insert}`),
      /get\(\) and all\(\) read/u,
    );

    writing.run('insert into conversations(id, json) values (?, ?)', 'note-1', '{}');
    assert.deepEqual(conversations(reading), ['home', 'note-1']);

    // One snapshot, taken before the work starts: a commit made inside it is not seen,
    // even when it comes before the first query.
    reading.snapshot(() => {
      writing.run('insert into conversations(id, json) values (?, ?)', 'note-2', '{}');
      assert.deepEqual(conversations(reading!), ['home', 'note-1']);
      writing.run('insert into conversations(id, json) values (?, ?)', 'note-3', '{}');
      assert.deepEqual(conversations(reading!), ['home', 'note-1']);
    });
    assert.deepEqual(conversations(reading), ['home', 'note-1', 'note-2', 'note-3']);
    assert.equal(writing.get('pragma journal_mode')?.journal_mode, 'wal');
  } finally {
    reading?.close();
    writing.close();
  }
  assert.deepEqual(files(directory), ['bot.db']);

  // Beside a stopped bot the reader still reads, and leaves only the database behind.
  const alone = reader(file);
  try {
    assert.deepEqual(conversations(alone), ['home', 'note-1', 'note-2', 'note-3']);
  } finally {
    alone.close();
  }
  assert.deepEqual(files(directory), ['bot.db']);
});

test('a change reports its rows even when the index leaves a row id no number can hold', () => {
  const database = writer(join(freshDirectory(), 'bot.db'));
  try {
    // Index rows written in one transaction share a segment. Deleting them one by one
    // afterwards makes SQLite's last row id one of the index's own, beyond 2^53: with the
    // driver's default the second delete throws on Node.js 26 and is rounded on Node.js 24.
    database.transaction(() => {
      for (let rowid = 1; rowid <= 6; rowid += 1) {
        database.run(
          'insert into entries_fts(rowid, terms) values (?, ?)',
          rowid,
          `word${rowid} common`,
        );
      }
    });
    for (let rowid = 1; rowid <= 3; rowid += 1) {
      assert.equal(database.run('delete from entries_fts where rowid = ?', rowid), 1);
    }
    // And inside one transaction, where a throw would have undone the deletes: the way a
    // conversation's index rows go, followed by a statement that is not an insert.
    database.run('insert into conversations(id, json) values (?, ?)', 'gone', '{}');
    database.transaction(() => {
      assert.equal(database.run('delete from entries_fts where rowid in (4, 5, 6)'), 3);
      assert.equal(database.run('delete from conversations where id = ?', 'gone'), 1);
    });
    assert.deepEqual(conversations(database), []);
    assert.equal(
      database.get(`select count(*) as n from entries_fts where entries_fts match 'common'`)?.n,
      0,
    );
    // A statement on an ordinary table afterwards is unaffected, and an insert still
    // reports its own row.
    assert.equal(database.run('insert into conversations(id, json) values (?, ?)', 'c1', '{}'), 1);
    assert.equal(database.run(`update conversations set json = '{"a":1}' where id = ?`, 'c1'), 1);
    assert.equal(database.run('delete from conversations where id = ?', 'nobody'), 0);
    const entry = database.insert(
      'insert into entries(conversation_id, seq, json) values (?, ?, ?)',
      'c1',
      1,
      '{}',
    );
    assert.equal(database.get('select id from entries where conversation_id = ?', 'c1')?.id, entry);
  } finally {
    database.close();
  }
});

test('a transaction is all or nothing', () => {
  const database = writer(join(freshDirectory(), 'bot.db'));
  const add = (id: string): void => {
    database.run('insert into conversations(id, json) values (?, ?)', id, '{}');
  };
  try {
    assert.equal(
      database.transaction(() => {
        add('a');
        add('b');
        return 'done';
      }),
      'done',
    );
    assert.deepEqual(conversations(database), ['a', 'b']);

    assert.throws(
      () =>
        database.transaction(() => {
          add('c');
          throw new Error('stop');
        }),
      /stop/u,
    );
    assert.deepEqual(conversations(database), ['a', 'b']);

    // A nested call joins the outer transaction.
    database.transaction(() => {
      add('c');
      database.transaction(() => add('d'));
    });
    assert.deepEqual(conversations(database), ['a', 'b', 'c', 'd']);

    // Nested work that changed rows and then failed takes the whole transaction with it,
    // even when the outer code carries on: half of it must not be kept. The failure the
    // caller did not see is what the error carries.
    for (const nested of ['transaction', 'snapshot'] as const) {
      try {
        database.transaction(() => {
          add('e');
          try {
            database[nested](() => {
              add('f');
              throw new Error('inner write');
            });
          } catch {
            // carried on regardless
          }
          add('g');
        });
        assert.fail('the transaction should have failed');
      } catch (error) {
        assert.match((error as Error).message, /Nested work changed rows and then failed/u);
        assert.match(String((error as Error).cause), /inner write/u);
      }
      assert.deepEqual(conversations(database), ['a', 'b', 'c', 'd']);
    }

    // Nested work that failed before it changed anything left nothing half made, so it is
    // the caller's to handle and the transaction goes on: a read that failed, a statement
    // that found nothing to change, or one that failed and was undone by SQLite itself.
    database.transaction(() => {
      add('e');
      for (const nested of ['transaction', 'snapshot'] as const) {
        assert.throws(
          () =>
            database[nested](() => {
              conversations(database);
              assert.equal(database.run('delete from conversations where id = ?', 'nobody'), 0);
              assert.throws(() => add('e'), /UNIQUE constraint failed/u);
              // An insert that added no row is refused, and changed nothing either.
              assert.throws(
                () =>
                  database.insert(
                    'insert or ignore into conversations(id, json) values (?, ?)',
                    'a',
                    '{}',
                  ),
                /exactly one row/u,
              );
              throw new Error('inner read');
            }),
          /inner read/u,
        );
      }
      add('f');
    });
    assert.deepEqual(conversations(database), ['a', 'b', 'c', 'd', 'e', 'f']);
    database.run(`delete from conversations where id in ('e', 'f')`);

    // Work that returns a promise would commit before it had finished. The types refuse it,
    // and so does the adapter when the types are not looking.
    assert.throws(
      () =>
        // @ts-expect-error a transaction's work may not be asynchronous
        database.transaction(async () => {
          add('h');
        }),
      /must be synchronous/u,
    );
    assert.deepEqual(conversations(database), ['a', 'b', 'c', 'd']);

    // A snapshot opened on its own is for reading: it takes no change and no transaction.
    database.snapshot(() => {
      assert.throws(() => add('i'), /A snapshot is for reading/u);
      assert.throws(
        () => database.insert('insert into conversations(id, json) values (?, ?)', 'i', '{}'),
        /A snapshot is for reading/u,
      );
      assert.throws(() => database.transaction(() => add('i')), /A snapshot is for reading/u);
      assert.deepEqual(
        database.snapshot(() => conversations(database)),
        ['a', 'b', 'c', 'd'],
      );
    });
    assert.deepEqual(conversations(database), ['a', 'b', 'c', 'd']);
    // And the database takes changes again once it has ended, however it ended.
    assert.throws(
      () =>
        database.snapshot(() => {
          throw new Error('stop reading');
        }),
      /stop reading/u,
    );
    database.transaction(() => add('i'));
    assert.deepEqual(conversations(database), ['a', 'b', 'c', 'd', 'i']);
  } finally {
    database.close();
  }
});

test('a durable transaction is synced when it commits, and only as the outermost one', () => {
  const database = writer(join(freshDirectory(), 'bot.db'));
  const add = (id: string): void => {
    database.run('insert into conversations(id, json) values (?, ?)', id, '{}');
  };
  const level = (): unknown => database.get('pragma synchronous')?.synchronous;
  try {
    assert.equal(level(), 1);
    database.transaction(
      () => {
        assert.equal(level(), 2);
        add('a');
        // Nested work joins it.
        database.transaction(() => add('b'));
      },
      { durable: true },
    );
    assert.equal(level(), 1);
    assert.deepEqual(conversations(database), ['a', 'b']);

    // The setting comes back after a failure as well.
    assert.throws(
      () =>
        database.transaction(
          () => {
            add('c');
            throw new Error('stop');
          },
          { durable: true },
        ),
      /stop/u,
    );
    assert.equal(level(), 1);
    assert.deepEqual(conversations(database), ['a', 'b']);

    // SQLite keeps the setting it had when the transaction began.
    assert.throws(
      () => database.transaction(() => database.transaction(() => add('d'), { durable: true })),
      /must be the outermost one/u,
    );
    assert.throws(
      () => database.snapshot(() => database.transaction(() => add('d'), { durable: true })),
      /A snapshot is for reading/u,
    );
    assert.equal(level(), 1);
    assert.deepEqual(conversations(database), ['a', 'b']);
  } finally {
    database.close();
  }
});

test('a transaction SQLite ended by itself keeps nothing, and nothing written after it', () => {
  const database = writer(join(freshDirectory(), 'bot.db'));
  const add = (id: string): number =>
    database.run('insert into conversations(id, json) values (?, ?)', id, '{}');
  const lost = (work: () => unknown): void => throwsCode(work, 'transaction_lost');
  try {
    add('kept');
    // `or rollback` ends the whole transaction on a conflict, as a full disk would. Code
    // that catches the error and carries on must not have its next statements committed
    // one by one outside any transaction.
    lost(() =>
      database.transaction(() => {
        add('a');
        try {
          database.run(
            'insert or rollback into conversations(id, json) values (?, ?)',
            'kept',
            '{}',
          );
        } catch {
          // carried on regardless
        }
        lost(() => add('b'));
        lost(() => database.get('select count(*) as n from conversations'));
        lost(() => database.transaction(() => add('c')));
      }),
    );
    assert.deepEqual(conversations(database), ['kept']);
    // The database is usable afterwards.
    database.transaction(() => add('next'));
    assert.deepEqual(conversations(database), ['kept', 'next']);
  } finally {
    database.close();
  }
});

test('one statement at a time, and transactions only through the adapter', () => {
  const database = writer(join(freshDirectory(), 'bot.db'));
  try {
    // The driver would run the first statement and drop the second without a word.
    assert.throws(
      () =>
        database.run(
          `insert into conversations(id, json) values ('a', '{}'); delete from conversations`,
        ),
      /One statement at a time/u,
    );
    assert.throws(
      () => database.get('select 1 as one; select 2 as two'),
      /One statement at a time/u,
    );
    assert.deepEqual(conversations(database), []);
    for (const sql of [
      'begin',
      'BEGIN IMMEDIATE',
      ' commit',
      'rollback',
      'savepoint here',
      'release here',
      'end',
    ]) {
      assert.throws(() => database.run(sql), /Transactions are opened with/u, sql);
    }
    database.transaction(() => {
      database.run('insert into conversations(id, json) values (?, ?)', 'a', '{}');
      assert.throws(() => database.run('commit'), /Transactions are opened with/u);
    });
    assert.deepEqual(conversations(database), ['a']);

    // `insert` is for one new row: without one, the row id would be some earlier statement's.
    const insert = 'insert or ignore into conversations(id, json) values (?, ?)';
    assert.equal(typeof database.insert(insert, 'b', '{}'), 'number');
    assert.throws(() => database.insert(insert, 'b', '{}'), /exactly one row/u);
    assert.throws(
      () => database.insert('delete from conversations where id = ?', 'a'),
      /exactly one row/u,
    );
    assert.deepEqual(conversations(database), ['a', 'b']);

    // `get` and `all` read. A change made through them would not count as one.
    const reads = /get\(\) and all\(\) read/u;
    assert.throws(
      () => database.get(`delete from conversations where id = 'a' returning id`),
      reads,
    );
    assert.throws(
      () =>
        database.all(`with gone as (select 'a' as id) delete from conversations where id in gone`),
      reads,
    );
    assert.throws(
      () =>
        database.get(
          `with one as (select 1) insert or replace into conversations(id, json) values ('c', '{}')`,
        ),
      reads,
    );
    // However the table is written, the word that changes it is what counts.
    for (const table of [
      'main.conversations',
      '"conversations"',
      'conversations as c',
      'conversations indexed by sqlite_autoindex_conversations_1',
    ]) {
      assert.throws(
        () => database.get(`with one as (select 1) update ${table} set json = '[]' returning id`),
        reads,
        table,
      );
    }
    assert.throws(
      () => database.get(`with one as (select 1) delete/* all */from conversations returning id`),
      reads,
    );
    assert.throws(() => database.get('pragma journal_mode=delete'), reads);
    assert.throws(() => database.get('pragma wal_checkpoint(truncate)'), reads);
    // Named with nothing after it, a pragma may act instead of telling a setting: these
    // two write statistics and move the log into the file. The first does so as a table too.
    assert.throws(() => database.get('pragma optimize'), reads);
    assert.throws(() => database.all('pragma wal_checkpoint'), reads);
    assert.throws(() => database.all('select * from pragma_optimize'), reads);
    assert.throws(() => database.snapshot(() => database.all('PRAGMA  Optimize ')), reads);
    assert.equal(
      database.get(`select count(*) as made from sqlite_master where name like 'sqlite_stat%'`)
        ?.made,
      0,
    );
    assert.equal(database.get('pragma journal_mode')?.journal_mode, 'wal');
    assert.equal(database.get(' PRAGMA Synchronous ')?.synchronous, 1);
    // A function of that name is not a statement, nor is a word in a string, a name or a
    // comment.
    assert.equal(database.get(`select replace('kettle', 'k', 'K') as word`)?.word, 'Kettle');
    assert.equal(
      database.get(`select 'delete from it''s' as "update" -- insert nothing`)?.update,
      "delete from it's",
    );
    assert.deepEqual(
      { ...database.get('select 1 as [insert], 2 as `delete` /* update */') },
      { insert: 1, delete: 2 },
    );
    assert.deepEqual(conversations(database), ['a', 'b']);

    // `run` changes rows and nothing else. After any other statement, the count SQLite
    // gives is still that of the last insert, update or delete.
    const rows = /run\(\) and insert\(\) change rows/u;
    for (const sql of [
      'pragma optimize',
      'pragma journal_mode=delete',
      'create table other(id integer primary key)',
      'drop table conversations',
      'vacuum',
      'select id from conversations',
      'with one as (select 1 as id) select id from one',
      `with one as (select 'delete from conversations' as id) select id from one`,
    ]) {
      assert.throws(() => database.run(sql), rows, sql);
    }
    assert.equal(database.get('pragma journal_mode')?.journal_mode, 'wal');
    database.run('insert into conversations(id, json) values (?, ?)', 'c', '{}');
    assert.equal(
      database.run(`with gone as (select 'c' as id) delete from conversations where id in gone`),
      1,
    );
    // A statement that changes no row says so, whatever the one before it changed.
    assert.equal(database.run(`delete from conversations where id = 'nobody'`), 0);
    assert.deepEqual(conversations(database), ['a', 'b']);

    // A statement that fails must be undone whole, which `or fail` does not do.
    assert.throws(
      () => database.run(`insert or fail into conversations(id, json) values ('c', '{}')`),
      /undone whole/u,
    );
    assert.deepEqual(conversations(database), ['a', 'b']);
  } finally {
    database.close();
  }
});

test('closing releases the file, and a closed database says so', () => {
  const directory = freshDirectory();
  const file = join(directory, 'bot.db');
  const moved = `${directory} moved`;
  const database = writer(file);
  if (process.platform === 'win32') {
    assert.throws(
      () => renameSync(directory, moved),
      (error: NodeJS.ErrnoException) => ['EPERM', 'EBUSY', 'EACCES'].includes(String(error.code)),
    );
  }
  database.close();
  database.close();
  assert.equal(database.isOpen, false);
  throwsCode(() => database.get('select 1 as one'), 'closed');
  throwsCode(
    () => database.run('insert into conversations(id, json) values (?, ?)', 'x', '{}'),
    'closed',
  );
  throwsCode(() => database.transaction(() => undefined), 'closed');
  throwsCode(() => database.snapshot(() => undefined), 'closed');
  renameSync(directory, moved);
  assert.equal(existsSync(join(moved, 'bot.db')), true);

  // Closing inside a transaction rolls it back and reports it.
  const again = writer(join(moved, 'bot.db'));
  throwsCode(
    () =>
      again.transaction(() => {
        again.run('insert into conversations(id, json) values (?, ?)', 'lost', '{}');
        again.close();
      }),
    'closed',
  );
  const check = writer(join(moved, 'bot.db'));
  try {
    assert.deepEqual(conversations(check), []);
  } finally {
    check.close();
  }
});

test('the busy timeout must be a whole number of milliseconds', () => {
  const file = join(freshDirectory(), 'bot.db');
  assert.throws(() => openStateDatabase({ file, mode: 'writer', busyTimeoutMs: -1 }), TypeError);
  assert.throws(() => openStateDatabase({ file, mode: 'writer', busyTimeoutMs: 1.5 }), TypeError);
  assert.equal(existsSync(file), false);
  openStateDatabase({ file, mode: 'writer', busyTimeoutMs: 0 }).close();
});

test('the URI for an existing database encodes the path and handles UNC roots', () => {
  assert.equal(
    existingDatabaseUri('C:\\Users\\some one\\貓 #1 100%\\bot.db', true),
    'file:///C:/Users/some%20one/%E8%B2%93%20%231%20100%25/bot.db?mode=rw',
  );
  assert.equal(
    existingDatabaseUri('/home/some one/貓?/bot.db', false),
    'file:///home/some%20one/%E8%B2%93%3F/bot.db?mode=rw',
  );
  // `pathToFileURL` would give these a host, which SQLite rejects.
  assert.equal(
    existingDatabaseUri('\\\\server\\share$\\bots\\a b\\bot.db', true),
    'file:////server/share%24/bots/a%20b/bot.db?mode=rw',
  );
  assert.equal(
    existingDatabaseUri('\\\\?\\UNC\\server\\share\\bot.db', true),
    'file:////server/share/bot.db?mode=rw',
  );
  // The same roots however they were typed.
  assert.equal(
    existingDatabaseUri('//server/share/bots/bot.db', true),
    'file:////server/share/bots/bot.db?mode=rw',
  );
  assert.equal(
    existingDatabaseUri('\\\\?\\unc\\server\\share\\bot.db', true),
    'file:////server/share/bot.db?mode=rw',
  );
  assert.equal(
    existingDatabaseUri('C:/bots/a b/bot.db', true),
    'file:///C:/bots/a%20b/bot.db?mode=rw',
  );
  // A device path to a drive is not a UNC root.
  const device = existingDatabaseUri('\\\\?\\C:\\bots\\bot.db', true);
  assert.ok(device.startsWith('file:///') && !device.startsWith('file:////'), device);
  assert.ok(device.endsWith('/bots/bot.db?mode=rw'), device);
});

test(
  'a reader opens a database through a UNC path',
  { skip: process.platform !== 'win32' },
  (context) => {
    const { file } = stoppedBot();
    const local = resolve(file);
    const unc = `\\\\localhost\\${local.slice(0, 1)}$${local.slice(2)}`;
    if (!existsSync(unc)) {
      context.skip('this machine does not share its drive');
      return;
    }
    const database = reader(unc);
    try {
      assert.deepEqual(conversations(database), ['home']);
    } finally {
      database.close();
    }
  },
);
