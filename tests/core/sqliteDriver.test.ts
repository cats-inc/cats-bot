import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
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
const driverModule = new URL('../../src/core/store/sqliteDriver.ts', import.meta.url).href;
const NUL = String.fromCharCode(0);

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

interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Waits for `close`, not `exit`: only then has everything the child printed arrived. */
async function finished(child: ChildProcess): Promise<Finished> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
}

/** The connection the lock holder keeps: read-write, WAL, `synchronous=NORMAL` (SPEC-014 FR-1). */
function openWriter(file: string): SqliteDatabase {
  const database = new DatabaseSync(file);
  database.exec('pragma journal_mode=wal; pragma synchronous=normal');
  return database;
}

/**
 * The connection proposed for a host without the lock. `mode=rw` refuses to create a missing
 * database, and `query_only` rejects statements that change rows or the schema.
 *
 * It is not a read-only handle. SQLite still lets it run a checkpoint or change the journal
 * mode, and when it is the last connection to close it checkpoints the write-ahead log into
 * the database file and removes the `-wal` and `-shm` files. Rows never change, but the
 * adapter must not hand out such a connection for arbitrary statements.
 *
 * The driver's `readOnly` option is not used: opened on a cleanly stopped bot it left `-shm`
 * and `-wal` files behind where that was tried. Neither is `immutable=1`: it turns off locking
 * and change detection, which is unsafe when a writer may start at any time.
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

function bodies(database: SqliteDatabase): string[] {
  return database
    .prepare('select body from notes order by id')
    .all()
    .map((row) => String(row.body));
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

/**
 * Behaviour that differs between runtimes and that nothing here asserts. It is printed so a
 * CI log shows what each platform and each runtime does.
 */
function observed(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const memory = new DatabaseSync(':memory:');
  try {
    memory.exec('create table raw(id integer primary key, value text not null) strict');
    const id = memory
      .prepare('insert into raw(value) values (?)')
      .run(`before${NUL}after`).lastInsertRowid;
    const row = memory
      .prepare('select value, length(cast(value as blob)) as bytes from raw where id = ?')
      .get(id);
    result.rawNulText = {
      storedBytes: Number(row?.bytes),
      readCharacters: String(row?.value).length,
    };
  } catch (error) {
    result.rawNulText = String(error);
  } finally {
    memory.close();
  }
  try {
    const directory = freshDirectory();
    const file = join(directory, 'bot.db');
    openWriter(file).close();
    const readOnly = new DatabaseSync(file, { readOnly: true });
    readOnly.prepare('select count(*) as n from sqlite_master').get();
    readOnly.close();
    result.readOnlyOpenLeaves = files(directory).filter((name) => name !== 'bot.db');
  } catch (error) {
    result.readOnlyOpenLeaves = String(error);
  }
  return result;
}

test('the driver loads without printing its experimental notice and leaves warnings alone', async () => {
  assert.equal(process.emitWarning, emitWarningBeforeLoad);
  assert.equal(sqliteDriver(), sqliteDriver());

  const script = `
    import { sqliteDriver } from ${JSON.stringify(driverModule)};
    const { DatabaseSync } = sqliteDriver();
    const database = new DatabaseSync(':memory:');
    process.stdout.write(String(database.prepare('select 41 + 1 as answer').get().answer));
    database.close();
    process.emitWarning('still delivered', 'CatsBotProbeWarning');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { code, signal, stdout, stderr } = await finished(child);
  assert.deepEqual([code, signal], [0, null], stderr);
  assert.equal(stdout, '42');
  assert.doesNotMatch(stderr, /SQLite is an experimental feature/u);
  assert.match(stderr, /CatsBotProbeWarning: still delivered/u);
});

test('a runtime started without SQLite gets an error that says so', async (context) => {
  const script = `
    import { sqliteDriver } from ${JSON.stringify(driverModule)};
    try { sqliteDriver(); process.stdout.write('loaded'); } catch (error) { process.stdout.write(error.message); }
  `;
  const child = spawn(
    process.execPath,
    ['--no-experimental-sqlite', '--input-type=module', '-e', script],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const { code, stdout, stderr } = await finished(child);
  // A later runtime may drop the switch, or keep it and load SQLite anyway.
  if ((code === 9 && /bad option/u.test(stderr)) || stdout === 'loaded') {
    context.skip('this runtime has no switch that turns SQLite off');
    return;
  }
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^node:sqlite is not available in this Node\.js \(v\d+\.\d+\.\d+\)/u);
  assert.match(stdout, /--no-experimental-sqlite/u);
});

test('the built-in SQLite has the features the schema uses', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const version = String(database.prepare('select sqlite_version() as version').get()?.version);
    // One line for the Electron run below to check, and for anyone reading a CI log.
    console.log(
      `sqlite-driver runtime ${JSON.stringify({ node: process.versions.node, electron: process.versions.electron ?? null, sqlite: version, ...observed() })}`,
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

test('a record stored as JSON text comes back exactly', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('create table entries(id integer primary key, json text not null) strict');
    const insert = database.prepare('insert into entries(json) values (?)');
    const read = database.prepare('select json from entries where id = ?');
    // The first two never reach the driver as such: JSON escapes a NUL character and a lone
    // surrogate, which a raw TEXT value does not survive on every runtime. That is why the
    // JSON column is the record and other columns only index it. The last two do reach it.
    const awkward = [
      `before${NUL}after`,
      `lone ${String.fromCharCode(0xd83d)} surrogate`,
      `cat ${String.fromCodePoint(0x1f431)} 貓\r\n\ttabbed "quoted" \\ slashed`,
      'x'.repeat(2_000_000),
    ];
    for (const text of awkward) {
      const json = JSON.stringify({ seq: 1, kind: 'bot', text, unknownField: { kept: true } });
      assert.equal(json.includes(NUL), false);
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
    // The record is the JSON; the index is built from the text inside it.
    database.exec(
      'create table entries(id integer primary key, conversation_id text not null, seq integer not null, json text not null, unique(conversation_id, seq)) strict',
    );
    database.exec(
      `create virtual table entries_fts using fts5(text, grams, content='', contentless_delete=1)`,
    );
    const insertEntry = database.prepare(
      'insert into entries(conversation_id, seq, json) values (?, ?, ?)',
    );
    const insertIndex = database.prepare(
      'insert into entries_fts(rowid, text, grams) values (?, ?, ?)',
    );
    const add = (conversation: string, seq: number, text: string): void => {
      const id = insertEntry.run(conversation, seq, JSON.stringify({ seq, text })).lastInsertRowid;
      insertIndex.run(id, text, bigrams(text));
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
    add('home', 3, `alpha${NUL}omega 記得買茶葉`);
    add('note', 1, '明天早上要去看牙醫，公園改天再去');
    database.exec('commit');

    assert.deepEqual(search(bigramQuery('牙醫')), ['note#1']);
    assert.deepEqual(search(bigramQuery('公園')).sort(), ['home#1', 'note#1']);
    assert.deepEqual(search(bigramQuery('去公園')), ['home#1']);
    assert.deepEqual(search(bigramQuery('園公')), []);
    assert.deepEqual(search('text:kettle'), ['home#2']);
    assert.deepEqual(search('text:KETTLE'), ['home#2']);
    assert.deepEqual(search('text:omega'), ['home#3']);
    assert.deepEqual(search(bigramQuery('茶葉')), ['home#3']);

    // Deleting a conversation removes its rows and their index rows in one transaction.
    database.exec('begin');
    const deleteIndex = database.prepare('delete from entries_fts where rowid = ?');
    for (const row of database
      .prepare('select id from entries where conversation_id = ?')
      .all('note')) {
      deleteIndex.run(Number(row.id));
    }
    database.prepare('delete from entries where conversation_id = ?').run('note');
    database.exec('commit');
    assert.deepEqual(search(bigramQuery('牙醫')), []);
    assert.deepEqual(search(bigramQuery('公園')), ['home#1']);

    // The index can be thrown away and rebuilt from the records, including the words after
    // a NUL character, which a rebuild from a raw TEXT column loses on Node.js 24.14.
    database.exec('begin');
    database.exec('delete from entries_fts');
    assert.deepEqual(search(bigramQuery('公園')), []);
    for (const row of database.prepare('select id, json from entries').all()) {
      const { text } = JSON.parse(String(row.json)) as { text: string };
      insertIndex.run(Number(row.id), text, bigrams(text));
    }
    database.exec('commit');
    assert.deepEqual(search(bigramQuery('公園')), ['home#1']);
    assert.deepEqual(search('text:kettle'), ['home#2']);
    assert.deepEqual(search('text:omega'), ['home#3']);
    assert.deepEqual(search(bigramQuery('茶葉')), ['home#3']);
  } finally {
    database.close();
  }
});

test('a snapshot is a complete database and does not replace an existing one', () => {
  const directory = freshDirectory();
  const snapshot = join(directory, "snapshot o'clock.db");
  const database = openWriter(join(directory, 'bot.db'));
  try {
    database.exec('create table notes(id integer primary key, body text not null) strict');
    database.prepare('insert into notes(body) values (?)').run('kept');
    assert.equal(database.prepare('pragma quick_check').get()?.quick_check, 'ok');
    const vacuumInto = `vacuum into '${snapshot.replaceAll("'", "''")}'`;
    database.exec(vacuumInto);
    // SQLite does accept an existing empty file, and an interrupted run can leave a partial
    // one, so the adapter writes a snapshot under a new name and renames it when complete.
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

test('a reader beside the running writer sees committed rows only and cannot change rows', () => {
  const directory = freshDirectory();
  const file = join(directory, 'bot.db');
  const writer = openWriter(file);
  let reader: SqliteDatabase | undefined;
  try {
    // A small page cache pushes the open transaction's pages into the write-ahead log, so the
    // reader has uncommitted frames on disk to skip, not only rows in the writer's memory.
    writer.exec('pragma cache_size=8');
    writer.exec('create table notes(id integer primary key, body text not null) strict');
    const insert = writer.prepare('insert into notes(body) values (?)');
    insert.run('committed');
    writer.exec('begin');
    for (let index = 0; index < 400; index += 1)
      insert.run(`in flight ${index} ${'x'.repeat(2000)}`);
    assert.ok(
      statSync(`${file}-wal`).size > 200_000,
      `the write-ahead log holds ${statSync(`${file}-wal`).size} bytes`,
    );

    reader = openReader(file);
    assert.deepEqual(bodies(reader), ['committed']);
    assert.throws(
      () => reader!.exec(`insert into notes(body) values ('from the reader')`),
      /readonly database/u,
    );
    assert.throws(() => reader!.exec('delete from notes'), /readonly database/u);
    assert.throws(
      () => reader!.exec('create table more(id integer primary key)'),
      /readonly database/u,
    );

    writer.exec('commit');
    assert.equal(count(reader, 'notes'), 401);
    reader.close();
    reader = undefined;

    insert.run('after the reader left');
    assert.equal(count(writer, 'notes'), 402);
  } finally {
    reader?.close();
    writer.close();
  }
  assert.deepEqual(files(directory), ['bot.db']);
});

test('a reader never creates a database and leaves only the database file beside a stopped bot', () => {
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
    assert.deepEqual(bodies(reader), ['left by a clean stop']);
  } finally {
    reader.close();
  }
  assert.deepEqual(files(directory), ['bot.db']);
});

test('closing a connection releases the file and its directory', () => {
  const directory = freshDirectory();
  const file = join(directory, 'bot.db');
  const moved = `${directory} moved`;
  const database = openWriter(file);
  database.exec('create table notes(id integer primary key) strict');
  // Archiving, the trash and a data reset rename or remove the bot root; Windows refuses both
  // while any handle is open, so hosts must close before they move a root.
  if (process.platform === 'win32') {
    assert.throws(
      () => renameSync(directory, moved),
      (error: NodeJS.ErrnoException) => ['EPERM', 'EBUSY', 'EACCES'].includes(String(error.code)),
    );
  }
  database.close();
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
      { stdio: ['ignore', 'pipe', 'pipe'] },
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
      // The writer's open transaction is on disk, in the write-ahead log, not only in its memory.
      assert.ok(
        statSync(`${file}-wal`).size > 200_000,
        `the write-ahead log holds ${statSync(`${file}-wal`).size} bytes`,
      );

      // Another process reads while that writer is alive: a CLI command beside a running bot.
      const beside = openReader(file);
      try {
        assert.deepEqual(bodies(beside), ['one', 'two', 'three']);
        assert.throws(
          () => beside.exec(`insert into notes(body) values ('from the reader')`),
          /readonly database/u,
        );
      } finally {
        beside.close();
      }
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    assert.ok(statSync(`${file}-wal`).size > 200_000, files(directory).join(' '));

    // A reader is the first to open what the dead writer left behind.
    const reader = openReader(file);
    try {
      assert.deepEqual(bodies(reader), ['one', 'two', 'three']);
      assert.equal(reader.prepare('pragma quick_check').get()?.quick_check, 'ok');
    } finally {
      reader.close();
    }

    const writer = openWriter(file);
    try {
      assert.deepEqual(bodies(writer), ['one', 'two', 'three']);
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
  async (context) => {
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
    const { code, signal, stdout, stderr } = await finished(child);
    const output = `${stdout}\n${stderr}`;
    assert.deepEqual([code, signal], [0, null], output);
    const runtime = /sqlite-driver runtime (\{.*\})/u.exec(stdout);
    assert.ok(runtime, output);
    context.diagnostic(`inside Electron: ${runtime[1]!}`);
    assert.equal(
      (JSON.parse(runtime[1]!) as { electron: string | null }).electron,
      shipped,
      output,
    );
    assert.match(stdout, /^# tests 12$/mu, output);
    assert.match(stdout, /^# fail 0$/mu, output);
    assert.match(stdout, /^# cancelled 0$/mu, output);
    // Everything above ran there. This test skips itself inside Electron, and the test of a
    // runtime without SQLite may skip itself too.
    assert.match(stdout, /^# skipped [12]$/mu, output);
  },
);
