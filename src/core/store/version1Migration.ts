import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from './atomicFile.ts';
import { acquireInstanceLock, readInstanceLock } from './lock.ts';
import { stateDatabaseFile, type BotPaths } from './paths.ts';
import { presentationsDirectory } from './presentation.ts';
import { StateDatabaseError } from './stateDatabase.ts';
import { openBotStateStore } from './stateStore.ts';
import {
  importVersion1,
  type ImportVersion1Options,
  type Version1ImportReport,
} from './version1Import.ts';

/**
 * SPEC-014 FR-11 and FR-12: a bot's version-1 files moved into its state database, and back.
 *
 * `migrateVersion1` decides what to do from the database's marker, never from which
 * directories exist, since today's code makes them again when it finds none:
 *
 * - no marker: whatever database there is was left by an import that did not finish, and is
 *   removed with its `-wal` and `-shm`. The version-1 files are copied aside, a manifest
 *   written last, and imported. When the import does not finish, a JSON and a Markdown
 *   report are written beside the copy, the database is removed, and the version-1 files
 *   stay as they were;
 * - a marker: the database is the bot's. The profile's schema version is raised, so that an
 *   older Bot refuses the root instead of starting on files that are no longer read, and
 *   the version-1 files are moved to `archive/v1/`, each as far as it can be. Both steps
 *   are repeated at the next start until they are done.
 *
 * A database this version cannot open as its own, a newer one included, stops the migration
 * and is never removed. Nothing calls these yet; the cutover wires them into the core's start
 * and adds `cats-bot restore` (PLAN-014 task 1.5).
 */

/** The steps, in order, for a test that stops the migration before one of them. */
export type MigrationStep = 'discard' | 'backup' | 'import' | 'report' | 'profile' | 'archive';

export interface ProfileRaise {
  /** The schema version a version-1 root's profile has. */
  from: number;
  /** The schema version a migrated root's profile has, which older Bots refuse. */
  to: number;
}

export interface MigrateVersion1Options {
  paths: BotPaths;
  profile: ProfileRaise;
  now?: () => Date;
  /** Passed to the import. */
  open?: ImportVersion1Options['open'];
  /** Called before each step, with the item an archive move is about; a test throws there. */
  beforeStep?: (step: MigrationStep, item?: string) => void;
}

export type MigrationResult =
  | {
      outcome: 'migrated';
      /** The import's report, when this run imported; null when an earlier run did. */
      imported: Version1ImportReport | null;
      backup: string | null;
      /** Version-1 items that could not be moved yet, with the error's code. */
      notArchived: string[];
    }
  | {
      outcome: 'not_migrated';
      backup: string;
      report: string;
      summary: string;
    };

const MANIFEST = 'manifest.json';
const IN_PROGRESS = 'copy-in-progress';

/** The files of the version-1 store, copied aside and then archived. `profile.json` stays. */
export function version1Items(paths: BotPaths): string[] {
  return [paths.conversations, paths.transcripts, presentationsDirectory(paths), paths.journal];
}

export function migrationBackupDirectory(paths: BotPaths): string {
  return join(paths.root, 'migration-backup');
}

export function version1ArchiveDirectory(paths: BotPaths): string {
  return join(paths.root, 'archive', 'v1');
}

export function migrateVersion1(options: MigrateVersion1Options): MigrationResult {
  const { paths } = options;
  const now = options.now ?? (() => new Date());
  const before = options.beforeStep ?? (() => {});
  if (readInstanceLock(paths)?.pid !== process.pid) {
    throw new Error("The version-1 migration runs only in the process that holds the bot's lock");
  }
  const file = stateDatabaseFile(paths);
  let imported: Version1ImportReport | null = null;
  let backup: string | null = null;

  if (!isFinished(file)) {
    before('discard');
    removeDatabase(file);
    removeIncompleteCopies(paths);
    before('backup');
    backup = copyAside(paths, now());
    before('import');
    let report: Version1ImportReport | undefined;
    let error: unknown;
    try {
      report = importVersion1({
        paths,
        file,
        now,
        ...(options.open ? { open: options.open } : {}),
      });
    } catch (thrown) {
      error = thrown;
    }
    if (!report?.finished) {
      before('report');
      const written = writeReport(backup, report, error, now());
      removeDatabase(file);
      return { outcome: 'not_migrated', backup, ...written };
    }
    imported = report;
  }

  before('profile');
  raiseProfile(paths, options.profile, now());
  const notArchived: string[] = [];
  for (const item of version1Items(paths)) {
    if (!existsSync(item)) continue;
    before('archive', basename(item));
    try {
      moveInto(item, version1ArchiveDirectory(paths), now());
    } catch (thrown) {
      notArchived.push(`${basename(item)}: ${errorCode(thrown)}`);
    }
  }
  return { outcome: 'migrated', imported, backup, notArchived };
}

export interface RestoreVersion1Options {
  paths: BotPaths;
  /** The raise the migration made, undone. */
  profile: ProfileRaise;
  now?: () => Date;
  /** Called before each step; a test throws there. */
  beforeStep?: (step: 'files' | 'database' | 'profile') => void;
}

/**
 * SPEC-014 FR-12: the version-1 files put back from `archive/v1/`, for a downgrade, while the
 * bot is stopped. It takes the bot's lock itself. In this order, so that a crash on the way
 * leaves a root either version starts on: the files go back, the database is set aside under
 * a new name, and the profile's schema version is lowered. What was written to the database
 * after the migration is in the set-aside file and not in the version-1 files.
 */
export function restoreVersion1(options: RestoreVersion1Options): { setAside: string | null } {
  const { paths } = options;
  const now = options.now ?? (() => new Date());
  const before = options.beforeStep ?? (() => {});
  const lock = acquireInstanceLock(paths);
  if (!lock.held)
    throw new Error('The bot is running; stop it before restoring its version-1 files');
  try {
    const archive = version1ArchiveDirectory(paths);
    before('files');
    for (const item of version1Items(paths)) {
      const archived = join(archive, basename(item));
      if (!existsSync(archived)) continue;
      if (existsSync(item)) {
        if (!isEmptyDirectory(item)) {
          throw new Error(
            `${basename(item)} is both in the bot root and in archive/v1; nothing more was restored`,
          );
        }
        rmdirSync(item);
      }
      renameSync(archived, item);
    }
    const file = stateDatabaseFile(paths);
    let setAside: string | null = null;
    before('database');
    if (existsSync(file)) {
      setAside = freeName(`${file}.set-aside-${stamp(now())}`);
      // The log and the shared memory go with it, under the names SQLite looks for.
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${setAside}${suffix}`);
      }
      renameSync(file, setAside);
    }
    before('profile');
    lowerProfile(paths, options.profile, now());
    return { setAside };
  } finally {
    lock.release();
  }
}

/** Whether the file is this version's state database with the import's marker. */
function isFinished(file: string): boolean {
  if (!existsSync(file)) return false;
  let store;
  try {
    store = openBotStateStore({ file, mode: 'reader' });
  } catch (error) {
    if (error instanceof StateDatabaseError && error.code === 'missing') return false;
    // A newer database, or a file that is not one, is never removed.
    throw error;
  }
  try {
    return store.importMarker() !== undefined;
  } finally {
    store.close();
  }
}

/**
 * The database an unfinished import left, with its log, or a log and shared memory left
 * without a database. A new database would not replay a log of another one (measured on
 * both runtimes), but nothing is left to try.
 */
function removeDatabase(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
}

/** Copies an earlier run could not finish: they hold the mark they were made with. */
function removeIncompleteCopies(paths: BotPaths): void {
  const directory = migrationBackupDirectory(paths);
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const copy = join(directory, name);
    if (existsSync(join(copy, IN_PROGRESS))) rmSync(copy, { recursive: true, force: true });
  }
}

/**
 * The version-1 files and the profile, copied to `migration-backup/<time>/`. The copy is
 * marked as in progress until its manifest, which lists every file with its size and
 * SHA-256, is written last.
 */
function copyAside(paths: BotPaths, at: Date): string {
  const copy = freeName(join(migrationBackupDirectory(paths), stamp(at)));
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, IN_PROGRESS), '');
  for (const item of [...version1Items(paths), paths.profile]) {
    if (existsSync(item)) copyTree(item, join(copy, basename(item)));
  }
  const files = listFiles(copy)
    .filter((file) => file !== join(copy, IN_PROGRESS))
    .map((file) => {
      const bytes = readFileSync(file);
      return {
        path: relative(copy, file).split(sep).join('/'),
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
  writeJsonAtomic(join(copy, MANIFEST), { version: 1, madeAt: at.toISOString(), files });
  rmSync(join(copy, IN_PROGRESS));
  return copy;
}

/** FR-12: why the import did not finish, beside the copy, as JSON and as Markdown. */
function writeReport(
  copy: string,
  report: Version1ImportReport | undefined,
  error: unknown,
  at: Date,
): { report: string; summary: string } {
  const failure = error === undefined ? null : errorText(error);
  const json = join(copy, 'report.json');
  writeJsonAtomic(json, {
    version: 1,
    writtenAt: at.toISOString(),
    error: failure,
    import: report ?? null,
  });

  const lines = [
    '# The bot data migration did not finish',
    '',
    `Written ${at.toISOString()}. The bot did not start, and its version-1 files are as they`,
    'were. This folder holds a copy of them, and `report.json` holds this report in full.',
    '',
  ];
  if (failure !== null) lines.push('## Error', '', failure, '');
  if (report) {
    const blocking = report.problems.filter((found) => found.blocks);
    const others = report.problems.filter((found) => !found.blocks);
    for (const [title, list] of [
      ['What stopped it', blocking],
      ['Also found', others],
    ] as const) {
      if (list.length === 0) continue;
      lines.push(`## ${title}`, '');
      for (const found of list) {
        const where = found.lines
          ? ` line ${found.lines.join(', ')}${(found.count ?? 0) > found.lines.length ? ` and ${(found.count ?? 0) - found.lines.length} more` : ''}`
          : '';
        const other = found.otherFile ? ` and ${found.otherFile}` : '';
        const reason = found.reason ? ` (${found.reason})` : '';
        lines.push(`- ${found.kind}: ${found.file}${other}${where}${reason}`);
      }
      lines.push('');
    }
    if (report.mismatches.length > 0) {
      lines.push('## Where the database differed from the files', '');
      for (const mismatch of report.mismatches) lines.push(`- ${mismatch}`);
      lines.push('');
    }
  }
  const markdown = join(copy, 'report.md');
  writeFileAtomic(markdown, `${lines.join('\n')}`);
  return { report: json, summary: markdown };
}

/**
 * The profile's schema version raised, after a copy of the profile as it was. A profile a
 * power cut left unreadable after an earlier run's copy is raised from that copy.
 */
function raiseProfile(paths: BotPaths, raise: ProfileRaise, at: Date): void {
  const backup = `${paths.profile}.v${raise.from}.bak`;
  let text = readText(paths.profile);
  let profile = parseRecord(text);
  if (profile === null) {
    const copy = parseRecord(readText(backup));
    if (copy === null || copy.schemaVersion !== raise.from) {
      throw new Error(`${paths.profile} cannot be read, and no copy of it was made to raise from`);
    }
    profile = copy;
    text = null;
  }
  if (profile.schemaVersion === raise.to) return;
  if (profile.schemaVersion !== raise.from) {
    throw new Error(
      `${paths.profile} has schema version ${String(profile.schemaVersion)}; the migration raises ${raise.from} to ${raise.to}`,
    );
  }
  if (text !== null) keepCopy(paths.profile, text, backup, at);
  writeJsonAtomic(paths.profile, { ...profile, schemaVersion: raise.to });
}

function lowerProfile(paths: BotPaths, raise: ProfileRaise, at: Date): void {
  const text = readText(paths.profile);
  const profile = parseRecord(text);
  if (profile === null) throw new Error(`${paths.profile} cannot be read; it was not lowered`);
  if (profile.schemaVersion === raise.from) return;
  if (profile.schemaVersion !== raise.to) {
    throw new Error(
      `${paths.profile} has schema version ${String(profile.schemaVersion)}; restoring lowers ${raise.to} to ${raise.from}`,
    );
  }
  keepCopy(paths.profile, text!, `${paths.profile}.v${raise.to}.bak`, at);
  writeJsonAtomic(paths.profile, { ...profile, schemaVersion: raise.from });
}

/** A copy of `text` at `copy`, or beside it under the time when another copy is there. */
function keepCopy(file: string, text: string, copy: string, at: Date): void {
  if (existsSync(copy)) {
    if (readText(copy) === text) return;
    copyFileSync(
      file,
      freeName(`${copy.slice(0, -'.bak'.length)}.${stamp(at)}.bak`),
      constants.COPYFILE_EXCL,
    );
    return;
  }
  copyFileSync(file, copy, constants.COPYFILE_EXCL);
}

/**
 * Moves a version-1 item into the archive. An item the archive holds already, as one made
 * again after an earlier move, is kept beside it under the time; an empty directory made
 * again is removed.
 */
function moveInto(item: string, archive: string, at: Date): void {
  mkdirSync(archive, { recursive: true });
  let target = join(archive, basename(item));
  if (existsSync(target)) {
    if (isEmptyDirectory(item)) {
      rmdirSync(item);
      return;
    }
    target = freeName(`${target}.${stamp(at)}`);
  }
  renameSync(item, target);
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[:.]/gu, '-');
}

/**
 * A file, or a directory with everything in it, copied to a path that does not exist yet.
 * Not `cpSync`: in Electron 41 (Node.js 24.14) on Windows it ends the process when it copies
 * a directory whose path holds a character outside ASCII, as a bot root under a user's
 * profile can.
 */
function copyTree(source: string, target: string): void {
  if (!statSync(source).isDirectory()) {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    return;
  }
  mkdirSync(target);
  for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
}

/** `name`, or `name-2`, `name-3` and so on, whichever does not exist. */
function freeName(name: string): string {
  if (!existsSync(name)) return name;
  for (let n = 2; ; n += 1) {
    if (!existsSync(`${name}-${n}`)) return `${name}-${n}`;
  }
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}

function isEmptyDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseRecord(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : errorText(error);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
