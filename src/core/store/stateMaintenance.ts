import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotPaths } from './paths.ts';
import { stateDatabaseFile } from './paths.ts';
import { checkReportFile, parseTimeStamp, timeStamp } from './checkReport.ts';

export { checkReportSince } from './checkReport.ts';

export { isDamagedDatabaseError } from './stateDatabase.ts';

/**
 * SPEC-014 FR-13: the state database's check at start and its daily snapshot.
 *
 * Both read the database on a read-only connection of their own, in a child process, so
 * that the core goes on answering meanwhile and can end them at once: SQLite's calls block
 * the thread that makes them, and nothing interrupts one in a worker thread. Measured inside
 * Electron 41 on a 330 MB database of a million made-up entries, the check took 16 to 17 s
 * and the snapshot 9 s; both grow with the file. A snapshot is written under a name that
 * says it is unfinished and renamed when it is whole, so an interrupted one is never taken
 * for the newest.
 */

/** How many snapshots are kept; older ones are removed once a newer one is whole. */
export const SNAPSHOTS_KEPT = 3;
/** A snapshot is due once the newest is this old. */
export const SNAPSHOT_INTERVAL_MS = 24 * 3_600_000;

const SNAPSHOT_NAME = /^bot-(\d{8}T\d{6}\d{3}Z)\.db$/u;
const UNFINISHED = '.partial';

export interface Snapshot {
  file: string;
  takenAt: Date;
}

/** Where the snapshots are kept. */
export function backupsDirectory(paths: BotPaths): string {
  return join(paths.root, 'backups');
}

/** The whole snapshots, newest first. */
export function snapshots(paths: BotPaths): Snapshot[] {
  const directory = backupsDirectory(paths);
  if (!existsSync(directory)) return [];
  const found: Snapshot[] = [];
  for (const name of readdirSync(directory)) {
    const stamp = SNAPSHOT_NAME.exec(name)?.[1];
    if (!stamp) continue;
    const takenAt = parseTimeStamp(stamp);
    if (takenAt) found.push({ file: join(directory, name), takenAt });
  }
  return found.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

export function newestSnapshot(paths: BotPaths): Snapshot | null {
  return snapshots(paths)[0] ?? null;
}

/**
 * Whether a day has passed since the newest snapshot, or there is none. One named after a
 * time still to come, as a clock set back leaves it, does not hold the next one back.
 */
export function snapshotDue(paths: BotPaths, now: Date): boolean {
  const newest = newestSnapshot(paths);
  if (!newest || newest.takenAt.getTime() > now.getTime()) return true;
  return now.getTime() - newest.takenAt.getTime() >= SNAPSHOT_INTERVAL_MS;
}

/** A task running in its own process; `cancel` ends it and settles once the process is gone. */
export interface MaintenanceTask<T> {
  readonly result: Promise<T>;
  cancel(): Promise<void>;
}

/**
 * A task that failed because the database is damaged carries `damaged: true`; the core
 * treats it as a check that failed.
 */
export interface MaintenanceError extends Error {
  damaged?: boolean;
}

/** What `pragma quick_check` finds wrong with the bot's database, or nothing. */
export function checkStateDatabase(paths: BotPaths): MaintenanceTask<string[]> {
  return runInChild<string[]>({ task: 'check', file: stateDatabaseFile(paths) });
}

/**
 * A snapshot of the bot's database in `backups/`, named after `now`. The older ones past
 * the newest three, and any unfinished one, are removed once it is whole.
 */
export function takeSnapshot(paths: BotPaths, now: Date): MaintenanceTask<Snapshot> {
  const directory = backupsDirectory(paths);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `bot-${timeStamp(now)}.db`);
  const unfinished = `${file}${UNFINISHED}`;
  // Left by a snapshot that was stopped; `vacuum into` writes only to a new file.
  removeUnfinished(unfinished);
  const task = runInChild<null>({
    task: 'snapshot',
    file: stateDatabaseFile(paths),
    target: unfinished,
  });
  const result = task.result.then(
    () => {
      renameSync(unfinished, file);
      prune(paths);
      return { file, takenAt: now };
    },
    (error: unknown) => {
      removeUnfinished(unfinished);
      throw error;
    },
  );
  return { result, cancel: task.cancel };
}

/**
 * SPEC-014 FR-13: a report of a check that failed, beside the database, with the newest
 * snapshot and how to put it in place. Returns its path.
 */
export function writeCheckReport(paths: BotPaths, problems: readonly string[], now: Date): string {
  const file = checkReportFile(paths, now);
  const newest = newestSnapshot(paths);
  const listed = problems.slice(0, 100);
  const lines = [
    `Cats Bot stopped at ${now.toISOString()}: its state database failed its check.`,
    `Database: ${stateDatabaseFile(paths)}`,
    '',
    'What SQLite found:',
    ...listed.map((problem) => `  ${problem.replace(/\n/gu, '\n  ')}`),
    ...(problems.length > listed.length ? [`  and ${problems.length - listed.length} more`] : []),
    '',
    newest
      ? `The newest snapshot: ${newest.file} (taken ${newest.takenAt.toISOString()}).`
      : 'There is no snapshot yet. While the file can still be read, `cats-bot export` writes each',
    ...(newest
      ? []
      : [
          'conversation out; the copy of the files from before the database, if the bot had them,',
          'is in migration-backup/.',
        ]),
    ...(newest
      ? [
          'To go back to it: quit the bot; move bot.db, bot.db-wal and bot.db-shm out of the',
          "bot's folder, keeping them; copy the snapshot there as bot.db; start the bot.",
          'What was written after the snapshot was taken is not in it.',
        ]
      : []),
    '',
  ];
  writeFileSync(file, lines.join('\n'));
  return file;
}

/** An unfinished snapshot, with the journal SQLite keeps beside it while it writes. */
function removeUnfinished(file: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm'])
    rmSync(`${file}${suffix}`, { force: true });
}

function prune(paths: BotPaths): void {
  for (const old of snapshots(paths).slice(SNAPSHOTS_KEPT)) rmSync(old.file, { force: true });
  const directory = backupsDirectory(paths);
  for (const name of readdirSync(directory)) {
    if (name.includes(UNFINISHED)) rmSync(join(directory, name), { force: true });
  }
}

interface MaintenanceRequest {
  task: 'check' | 'snapshot';
  file: string;
  target?: string;
}

type MaintenanceReply =
  { ok: true; value: unknown } | { ok: false; message: string; damaged: boolean };

/** At most this much of the child's error output is kept for a task that ended without a reply. */
const STDERR_KEPT = 4096;

function runInChild<T>(request: MaintenanceRequest): MaintenanceTask<T> {
  // In a build the script is the compiled `.js` beside this module; in the tests, the source.
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const script = fileURLToPath(new URL(`./stateMaintenanceProcess.${extension}`, import.meta.url));
  // As the supervisor starts the Runtime: the same executable, as Node.js inside Electron.
  const child = fork(script, [JSON.stringify(request)], {
    execArgv: [],
    env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < STDERR_KEPT) stderr += chunk.slice(0, STDERR_KEPT - stderr.length);
  });
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  let cancelled = false;
  const result = new Promise<T>((resolve, reject) => {
    let reply: MaintenanceReply | null = null;
    child.once('message', (message: MaintenanceReply) => {
      reply = message;
    });
    child.once('error', (error) => reject(error));
    child.once('exit', (code, signal) => {
      if (reply?.ok) {
        resolve(reply.value as T);
      } else if (reply) {
        reject(
          Object.assign(new Error(reply.message), { damaged: reply.damaged }) as MaintenanceError,
        );
      } else {
        const why = cancelled ? 'was stopped' : `ended (${signal ?? `exit ${code}`})`;
        reject(
          new Error(
            `The state database's ${request.task} ${why}${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        );
      }
    });
  });
  return {
    result,
    cancel: async () => {
      cancelled = true;
      // A process ends at once, a SQLite call in the middle of its work included.
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}
