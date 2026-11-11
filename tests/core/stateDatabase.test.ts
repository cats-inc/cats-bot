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
    database.run(
      'insert into conversations(id, role, json) values (?, ?, ?)',
      'home',
      'home',
      '{"id":"home"}',
    );
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
      'entries',
      'entries_fts',
      'events',
      'meta',
      'responses',
      'schedules',
      'work_events',
      'work_items',
    ]);
    assert.equal(database.meta('schema_version'), String(STATE_SCHEMA_VERSION));
    assert.equal(database.meta('created_at'), '2026-11-11T08:00:00.000Z');
    assert.equal(database.meta('absent'), undefined);
    const runtime = JSON.parse(database.meta('runtime') ?? 'null') as {
      node: string;
      electron: string | null;
      sqlite: string;
    };
    assert.equal(runtime.node, process.versions.node);
    assert.equal(runtime.electron, process.versions.electron ?? null);
    assert.match(runtime.sqlite, /^\d+\.\d+\.\d+/u);
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
    const first = database.run(insertEntry, 'c1', 1, '{}').lastInsertRowid;
    assert.throws(
      () => database.run(insertEntry, 'c1', 1, '{}'),
      /UNIQUE constraint failed: entries\.conversation_id, entries\.seq/u,
    );
    assert.throws(
      () => database.run(insertEntry, 'c1', 'two', '{}'),
      /cannot store TEXT value in INTEGER column/u,
    );
    const second = database.run(insertEntry, 'c1', 2, '{}').lastInsertRowid;
    // A deleted entry's row id is never handed out again.
    database.run('delete from entries where id = ?', second);
    const third = database.run(insertEntry, 'c1', 2, '{}').lastInsertRowid;
    assert.ok(third > second, `${third} reuses ${second}`);

    database.run(
      'insert into entries_fts(rowid, text, grams) values (?, ?, ?)',
      first,
      'remember the kettle',
      '',
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
    database.run('insert into work_events(work_item_id, json) values (?, ?)', 'w1', '{}');
    database.run('insert into schedules(id, json) values (?, ?)', 's1', '{}');
    database.run('insert into events(json) values (?)', '{}');
    assert.equal(database.get('select count(*) as n from events')?.n, 1);
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

  const foreign = join(directory, 'foreign.db');
  raw(foreign, (database) =>
    database.exec(`create table theirs(a); insert into theirs values ('kept')`),
  );
  throwsCode(() => writer(foreign), 'not_a_bot_database');
  throwsCode(() => reader(foreign), 'not_a_bot_database');
  assert.deepEqual(
    raw(foreign, (database) =>
      database
        .prepare('select name from sqlite_master order by name')
        .all()
        .map((row) => row.name),
    ),
    ['theirs'],
  );

  const unversioned = join(directory, 'unversioned.db');
  raw(unversioned, (database) =>
    database.exec(`pragma application_id=${STATE_APPLICATION_ID}; create table other(a)`),
  );
  throwsCode(() => writer(unversioned), 'not_a_bot_database');

  const garbled = join(directory, 'garbled.db');
  writer(garbled).close();
  raw(garbled, (database) =>
    database.exec(`update meta set value = 'one' where key = 'schema_version'`),
  );
  throwsCode(() => writer(garbled), 'not_a_bot_database');
  throwsCode(() => reader(garbled), 'not_a_bot_database');
  assert.deepEqual(files(directory), ['foreign.db', 'garbled.db', 'text.db', 'unversioned.db']);
});

test('a reader never creates a database', () => {
  const directory = freshDirectory();
  throwsCode(() => reader(join(directory, 'bot.db')), 'missing');
  assert.deepEqual(files(directory), []);

  // What a writer leaves if it stops before the schema is committed.
  const empty = join(directory, 'empty.db');
  writeFileSync(empty, '');
  throwsCode(() => reader(empty), 'missing');
  assert.equal(statSync(empty).size, 0);
  assert.deepEqual(files(directory), ['empty.db']);
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
    // And one the text check lets through, which SQLite then rejects.
    assert.throws(() => reading!.get(`with one as (select 1) ${insert}`), /readonly database/u);

    writing.run('insert into conversations(id, json) values (?, ?)', 'note-1', '{}');
    assert.deepEqual(conversations(reading), ['home', 'note-1']);

    // One snapshot: a commit in between does not change what the reader's queries see.
    reading.snapshot(() => {
      assert.deepEqual(conversations(reading!), ['home', 'note-1']);
      writing.run('insert into conversations(id, json) values (?, ?)', 'note-2', '{}');
      assert.deepEqual(conversations(reading!), ['home', 'note-1']);
    });
    assert.deepEqual(conversations(reading), ['home', 'note-1', 'note-2']);
    assert.equal(writing.get('pragma journal_mode')?.journal_mode, 'wal');
  } finally {
    reading?.close();
    writing.close();
  }
  assert.deepEqual(files(directory), ['bot.db']);

  // Beside a stopped bot the reader still reads, and leaves only the database behind.
  const alone = reader(file);
  try {
    assert.deepEqual(conversations(alone), ['home', 'note-1', 'note-2']);
  } finally {
    alone.close();
  }
  assert.deepEqual(files(directory), ['bot.db']);
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

    // A failure inside takes the whole transaction with it, even when the outer code carries on.
    assert.throws(
      () =>
        database.transaction(() => {
          add('e');
          try {
            database.transaction(() => {
              add('f');
              throw new Error('inner');
            });
          } catch {
            // carried on regardless
          }
          add('g');
        }),
      /nested transaction failed/u,
    );
    assert.deepEqual(conversations(database), ['a', 'b', 'c', 'd']);

    // Work that returns a promise would commit before it had finished.
    assert.throws(
      () =>
        database.transaction(async () => {
          add('h');
        }),
      /must be synchronous/u,
    );
    assert.deepEqual(conversations(database), ['a', 'b', 'c', 'd']);

    // A write inside a snapshot is still one transaction.
    assert.throws(
      () =>
        database.snapshot(() => {
          database.transaction(() => add('i'));
          throw new Error('after the write');
        }),
      /after the write/u,
    );
    assert.deepEqual(conversations(database), ['a', 'b', 'c', 'd']);
    database.transaction(() => add('i'));
    assert.deepEqual(conversations(database), ['a', 'b', 'c', 'd', 'i']);
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
