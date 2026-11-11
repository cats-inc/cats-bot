import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { BotPaths } from './paths.ts';
import { stateDatabaseFile } from './paths.ts';

export { isDamagedDatabaseError } from './stateDatabase.ts';

/**
 * SPEC-014 FR-13: the state database's check at start and its daily snapshot.
 *
 * Both read the database on a read-only connection of their own, in a worker thread, so
 * that the core goes on answering meanwhile: with a million entries the check takes
 * about a minute and the snapshot most of one, and SQLite's calls block the thread that
 * makes them. A snapshot is written under a name that says it is unfinished and renamed
 * when it is whole, so an interrupted one is never taken for the newest.
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
    const takenAt = parseStamp(stamp);
    if (takenAt) found.push({ file: join(directory, name), takenAt });
  }
  return found.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

export function newestSnapshot(paths: BotPaths): Snapshot | null {
  return snapshots(paths)[0] ?? null;
}

/** Whether a day has passed since the newest snapshot, or there is none. */
export function snapshotDue(paths: BotPaths, now: Date): boolean {
  const newest = newestSnapshot(paths);
  return !newest || now.getTime() - newest.takenAt.getTime() >= SNAPSHOT_INTERVAL_MS;
}

/** A task running in its worker; `cancel` ends it and settles once the worker is gone. */
export interface MaintenanceTask<T> {
  readonly result: Promise<T>;
  cancel(): Promise<void>;
}

/** What `pragma quick_check` finds wrong with the bot's database, or nothing. */
export function checkStateDatabase(paths: BotPaths): MaintenanceTask<string[]> {
  return runInWorker<string[]>({ task: 'check', file: stateDatabaseFile(paths) });
}

/**
 * A snapshot of the bot's database in `backups/`, named after `now`. The older ones past
 * the newest three, and any unfinished one, are removed once it is whole.
 */
export function takeSnapshot(paths: BotPaths, now: Date): MaintenanceTask<Snapshot> {
  const directory = backupsDirectory(paths);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `bot-${stamp(now)}.db`);
  const unfinished = `${file}${UNFINISHED}`;
  // Left by a snapshot that was stopped; `vacuum into` writes only to a new file.
  rmSync(unfinished, { force: true });
  const task = runInWorker<null>({
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
      rmSync(unfinished, { force: true });
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
  const file = join(paths.root, `state-check-${stamp(now)}.txt`);
  const newest = newestSnapshot(paths);
  const listed = problems.slice(0, 100);
  const lines = [
    `Cats Bot stopped at ${now.toISOString()}: its state database failed its check.`,
    `Database: ${stateDatabaseFile(paths)}`,
    '',
    'What SQLite found:',
    ...listed.map((problem) => `  ${problem}`),
    ...(problems.length > listed.length ? [`  and ${problems.length - listed.length} more`] : []),
    '',
    newest
      ? `The newest snapshot: ${newest.file} (taken ${newest.takenAt.toISOString()}).`
      : 'There is no snapshot yet.',
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

function prune(paths: BotPaths): void {
  for (const old of snapshots(paths).slice(SNAPSHOTS_KEPT)) rmSync(old.file, { force: true });
  const directory = backupsDirectory(paths);
  for (const name of readdirSync(directory)) {
    if (name.endsWith(UNFINISHED)) rmSync(join(directory, name), { force: true });
  }
}

interface WorkerRequest {
  task: 'check' | 'snapshot';
  file: string;
  target?: string;
}

type WorkerReply = { ok: true; value: unknown } | { ok: false; message: string; code?: unknown };

function runInWorker<T>(request: WorkerRequest): MaintenanceTask<T> {
  // In a build the worker is the compiled `.js` beside this module; in the tests, the source.
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = new Worker(new URL(`./stateMaintenanceWorker.${extension}`, import.meta.url), {
    workerData: request,
  });
  let settled = false;
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
  const result = new Promise<T>((resolve, reject) => {
    worker.once('message', (reply: WorkerReply) => {
      settled = true;
      if (reply.ok) resolve(reply.value as T);
      else reject(Object.assign(new Error(reply.message), { code: reply.code }));
    });
    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`The state database's ${request.task} ended (exit ${code})`));
    });
  });
  return {
    result,
    cancel: async () => {
      await worker.terminate();
      await exited;
    },
  };
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[-:.]/gu, '');
}

function parseStamp(text: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/u.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const at = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}
