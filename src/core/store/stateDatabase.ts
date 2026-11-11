import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  sqliteDriver,
  type SqliteDatabase,
  type SqliteInput,
  type SqliteOutput,
  type SqliteStatement,
} from './sqliteDriver.ts';
import { STATE_APPLICATION_ID, STATE_SCHEMA_SQL, STATE_SCHEMA_VERSION } from './stateSchema.ts';

/**
 * SPEC-014 FR-1, FR-2 and FR-4: the storage adapter over a bot's `bot.db`.
 *
 * It hands out no SQLite connection. The store modules beside it get `get`, `all`, `run`,
 * `insert` and the two transaction helpers, and the rest of the bot gets what those modules
 * build. The architecture boundary test keeps this file and the driver out of every other
 * directory.
 *
 * A **writer** is the core that holds the instance lock: WAL, `synchronous=NORMAL`, and the
 * schema created on a new file. A **reader** is a host without the lock, such as a CLI
 * command beside a running bot. It never creates a file and accepts only queries.
 *
 * Every host must `close()` before a bot root is renamed or removed: Windows refuses both
 * while a connection is open.
 */

export type StateDatabaseMode = 'writer' | 'reader';

export type StateDatabaseErrorCode =
  /** A reader found no database, or one a writer has not finished creating. */
  | 'missing'
  /** The file is not a SQLite database, or not one a bot wrote. No row or table is changed. */
  | 'not_a_bot_database'
  /** A newer Cats Bot wrote it. No row or table is changed. */
  | 'newer_schema'
  /** This runtime has no SQLite, or one that lacks what the schema needs. */
  | 'unsupported_sqlite'
  /** A change was asked of a reader. */
  | 'read_only'
  /** SQLite ended the transaction itself, as it does after a full disk. None of it was kept. */
  | 'transaction_lost'
  | 'closed';

export class StateDatabaseError extends Error {
  readonly code: StateDatabaseErrorCode;

  constructor(code: StateDatabaseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StateDatabaseError';
    this.code = code;
  }
}

export interface OpenStateDatabaseOptions {
  file: string;
  mode: StateDatabaseMode;
  /** How long a statement waits for another connection's lock. Default 5000. */
  busyTimeoutMs?: number;
  now?: () => Date;
}

export type StateRow = Record<string, SqliteOutput>;

/** The runtime that last opened the database for writing (FR-2). */
export interface StateRuntime {
  node: string;
  electron: string | null;
  sqlite: string;
  /** The Unicode version text is normalised and split by before it is indexed. */
  unicode: string | null;
}

/** What a transaction's work may return: anything but a promise. */
export type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Each of `get`, `all`, `run` and `insert` takes one statement with its values bound as
 * parameters. Transactions are opened with `transaction` and `snapshot` only.
 */
export interface StateDatabase {
  readonly file: string;
  readonly mode: StateDatabaseMode;
  readonly isOpen: boolean;
  /** The first row of a query, or undefined. A reader accepts only `select` and `with`. */
  get(sql: string, ...parameters: SqliteInput[]): StateRow | undefined;
  all(sql: string, ...parameters: SqliteInput[]): StateRow[];
  /** A statement that changes rows; returns how many it changed. Refused on a reader. */
  run(sql: string, ...parameters: SqliteInput[]): number;
  /** An insert of exactly one row into an ordinary table; returns its row id. Refused on a reader. */
  insert(sql: string, ...parameters: SqliteInput[]): number;
  /**
   * All of `work` or none of it. `work` is synchronous: a function that awaits would write
   * after the transaction had ended. A nested `transaction` or `snapshot` joins the outer
   * transaction. If nested work changed rows and then failed, the whole transaction fails,
   * even when the outer code catches the error; nested work that failed before it changed
   * anything is the caller's to handle. Refused on a reader.
   */
  transaction<T>(work: () => Synchronous<T>): T;
  /**
   * Runs `work` against one snapshot, taken before `work` starts, so that several queries
   * agree with each other whatever is committed meanwhile. It is for reading: on its own
   * it refuses a change and a transaction inside it. Inside a transaction it joins it.
   */
  snapshot<T>(work: () => Synchronous<T>): T;
  meta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  /** Safe to call twice. An open transaction is rolled back. */
  close(): void;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/** Statements are compiled once and kept. Past this many, the cache starts again. */
const STATEMENT_CACHE_LIMIT = 256;
const QUERY = /^\s*(?:select|with)\b/iu;
/** `pragma name` and nothing after it. */
const SETTING_READ = /^\s*pragma\s+\w+\s*$/iu;
/** A statement that changes rows, as `with ... insert into` would bring into a query. */
const CHANGE_WORD =
  /\b(?:insert|replace)\s+(?:or\s+\w+\s+)?into\b|\bupdate\s+(?:or\s+\w+\s+)?\w+\s+set\b|\bdelete\s+from\b/iu;
const INSERT = /^\s*insert\b/iu;
/** A conflict clause that leaves the rows a failed statement had already changed. */
const KEEPS_HALF = /\bor\s+fail\b/iu;
const TRANSACTION_CONTROL = /^\s*(?:begin|commit|end|rollback|savepoint|release)\b/iu;
/** SQLite's primary result codes, as the driver reports them in `errcode`. */
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;

export function openStateDatabase(options: OpenStateDatabaseOptions): StateDatabase {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError('busyTimeoutMs must be a non-negative integer');
  }
  const sqlite = supportedSqliteVersion();
  return options.mode === 'writer'
    ? openWriter(options, busyTimeoutMs, sqlite)
    : openReader(options, busyTimeoutMs);
}

/**
 * A `file:` URI that opens an existing database read-write and never creates one.
 * `pathToFileURL` turns a UNC path into a URL with a host, which SQLite rejects, so that
 * shape is built by hand.
 */
export function existingDatabaseUri(file: string, windows = process.platform === 'win32'): string {
  // Also turns forward slashes into the platform's separator before the shapes are told apart.
  const absolute = (windows ? win32 : posix).resolve(file);
  const unc = windows ? /^\\\\(?:\?\\UNC\\)?([^\\?.][^\\]*)\\(.+)$/iu.exec(absolute) : null;
  if (unc) {
    const path = unc[2]!.split('\\').map(encodeURIComponent).join('/');
    return `file:////${unc[1]!}/${path}?mode=rw`;
  }
  const url = pathToFileURL(absolute, { windows });
  url.searchParams.set('mode', 'rw');
  return url.href;
}

function openWriter(
  options: OpenStateDatabaseOptions,
  busyTimeoutMs: number,
  sqlite: string,
): StateDatabase {
  const { DatabaseSync } = sqliteDriver();
  const connection = new DatabaseSync(options.file);
  try {
    connection.exec(`pragma busy_timeout=${busyTimeoutMs}`);
    // Before anything that changes a row, a table or a setting: a database from a newer
    // version, or a file that is not ours, keeps all of them as they were found (FR-4).
    const found = inspect(connection, options.file);
    const journal = connection.prepare('pragma journal_mode=wal').get()?.journal_mode;
    if (journal !== 'wal') {
      throw new Error(
        `${options.file} could not be switched to write-ahead logging (it stayed ${String(journal)})`,
      );
    }
    connection.exec('pragma synchronous=normal');
    if (found === 'empty') createSchema(connection, options.now ?? (() => new Date()));
    const database = new Connection(options.file, 'writer', connection);
    recordRuntime(database, sqlite);
    return database;
  } catch (error) {
    connection.close();
    throw error;
  }
}

function openReader(options: OpenStateDatabaseOptions, busyTimeoutMs: number): StateDatabase {
  const { DatabaseSync } = sqliteDriver();
  const missing = (): StateDatabaseError =>
    new StateDatabaseError('missing', `${options.file} holds no bot state yet`);
  if (!exists(options.file)) throw missing();
  let connection: SqliteDatabase;
  try {
    connection = new DatabaseSync(existingDatabaseUri(options.file));
  } catch (error) {
    // Removed between the check and the open.
    if (sqliteCode(error) === SQLITE_CANTOPEN && !exists(options.file)) throw missing();
    throw error;
  }
  try {
    connection.exec(`pragma busy_timeout=${busyTimeoutMs}; pragma query_only=on`);
    if (inspect(connection, options.file) === 'empty') throw missing();
    return new Connection(options.file, 'reader', connection);
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Whether there is something at `file`. Any other failure to look, such as no permission, is thrown. */
function exists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Reads what the file is. All of it is read in one transaction, so that a writer creating
 * the schema at that moment is seen either before or after, never half-way.
 */
function inspect(connection: SqliteDatabase, file: string): 'empty' | 'current' {
  const notOurs = (why: string): StateDatabaseError =>
    new StateDatabaseError(
      'not_a_bot_database',
      `${file} is not a Cats Bot state database: ${why}. No row or table was changed.`,
    );
  connection.exec('begin');
  try {
    let applicationId: number;
    let objects: number;
    try {
      applicationId = Number(connection.prepare('pragma application_id').get()?.application_id);
      objects = Number(connection.prepare('select count(*) as n from sqlite_master').get()?.n);
    } catch (error) {
      if (sqliteCode(error) === SQLITE_NOTADB) throw notOurs('it is not a SQLite database');
      throw error;
    }
    if (objects === 0 && applicationId === 0) return 'empty';
    if (applicationId !== STATE_APPLICATION_ID) throw notOurs('another application wrote it');
    let stored: SqliteOutput | undefined;
    try {
      stored = connection
        .prepare(`select value from meta where key = 'schema_version'`)
        .get()?.value;
    } catch {
      throw notOurs('it has no table of schema information');
    }
    const version =
      typeof stored === 'string' && /^[1-9]\d*$/u.test(stored) ? Number(stored) : Number.NaN;
    if (!Number.isSafeInteger(version)) throw notOurs('it has no schema version');
    if (version > STATE_SCHEMA_VERSION) {
      throw new StateDatabaseError(
        'newer_schema',
        `${file} was written by a newer Cats Bot (schema ${version}; this version reads up to ${STATE_SCHEMA_VERSION}). No row or table was changed.`,
      );
    }
    return 'current';
  } finally {
    rollback(connection);
  }
}

/** The whole schema, or none of it. */
function createSchema(connection: SqliteDatabase, now: () => Date): void {
  connection.exec('begin immediate');
  try {
    connection.exec(`pragma application_id=${STATE_APPLICATION_ID}`);
    connection.exec(STATE_SCHEMA_SQL);
    const insert = connection.prepare('insert into meta(key, value) values (?, ?)');
    insert.run('schema_version', String(STATE_SCHEMA_VERSION));
    insert.run('created_at', now().toISOString());
    connection.exec('commit');
  } catch (error) {
    rollback(connection);
    throw error;
  }
}

function recordRuntime(database: StateDatabase, sqlite: string): void {
  const runtime: StateRuntime = {
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    sqlite,
    unicode: process.versions.unicode ?? null,
  };
  const value = JSON.stringify(runtime);
  if (database.meta('runtime') !== value) database.setMeta('runtime', value);
}

let supported: { version: string } | { error: string } | undefined;

/** `contentless_delete` needs SQLite 3.43, and the index needs FTS5. Checked once. */
function supportedSqliteVersion(): string {
  if (!supported) {
    try {
      const { DatabaseSync } = sqliteDriver();
      const probe = new DatabaseSync(':memory:');
      try {
        const version = String(probe.prepare('select sqlite_version() as version').get()?.version);
        const [major = 0, minor = 0] = version.split('.').map(Number);
        const fts5 = probe
          .prepare('pragma compile_options')
          .all()
          .some((row) => row.compile_options === 'ENABLE_FTS5');
        supported =
          (major > 3 || (major === 3 && minor >= 43)) && fts5
            ? { version }
            : {
                error: `The SQLite built into this Node.js (${version}${fts5 ? '' : ', without FTS5'}) cannot hold the bot state database, which needs SQLite 3.43 or later with FTS5.`,
              };
      } finally {
        probe.close();
      }
    } catch (error) {
      supported = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if ('error' in supported) throw new StateDatabaseError('unsupported_sqlite', supported.error);
  return supported.version;
}

function sqliteCode(error: unknown): number | undefined {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  // The low byte is the primary code; the rest says which variant.
  return typeof errcode === 'number' ? errcode & 0xff : undefined;
}

function rollback(connection: SqliteDatabase): void {
  try {
    connection.exec('rollback');
  } catch {
    // SQLite had already ended the transaction.
  }
}

class Connection implements StateDatabase {
  readonly file: string;
  readonly mode: StateDatabaseMode;
  // Private at run time too: nothing outside this class can reach the connection.
  #connection: SqliteDatabase | null;
  readonly #queries = new Map<string, SqliteStatement>();
  readonly #changes = new Map<string, SqliteStatement>();
  #depth = 0;
  /** What the outermost call opened, while one is open. */
  #outer: 'transaction' | 'snapshot' | null = null;
  /** How many statements have changed rows; tells whether nested work changed anything. */
  #writes = 0;
  /** Set when nested work changed rows and then failed: the transaction can only be rolled back. */
  #failure: { cause: unknown } | null = null;

  constructor(file: string, mode: StateDatabaseMode, connection: SqliteDatabase) {
    this.file = file;
    this.mode = mode;
    this.#connection = connection;
  }

  get isOpen(): boolean {
    return this.#connection !== null;
  }

  get(sql: string, ...parameters: SqliteInput[]): StateRow | undefined {
    return this.#query(sql).get(...parameters);
  }

  all(sql: string, ...parameters: SqliteInput[]): StateRow[] {
    return this.#query(sql).all(...parameters);
  }

  run(sql: string, ...parameters: SqliteInput[]): number {
    const changes = Number(this.#change(sql).run(...parameters).changes);
    // A statement that changed no row left nothing half made.
    if (changes > 0) this.#writes += 1;
    return changes;
  }

  insert(sql: string, ...parameters: SqliteInput[]): number {
    const misuse = (): Error =>
      new TypeError(
        `insert() is for a statement that adds exactly one row to an ordinary table: ${sql}`,
      );
    if (!INSERT.test(sql)) throw misuse();
    const { changes, lastInsertRowid } = this.#change(sql).run(...parameters);
    if (Number(changes) > 0) this.#writes += 1;
    // Without a new row, SQLite's last row id is still that of some earlier statement.
    if (Number(changes) !== 1 || lastInsertRowid > Number.MAX_SAFE_INTEGER) throw misuse();
    return Number(lastInsertRowid);
  }

  transaction<T>(work: () => Synchronous<T>): T {
    this.#assertWriter();
    this.#assertNotReading();
    return this.#within('transaction', work);
  }

  snapshot<T>(work: () => Synchronous<T>): T {
    return this.#within('snapshot', work);
  }

  meta(key: string): string | undefined {
    const value = this.get('select value from meta where key = ?', key)?.value;
    return typeof value === 'string' ? value : undefined;
  }

  setMeta(key: string, value: string): void {
    this.run(
      'insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
      key,
      value,
    );
  }

  close(): void {
    const connection = this.#connection;
    if (!connection) return;
    this.#connection = null;
    this.#queries.clear();
    this.#changes.clear();
    this.#depth = 0;
    this.#outer = null;
    connection.close();
  }

  #open(): SqliteDatabase {
    if (!this.#connection) throw new StateDatabaseError('closed', `${this.file} is closed`);
    return this.#connection;
  }

  #assertWriter(): void {
    this.#open();
    if (this.mode !== 'writer') {
      throw new StateDatabaseError(
        'read_only',
        `${this.file} is open for reading; only the core that holds the bot's lock changes it`,
      );
    }
  }

  /** A snapshot opened on its own is for reading, and stays that way to its end. */
  #assertNotReading(): void {
    if (this.#outer === 'snapshot') {
      throw new TypeError(
        'A snapshot is for reading; change rows in a transaction, opened outside it',
      );
    }
  }

  /**
   * Inside `transaction` or `snapshot`, SQLite's own transaction must still be open. It
   * ends by itself after some failures, such as a full disk; a statement run after that
   * would be committed on its own.
   */
  #assertTransaction(connection: SqliteDatabase): void {
    if (this.#depth > 0 && !connection.isTransaction) {
      throw new StateDatabaseError(
        'transaction_lost',
        `SQLite ended the transaction on ${this.file} after a failure; none of it was kept`,
      );
    }
  }

  #query(sql: string): SqliteStatement {
    const connection = this.#open();
    // `query_only` already rejects a change. This keeps pragmas, checkpoints and the like
    // away from a reader's connection as well.
    if (this.mode === 'reader' && !QUERY.test(sql)) {
      throw new StateDatabaseError(
        'read_only',
        `${this.file} is open for reading and accepts only queries`,
      );
    }
    // On a writer, `get` and `all` read as well: a change made through them would not be
    // counted as one, nor refused inside a snapshot. A setting may be read, not set.
    if ((!QUERY.test(sql) && !SETTING_READ.test(sql)) || CHANGE_WORD.test(sql)) {
      throw new TypeError(`get() and all() read; change rows with run() or insert(): ${sql}`);
    }
    assertOneStatement(sql);
    this.#assertTransaction(connection);
    return this.#prepared(this.#queries, connection, sql, false);
  }

  /**
   * A statement that changes rows reads integers as big integers. After some deletes from
   * the full-text index, the last row id SQLite reports is one of the index's own and
   * beyond what a number holds. With the default setting the driver then throws on
   * Node.js 26 and returns a rounded number on Node.js 24, although the statement ran.
   */
  #change(sql: string): SqliteStatement {
    this.#assertWriter();
    this.#assertNotReading();
    const connection = this.#open();
    assertOneStatement(sql);
    // A statement that fails is undone by SQLite unless it says otherwise; `or fail` would
    // keep part of it, and nothing here would know.
    if (KEEPS_HALF.test(sql)) {
      throw new TypeError(`A statement must be undone whole when it fails: ${sql}`);
    }
    this.#assertTransaction(connection);
    return this.#prepared(this.#changes, connection, sql, true);
  }

  #prepared(
    cache: Map<string, SqliteStatement>,
    connection: SqliteDatabase,
    sql: string,
    bigIntegers: boolean,
  ): SqliteStatement {
    let statement = cache.get(sql);
    if (!statement) {
      statement = connection.prepare(sql);
      if (bigIntegers) statement.setReadBigInts(true);
      if (cache.size >= STATEMENT_CACHE_LIMIT) cache.clear();
      cache.set(sql, statement);
    }
    return statement;
  }

  #within<T>(kind: 'transaction' | 'snapshot', work: () => Synchronous<T>): T {
    const connection = this.#open();
    if (this.#depth > 0) {
      this.#assertTransaction(connection);
      this.#depth += 1;
      const writes = this.#writes;
      try {
        return synchronous(work());
      } catch (error) {
        // Changes half made must not be committed by an outer caller that carries on. Work
        // that failed before it changed anything, such as a read, leaves nothing half made.
        if (this.#writes !== writes) this.#failure ??= { cause: error };
        throw error;
      } finally {
        // `close()` inside the work has already set the depth to nothing.
        this.#depth = Math.max(0, this.#depth - 1);
      }
    }
    connection.exec(kind === 'transaction' ? 'begin immediate' : 'begin');
    if (kind === 'snapshot') {
      // A plain `begin` takes its snapshot at the first read, so read once before `work`.
      try {
        connection.exec('select 1 from sqlite_master limit 1');
      } catch (error) {
        rollback(connection);
        throw error;
      }
    }
    this.#depth = 1;
    this.#outer = kind;
    this.#failure = null;
    let result: T;
    try {
      result = synchronous(work());
    } catch (error) {
      this.#depth = 0;
      this.#outer = null;
      if (this.#connection) rollback(connection);
      throw error;
    }
    this.#depth = 0;
    this.#outer = null;
    // `work` may have closed the database, which rolled the transaction back.
    if (!this.#connection) {
      throw new StateDatabaseError('closed', `${this.file} was closed inside a transaction`);
    }
    if (!connection.isTransaction) {
      throw new StateDatabaseError(
        'transaction_lost',
        `SQLite ended the transaction on ${this.file} after a failure; none of it was kept`,
      );
    }
    const failure = this.#failure as { cause: unknown } | null;
    if (failure) {
      rollback(connection);
      throw new Error(
        'Nested work changed rows and then failed, and its error was caught; the whole transaction was rolled back.',
        { cause: failure.cause },
      );
    }
    try {
      connection.exec('commit');
    } catch (error) {
      rollback(connection);
      throw error;
    }
    return result;
  }
}

/** The driver compiles only the first statement of a text and says nothing about the rest. */
function assertOneStatement(sql: string): void {
  if (sql.includes(';')) {
    throw new TypeError(`One statement at a time, with its values as parameters: ${sql}`);
  }
  if (TRANSACTION_CONTROL.test(sql)) {
    throw new TypeError(`Transactions are opened with transaction() and snapshot(): ${sql}`);
  }
}

function synchronous<T>(value: Synchronous<T>): T {
  if (typeof (value as { then?: unknown } | null)?.then === 'function') {
    throw new TypeError(
      'A state database transaction must be synchronous; its work returned a promise.',
    );
  }
  return value as T;
}
