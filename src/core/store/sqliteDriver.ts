import type * as NodeSqlite from 'node:sqlite';

/**
 * SPEC-014 FR-2: the one place that reaches `node:sqlite`. Everything else in the bot uses the
 * storage adapter built on it, so a different driver can replace this module if the built-in
 * one stops passing `tests/core/sqliteDriver.test.ts` on a supported platform.
 *
 * The driver is loaded on first use, not at import: Node 24, which the app ships inside
 * Electron, still marks `node:sqlite` experimental and prints an ExperimentalWarning the moment
 * the module loads. A plain `import` would put that line on the stderr of every host that
 * reads bot data, including one-shot CLI commands.
 */

export type SqliteDriver = typeof NodeSqlite;
export type SqliteDatabase = NodeSqlite.DatabaseSync;
export type SqliteStatement = NodeSqlite.StatementSync;
/** What a statement accepts as a parameter and returns in a column. */
export type SqliteInput = NodeSqlite.SQLInputValue;
export type SqliteOutput = NodeSqlite.SQLOutputValue;

let driver: SqliteDriver | undefined;

/** Loads `node:sqlite` once, dropping only its own experimental notice. */
export function sqliteDriver(): SqliteDriver {
  if (driver) return driver;
  const emitWarning = process.emitWarning;
  const quiet = (warning: string | Error, ...rest: unknown[]): void => {
    if (isSqliteExperimentalNotice(warning)) return;
    Reflect.apply(emitWarning, process, [warning, ...rest]);
  };
  process.emitWarning = quiet as typeof process.emitWarning;
  let loaded: SqliteDriver | undefined;
  try {
    // Undefined when the runtime was started with `--no-experimental-sqlite`.
    if (typeof process.getBuiltinModule === 'function') {
      loaded = process.getBuiltinModule('node:sqlite') as SqliteDriver | undefined;
    }
  } finally {
    process.emitWarning = emitWarning;
  }
  if (typeof loaded?.DatabaseSync !== 'function') {
    throw new Error(
      `node:sqlite is not available in this Node.js (${process.version}). The bot state database needs Node.js 24 or later, started without --no-experimental-sqlite.`,
    );
  }
  driver = loaded;
  return driver;
}

function isSqliteExperimentalNotice(warning: string | Error): boolean {
  const text = typeof warning === 'string' ? warning : warning?.message;
  return typeof text === 'string' && /^SQLite is an experimental feature/u.test(text);
}
