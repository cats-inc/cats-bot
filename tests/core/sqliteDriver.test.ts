import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sqliteDriver, type SqliteDatabase } from '../../src/core/store/sqliteDriver.ts';

/**
 * PLAN-014 task 1.1, SPEC-014 FR-2: what the bot state database needs from the SQLite built
 * into the runtime. The storage adapter relies on every behaviour pinned here, so this file
 * runs on each supported platform under plain Node.js and, in CI, a second time inside the
 * Electron the app ships (the core runs there with `ELECTRON_RUN_AS_NODE`):
 *   CATS_TEST_SQLITE_ELECTRON=1 node --test tests/core/sqliteDriver.test.ts
 */

// A bot root can sit under a home directory with spaces and non-ASCII characters.
const scratch = mkdtempSync(join(tmpdir(), 'cats bot 資料庫 '));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const emitWarningBeforeLoad = process.emitWarning;
const { DatabaseSync } = sqliteDriver();

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

/** The connection the lock holder keeps: read-write, WAL, `synchronous=NORMAL` (SPEC-014 FR-1). */
function openWriter(file: string): SqliteDatabase {
  const database = new DatabaseSync(file);
  database.exec('pragma journal_mode=wal; pragma synchronous=normal');
  return database;
}

/**
 * The connection a host without the lock uses. `mode=rw` refuses to create a missing database
 * and `query_only` refuses every change. The driver's `readOnly` option is not used: opened on
 * a cleanly stopped bot it leaves `-shm` and `-wal` files behind. Neither is `immutable=1`: it
 * turns off locking and change detection, which is unsafe when a writer may start at any time.
 */
function openReader(file: string): SqliteDatabase {
  const url = pathToFileURL(file);
  url.searchParams.set('mode', 'rw');
  const database = new DatabaseSync(url);
  database.exec('pragma query_only=on');
  return database;
}

function count(database: SqliteDatabase, table: string): number {
  return Number(database.prepare(`select count(*) as n from ${table}`).get()?.n);
}

/** Two-character windows over each CJK run, the shape SPEC-014 FR-8 indexes beside the text. */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/gu;
function bigrams(text: string): string {
  return text.replace(CJK_RUN, (run) => {
    if (run.length < 2) return ` ${run} `;
    return ` ${Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)).join(' ')} `;
  });
}

function bigramQuery(text: string): string {
  return `grams:"${bigrams(text).trim().replace(/\s+/gu, ' ')}"`;
}

test('the driver loads without printing its experimental notice and leaves warnings alone', async () => {
  assert.equal(process.emitWarning, emitWarningBeforeLoad);
  assert.equal(sqliteDriver(), sqliteDriver());

  const script = `
    import { sqliteDriver } from ${JSON.stringify(new URL('../../src/core/store/sqliteDriver.ts', import.meta.url).href)};
    const { DatabaseSync } = sqliteDriver();
    const database = new DatabaseSync(':memory:');
    process.stdout.write(String(database.prepare('select 41 + 1 as answer').get().answer));
    database.close();
    process.emitWarning('still delivered', 'CatsBotProbeWarning');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  assert.deepEqual(await once(child, 'exit'), [0, null], stderr);
  assert.equal(stdout, '42');
  assert.doesNotMatch(stderr, /SQLite|ExperimentalWarning/u);
  assert.match(stderr, /CatsBotProbeWarning: still delivered/u);
});

test('the built-in SQLite has the features the schema uses', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const version = String(database.prepare('select sqlite_version() as version').get()?.version);
    // Printed for the Electron run below and for anyone reading a CI log.
    console.log(
      `sqlite-driver runtime ${JSON.stringify({ node: process.versions.node, electron: process.versions.electron ?? null, sqlite: version })}`,
    );
    const [major = 0, minor = 0] = version.split('.').map(Number);
    // `contentless_delete` arrived in 3.43; STRICT tables in 3.37.
    assert.ok(major > 3 || (major === 3 && minor >= 43), `SQLite ${version} is older than 3.43`);
    const options = database
      .prepare('pragma compile_options')
      .all()
      .map((row) => String(row.compile_options));
    assert.ok(options.includes('ENABLE_FTS5'), options.join(' '));
    assert.equal(
      database.prepare(`select json_extract('{"a":{"b":7}}', '$.a.b') as value`).get()?.value,
      7,
    );
  } finally {
    database.close();
  }
});

test('a WAL database keeps typed rows, upserts in place and rolls a transaction back', () => {
  const directory = freshDirectory();
  const database = new DatabaseSync(join(directory, 'bot.db'));
  try {
    assert.equal(database.prepare('pragma journal_mode=wal').get()?.journal_mode, 'wal');
    database.exec('pragma synchronous=normal');
    assert.equal(database.prepare('pragma synchronous').get()?.synchronous, 1);

    database.exec(
      'create table work_items(id text primary key, status text not null, attempts integer not null) strict',
    );
    const upsert = database.prepare(
      'insert into work_items(id, status, attempts) values (?, ?, ?) on conflict(id) do update set status = excluded.status, attempts = excluded.attempts',
    );
    const first = upsert.run('w1', 'queued', 0);
    assert.equal(typeof first.lastInsertRowid, 'number');
    assert.equal(first.changes, 1);
    upsert.run('w1', 'running', 1);
    assert.deepEqual(
      { ...database.prepare('select status, attempts from work_items where id = ?').get('w1') },
      { status: 'running', attempts: 1 },
    );
    assert.equal(count(database, 'work_items'), 1);
    assert.equal(
      database.prepare('select status from work_items where id = ?').get('missing'),
      undefined,
    );
    assert.throws(
      () => upsert.run('w2', 'queued', 'many'),
      /cannot store TEXT value in INTEGER column/u,
    );

    database.exec('begin');
    upsert.run('w3', 'queued', 0);
    database.exec('rollback');
    assert.equal(count(database, 'work_items'), 1);
  } finally {
    database.close();
  }
});

test('a row stored as JSON text comes back exactly, whatever the text holds', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('create table entries(id integer primary key, json text not null) strict');
    const insert = database.prepare('insert into entries(json) values (?)');
    const read = database.prepare('select json from entries where id = ?');
    // A raw NUL in a TEXT column is cut short by the Node 24 driver and a lone surrogate is
    // replaced; JSON escapes both, so the JSON column is the record and other columns only index it.
    const awkward = [
      `before${String.fromCharCode(0)}after`,
      `lone ${String.fromCharCode(0xd83d)} surrogate`,
      `cat ${String.fromCodePoint(0x1f431)} 貓\r\n\ttabbed "quoted" \\ slashed`,
      'x'.repeat(2_000_000),
    ];
    for (const text of awkward) {
      const json = JSON.stringify({ seq: 1, kind: 'bot', text, unknownField: { kept: true } });
      const stored = String(read.get(insert.run(json).lastInsertRowid)?.json);
      assert.equal(stored.length, json.length);
      assert.ok(stored === json, `JSON text changed for a ${text.length}-character entry`);
      assert.equal((JSON.parse(stored) as { text: string }).text, text);
    }
  } finally {
    database.close();
  }
});

test('contentless FTS5 with a bigram column finds two-character Chinese words', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(
      'create table entries(id integer primary key, conversation_id text not null, seq integer not null, text text not null, unique(conversation_id, seq)) strict',
    );
    database.exec(
      `create virtual table entries_fts using fts5(text, grams, content='', contentless_delete=1)`,
    );
    const insertEntry = database.prepare(
      'insert into entries(conversation_id, seq, text) values (?, ?, ?)',
    );
    const insertIndex = database.prepare(
      'insert into entries_fts(rowid, text, grams) values (?, ?, ?)',
    );
    const add = (conversation: string, seq: number, text: string): void => {
      insertIndex.run(
        insertEntry.run(conversation, seq, text).lastInsertRowid,
        text,
        bigrams(text),
      );
    };
    const search = (query: string): string[] =>
      database
        .prepare(
          'select e.conversation_id as c, e.seq as s from entries_fts join entries e on e.id = entries_fts.rowid where entries_fts match ? order by bm25(entries_fts), e.id',
        )
        .all(query)
        .map((row) => `${String(row.c)}#${String(row.s)}`);

    database.exec('begin');
    add('home', 1, '今天下午去公園散步');
    add('home', 2, 'Please remember the kettle');
    add('note', 1, '明天早上要去看牙醫，公園改天再去');
    database.exec('commit');

    assert.deepEqual(search(bigramQuery('牙醫')), ['note#1']);
    assert.deepEqual(search(bigramQuery('公園')).sort(), ['home#1', 'note#1']);
    assert.deepEqual(search(bigramQuery('去公園')), ['home#1']);
    assert.deepEqual(search(bigramQuery('園公')), []);
    assert.deepEqual(search('text:kettle'), ['home#2']);
    assert.deepEqual(search('text:KETTLE'), ['home#2']);

    // Deleting a conversation removes its rows and their index rows in one transaction.
    database.exec('begin');
    const deleteIndex = database.prepare('delete from entries_fts where rowid = ?');
    for (const row of database
      .prepare('select id from entries where conversation_id = ?')
      .all('note'))
      deleteIndex.run(Number(row.id));
    database.prepare('delete from entries where conversation_id = ?').run('note');
    database.exec('commit');
    assert.deepEqual(search(bigramQuery('牙醫')), []);
    assert.deepEqual(search(bigramQuery('公園')), ['home#1']);

    // The index can be thrown away and rebuilt from the entries.
    database.exec('begin');
    database.exec('delete from entries_fts');
    assert.deepEqual(search(bigramQuery('公園')), []);
    for (const row of database.prepare('select id, text from entries').all())
      insertIndex.run(Number(row.id), String(row.text), bigrams(String(row.text)));
    database.exec('commit');
    assert.deepEqual(search(bigramQuery('公園')), ['home#1']);
    assert.deepEqual(search('text:kettle'), ['home#2']);
  } finally {
    database.close();
  }
});

test('a snapshot is a complete database and never overwrites an existing file', () => {
  const directory = freshDirectory();
  const snapshot = join(directory, "snapshot o'clock.db");
  const database = openWriter(join(directory, 'bot.db'));
  try {
    database.exec('create table notes(id integer primary key, body text not null) strict');
    database.prepare('insert into notes(body) values (?)').run('kept');
    assert.equal(database.prepare('pragma quick_check').get()?.quick_check, 'ok');
    const vacuumInto = `vacuum into '${snapshot.replaceAll("'", "''")}'`;
    database.exec(vacuumInto);
    assert.throws(() => database.exec(vacuumInto), /already exists/u);
  } finally {
    database.close();
  }
  const copy = new DatabaseSync(snapshot);
  try {
    assert.equal(copy.prepare('select body from notes').get()?.body, 'kept');
    assert.equal(copy.prepare('pragma quick_check').get()?.quick_check, 'ok');
  } finally {
    copy.close();
  }
});

test('a reader beside the running writer sees committed rows only and cannot change anything', () => {
  const directory = freshDirectory();
  const file = join(directory, 'bot.db');
  const writer = openWriter(file);
  let reader: SqliteDatabase | undefined;
  try {
    writer.exec('create table notes(id integer primary key, body text not null) strict');
    const insert = writer.prepare('insert into notes(body) values (?)');
    insert.run('committed');
    writer.exec('begin');
    insert.run('in flight');

    reader = openReader(file);
    assert.equal(count(reader, 'notes'), 1);
    assert.throws(
      () => reader!.exec(`insert into notes(body) values ('from the reader')`),
      /readonly database/u,
    );
    assert.throws(() => reader!.exec('delete from notes'), /readonly database/u);

    writer.exec('commit');
    assert.equal(count(reader, 'notes'), 2);
    reader.close();
    reader = undefined;

    insert.run('after the reader left');
    assert.equal(count(writer, 'notes'), 3);
  } finally {
    reader?.close();
    writer.close();
  }
  assert.deepEqual(files(directory), ['bot.db']);
});

test('a reader never creates a database and tidies up after a stopped bot', () => {
  const empty = freshDirectory();
  assert.throws(() => openReader(join(empty, 'bot.db')), /unable to open database file/u);
  assert.deepEqual(files(empty), []);

  const directory = freshDirectory();
  const file = join(directory, 'bot.db');
  const writer = openWriter(file);
  writer.exec('create table notes(id integer primary key, body text not null) strict');
  writer.prepare('insert into notes(body) values (?)').run('left by a clean stop');
  writer.close();
  assert.deepEqual(files(directory), ['bot.db']);

  const reader = openReader(file);
  try {
    assert.equal(count(reader, 'notes'), 1);
  } finally {
    reader.close();
  }
  assert.deepEqual(files(directory), ['bot.db']);
});

test('closing a connection releases the file and its directory', () => {
  const directory = freshDirectory();
  const file = join(directory, 'bot.db');
  const database = openWriter(file);
  database.exec('create table notes(id integer primary key) strict');
  database.close();
  // Archiving, the trash and a data reset rename or remove the bot root; Windows refuses both
  // while any handle is open, so hosts must close before they move a root.
  const moved = `${directory} moved`;
  renameSync(directory, moved);
  rmSync(join(moved, 'bot.db'));
  assert.equal(existsSync(join(moved, 'bot.db')), false);
});

test(
  'rows committed before the writer was killed survive, and its open transaction does not',
  { timeout: 30_000 },
  async () => {
    const directory = freshDirectory();
    const file = join(directory, 'bot.db');
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../support/sqlite-crash-writer.mjs', import.meta.url)), file],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (stdout.includes('ready')) resolve();
        });
        void exited.then(() =>
          reject(new Error(`the writer exited before it was ready: ${stderr}`)),
        );
      });
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    // The committed rows are still only in the write-ahead log the dead writer left behind.
    assert.ok(files(directory).includes('bot.db-wal'), files(directory).join(' '));

    const reader = openReader(file);
    try {
      assert.deepEqual(
        reader
          .prepare('select body from notes order by id')
          .all()
          .map((row) => row.body),
        ['one', 'two', 'three'],
      );
      assert.equal(reader.prepare('pragma quick_check').get()?.quick_check, 'ok');
    } finally {
      reader.close();
    }

    const writer = openWriter(file);
    try {
      assert.equal(count(writer, 'notes'), 3);
      writer.prepare('insert into notes(body) values (?)').run('after recovery');
      assert.equal(count(writer, 'notes'), 4);
      assert.equal(writer.prepare('pragma quick_check').get()?.quick_check, 'ok');
    } finally {
      writer.close();
    }
    assert.deepEqual(files(directory), ['bot.db']);
  },
);

const insideElectron = process.versions.electron !== undefined;
const electronRequested = process.env.CATS_TEST_SQLITE_ELECTRON === '1';

test(
  'the same checks pass inside the Electron the app ships',
  { skip: insideElectron || !electronRequested, timeout: 180_000 },
  async () => {
    const require = createRequire(import.meta.url);
    const electron = require('electron') as string;
    const shipped = (require('electron/package.json') as { version: string }).version;
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.CATS_TEST_SQLITE_ELECTRON;
    // Set by `node --test` for its own children; with it the run below would report in the
    // runner's binary format instead of TAP.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(electron, ['--test-reporter=tap', fileURLToPath(import.meta.url)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    assert.deepEqual(await once(child, 'exit'), [0, null], output);
    const runtime = /sqlite-driver runtime (\{.*\})/u.exec(output);
    assert.ok(runtime, output);
    assert.equal(
      (JSON.parse(runtime[1]!) as { electron: string | null }).electron,
      shipped,
      output,
    );
    assert.match(output, /^# fail 0$/mu, output);
    assert.match(output, /^# cancelled 0$/mu, output);
    // Everything above ran there; only this test skips itself inside Electron.
    assert.match(output, /^# pass 10$/mu, output);
    assert.match(output, /^# skipped 1$/mu, output);
  },
);
