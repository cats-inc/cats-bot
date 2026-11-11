import { existsSync } from 'node:fs';
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
 * It hands out no SQLite connection. The store modules beside it get `get`, `all`, `run` and
 * the two transaction helpers, and the rest of the bot gets what those modules build; the
 * architecture boundary test keeps this file out of every other directory.
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
  /** The file is not a SQLite database, or not one a bot wrote. */
  | 'not_a_bot_database'
  /** A newer Cats Bot wrote it. Nothing is changed. */
  | 'newer_schema'
  /** The SQLite built into this runtime lacks what the schema needs. */
  | 'unsupported_sqlite'
  /** A change was asked of a reader. */
  | 'read_only'
  | 'closed';

export class StateDatabaseError extends Error {
  readonly code: StateDatabaseErrorCode;

  constructor(code: StateDatabaseErrorCode, message: string) {
    super(message);
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
}

export interface StateDatabase {
  readonly file: string;
  readonly mode: StateDatabaseMode;
  readonly isOpen: boolean;
  /** The first row of a query, or undefined. A reader accepts only `select` and `with`. */
  get(sql: string, ...parameters: SqliteInput[]): StateRow | undefined;
  all(sql: string, ...parameters: SqliteInput[]): StateRow[];
  /** One statement that changes rows; returns how many it changed. Refused on a reader. */
  run(sql: string, ...parameters: SqliteInput[]): number;
  /** An insert into an ordinary table; returns the new row's id. Refused on a reader. */
  insert(sql: string, ...parameters: SqliteInput[]): number;
  /**
   * All of `work` or none of it. `work` is synchronous. A nested call joins the outer
   * transaction, and a failure inside it rolls the whole transaction back even when the
   * outer code catches the error. Refused on a reader.
   */
  transaction<T>(work: () => T): T;
  /**
   * Runs `work` against one snapshot, taken before `work` starts, so that several queries
   * agree with each other whatever is committed meanwhile.
   */
  snapshot<T>(work: () => T): T;
  meta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  /** Safe to call twice. An open transaction is rolled back. */
  close(): void;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const QUERY = /^\s*(?:select|with)\b/iu;
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
  const unc = windows ? /^\\\\(?:\?\\UNC\\)?([^\\?.][^\\]*)\\(.+)$/u.exec(file) : null;
  if (unc) {
    const path = unc[2]!.split('\\').map(encodeURIComponent).join('/');
    return `file:////${unc[1]!}/${path}?mode=rw`;
  }
  const url = pathToFileURL(file, { windows });
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
    // Before anything that changes the file: a database from a newer version, or a file
    // that is not ours, is left exactly as it was found (FR-4).
    const found = inspect(connection, options.file);
    const journal = connection.prepare('pragma journal_mode=wal').get()?.journal_mode;
    if (journal !== 'wal') {
      throw new Error(
        `${options.file} could not be switched to write-ahead logging (it stayed ${String(journal)})`,
      );
    }
    connection.exec('pragma synchronous=normal');
    if (found === 'empty') createSchema(connection, (options.now ?? (() => new Date()))());
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
  if (!existsSync(options.file)) throw missing();
  let connection: SqliteDatabase;
  try {
    connection = new DatabaseSync(existingDatabaseUri(options.file));
  } catch (error) {
    // Removed between the check and the open.
    if (sqliteCode(error) === SQLITE_CANTOPEN && !existsSync(options.file)) throw missing();
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

/** Reads what the file is without changing it. */
function inspect(connection: SqliteDatabase, file: string): 'empty' | 'current' {
  const notOurs = (why: string): StateDatabaseError =>
    new StateDatabaseError(
      'not_a_bot_database',
      `${file} is not a Cats Bot state database: ${why}. Nothing was changed.`,
    );
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
  const hasMeta = connection
    .prepare(`select 1 as found from sqlite_master where type = 'table' and name = 'meta'`)
    .get();
  const stored = hasMeta
    ? connection.prepare(`select value from meta where key = 'schema_version'`).get()?.value
    : undefined;
  const version =
    typeof stored === 'string' && /^[1-9]\d*$/u.test(stored) ? Number(stored) : Number.NaN;
  if (!Number.isSafeInteger(version)) throw notOurs('it has no schema version');
  if (version > STATE_SCHEMA_VERSION) {
    throw new StateDatabaseError(
      'newer_schema',
      `${file} was written by a newer Cats Bot (schema ${version}; this version reads up to ${STATE_SCHEMA_VERSION}). Nothing was changed.`,
    );
  }
  return 'current';
}

function createSchema(connection: SqliteDatabase, now: Date): void {
  connection.exec('begin immediate');
  try {
    connection.exec(`pragma application_id=${STATE_APPLICATION_ID}`);
    connection.exec(STATE_SCHEMA_SQL);
    const insert = connection.prepare('insert into meta(key, value) values (?, ?)');
    insert.run('schema_version', String(STATE_SCHEMA_VERSION));
    insert.run('created_at', now.toISOString());
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
  };
  const value = JSON.stringify(runtime);
  if (database.meta('runtime') !== value) database.setMeta('runtime', value);
}

let supported: { version: string } | { error: string } | undefined;

/** `contentless_delete` needs SQLite 3.43, and the index needs FTS5. Checked once. */
function supportedSqliteVersion(): string {
  if (!supported) {
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
  private connection: SqliteDatabase | null;
  private readonly statements = new Map<string, SqliteStatement>();
  private readonly changes = new Map<string, SqliteStatement>();
  private depth = 0;
  private doomed = false;

  constructor(file: string, mode: StateDatabaseMode, connection: SqliteDatabase) {
    this.file = file;
    this.mode = mode;
    this.connection = connection;
  }

  get isOpen(): boolean {
    return this.connection !== null;
  }

  get(sql: string, ...parameters: SqliteInput[]): StateRow | undefined {
    return this.query(sql).get(...parameters);
  }

  all(sql: string, ...parameters: SqliteInput[]): StateRow[] {
    return this.query(sql).all(...parameters);
  }

  run(sql: string, ...parameters: SqliteInput[]): number {
    return Number(this.change(sql).run(...parameters).changes);
  }

  insert(sql: string, ...parameters: SqliteInput[]): number {
    const { lastInsertRowid } = this.change(sql).run(...parameters);
    if (lastInsertRowid > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        `The row id ${lastInsertRowid} is not that of a row in an ordinary table`,
      );
    }
    return Number(lastInsertRowid);
  }

  transaction<T>(work: () => T): T {
    this.assertWriter();
    return this.within('begin immediate', work);
  }

  snapshot<T>(work: () => T): T {
    return this.within('begin', work, true);
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
    const connection = this.connection;
    if (!connection) return;
    this.connection = null;
    this.statements.clear();
    this.changes.clear();
    this.depth = 0;
    connection.close();
  }

  private open(): SqliteDatabase {
    if (!this.connection) throw new StateDatabaseError('closed', `${this.file} is closed`);
    return this.connection;
  }

  private assertWriter(): void {
    this.open();
    if (this.mode !== 'writer') {
      throw new StateDatabaseError(
        'read_only',
        `${this.file} is open for reading; only the core that holds the bot's lock changes it`,
      );
    }
  }

  private query(sql: string): SqliteStatement {
    // `query_only` already rejects a change. This keeps pragmas, checkpoints and the like
    // away from a reader's connection as well.
    if (this.mode === 'reader' && !QUERY.test(sql)) {
      this.open();
      throw new StateDatabaseError(
        'read_only',
        `${this.file} is open for reading and accepts only queries`,
      );
    }
    return this.statement(sql);
  }

  private statement(sql: string): SqliteStatement {
    const connection = this.open();
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = connection.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * A statement that changes rows reads integers as big integers. After some deletes from
   * the full-text index, the last row id SQLite reports is one of the index's own and
   * beyond what a number holds. With the default setting the driver then throws on
   * Node.js 26 and returns a rounded number on Node.js 24, although the statement ran.
   */
  private change(sql: string): SqliteStatement {
    this.assertWriter();
    const connection = this.open();
    let statement = this.changes.get(sql);
    if (!statement) {
      statement = connection.prepare(sql);
      statement.setReadBigInts(true);
      this.changes.set(sql, statement);
    }
    return statement;
  }

  private within<T>(begin: string, work: () => T, readNow = false): T {
    const connection = this.open();
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return synchronous(work());
      } catch (error) {
        this.doomed = true;
        throw error;
      } finally {
        this.depth -= 1;
      }
    }
    connection.exec(begin);
    if (readNow) {
      // A plain `begin` takes its snapshot at the first read, so read once before `work`.
      try {
        connection.exec('select 1 from sqlite_master limit 1');
      } catch (error) {
        rollback(connection);
        throw error;
      }
    }
    this.depth = 1;
    this.doomed = false;
    let result: T;
    try {
      result = synchronous(work());
    } catch (error) {
      this.depth = 0;
      if (this.connection) rollback(connection);
      throw error;
    }
    this.depth = 0;
    // `work` may have closed the database, which rolled the transaction back.
    if (!this.connection)
      throw new StateDatabaseError('closed', `${this.file} was closed inside a transaction`);
    if (this.doomed) {
      rollback(connection);
      throw new Error(
        'A nested transaction failed and its error was caught; the whole transaction was rolled back.',
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

function synchronous<T>(value: T): T {
  if (typeof (value as { then?: unknown } | null)?.then === 'function') {
    throw new TypeError(
      'A state database transaction must be synchronous; its work returned a promise.',
    );
  }
  return value;
}
