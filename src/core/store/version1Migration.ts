import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { createProfile, loadProfile } from '../profile/profile.ts';
import { writeFileAtomic, writeJsonAtomic } from './atomicFile.ts';
import { acquireInstanceLock, readInstanceLock } from './lock.ts';
import { stateDatabaseFile, type BotPaths } from './paths.ts';
import { presentationsDirectory } from './presentation.ts';
import { removeTree } from './removeTree.ts';
import { StateDatabaseError } from './stateDatabase.ts';
import { newestSnapshot } from './stateMaintenance.ts';
import { openBotStateStore } from './stateStore.ts';
import {
  importVersion1,
  type ImportVersion1Options,
  type Version1ImportReport,
} from './version1Import.ts';

/**
 * SPEC-014 FR-11 and FR-12: a bot's version-1 files moved into its state database, and back.
 *
 * `migrateVersion1` decides what to do from the database's marker and the profile's schema
 * version, never from which directories exist, since today's code makes them again when it
 * finds none:
 *
 * - no marker, profile at `from`: whatever database there is was left by an import that did
 *   not finish, and is removed with its `-wal` and `-shm`. The profile is checked first as
 *   today's Bot checks it, and for being writable, so that nothing is imported that could
 *   not be finished. The version-1 files and the profile are copied aside, a manifest
 *   written last, and imported. When the import does not finish, a JSON and a Markdown
 *   report are written beside the copy, the database is removed, and the version-1 files
 *   stay as they were;
 * - no marker, profile at `to`: the root was migrated and its database is gone. Importing
 *   again would start the bot on files it stopped reading, so the migration stops;
 * - a marker: the database is the bot's. The profile's schema version is raised, so that an
 *   older Bot refuses the root instead of starting on files that are no longer read, and
 *   the version-1 files are moved to `archive/v1/`, each as far as it can be. Both steps
 *   are repeated at the next start until they are done.
 *
 * A database this version cannot open as its own, a newer one included, stops the migration
 * and is never removed. Every removal goes through `removeTree`, never `rmSync`, which in
 * Electron 41 fails on a read-only file and ends the process on some paths outside ASCII.
 * The core migrates when it opens the bot for writing, under the lock: at start and for a
 * write a host makes while the bot is stopped. `cats-bot restore` restores.
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
      /**
       * FR-11: the report of what this run's import found and did not import as it was,
       * beside the copy; null when it found nothing, or when an earlier run imported.
       */
      summary: string | null;
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
  let marker = readMarker(file);
  let imported: Version1ImportReport | null = null;
  let backup: string | null = null;
  let summary: string | null = null;

  if (marker === undefined) {
    checkProfileBeforeImport(paths, options.profile, now());
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
        marker: { backup: basename(backup) },
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
    // FR-11: what the import found is reported, never dropped, also when it finished.
    if (report.problems.length > 0) {
      summary = writeReport(backup, report, undefined, now()).summary;
    } else {
      // A copy reused from a run that did not finish keeps that run's report otherwise.
      for (const name of ['report.md', 'report.json']) removeTree(join(backup, name));
    }
    marker = readMarker(file);
  }

  before('profile');
  raiseProfile(paths, options.profile, backupOf(paths, marker), now());
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
  return { outcome: 'migrated', imported, backup, summary, notArchived };
}

/**
 * SPEC-014: a new bot's database, made by `cats-bot init` under the lock before the profile
 * is written at the raised version. A new bot has no version-1 files, so its database is
 * marked as one whose import has finished. Done again after a crash, it keeps what it made.
 */
export function createNewBotDatabase(paths: BotPaths, now: Date = new Date()): void {
  const file = stateDatabaseFile(paths);
  const store = openBotStateStore({ file, mode: 'writer', now: () => now });
  try {
    if (store.importMarker() !== undefined) return;
    if (!store.isEmpty())
      throw new Error(`${file} holds records but no marker; it is not a new bot's`);
    store.setImportMarker(JSON.stringify({ new: true, madeAt: now.toISOString() }));
  } finally {
    store.close();
  }
}

export interface RestoreVersion1Options {
  paths: BotPaths;
  /** The raise the migration made, undone. */
  profile: ProfileRaise;
  now?: () => Date;
  /** Called before each step; a test throws there. */
  beforeStep?: (step: 'files' | 'database' | 'profile') => void;
}

export interface RestoreResult {
  /** Whether anything was put back, set aside or lowered: false for a bot never migrated. */
  changed: boolean;
  /** Where the database was set aside, or null when there was none. */
  setAside: string | null;
  /** What `archive/v1/` still holds: items made again after the migration and kept there. */
  leftInArchive: string[];
}

/**
 * SPEC-014 FR-12: the version-1 files put back from `archive/v1/`, for a downgrade, while the
 * bot is stopped. It takes the bot's lock itself. In this order: the files go back; the
 * database's log is folded into it and the database is set aside whole under a new name;
 * the profile's schema version is lowered. A crash between two steps leaves a root the new
 * version starts on (it still holds its database) or one it refuses to import again (the
 * profile still says migrated), and running the restore again finishes it. What was written
 * to the database after the migration is in the set-aside file, not in the version-1 files.
 */
export function restoreVersion1(options: RestoreVersion1Options): RestoreResult {
  const { paths } = options;
  const now = options.now ?? (() => new Date());
  const before = options.beforeStep ?? (() => {});
  const lock = acquireInstanceLock(paths);
  if (!lock.held)
    throw new Error('The bot is running; stop it before restoring its version-1 files');
  try {
    const archive = version1ArchiveDirectory(paths);
    const file = stateDatabaseFile(paths);
    let setAside: string | null = null;
    let changed = false;
    // What the restore needs is looked at before anything is moved: version-1 files to put
    // back, and none of them in both places.
    const items = version1Items(paths);
    if (!items.some((item) => existsSync(item) || existsSync(join(archive, basename(item))))) {
      throw new Error(
        'Neither the bot root nor archive/v1 holds the version-1 files; nothing was restored',
      );
    }
    for (const item of items) {
      if (existsSync(join(archive, basename(item))) && existsSync(item) && !isEmptyDirectory(item)) {
        throw new Error(
          `${basename(item)} is both in the bot root and in archive/v1; nothing was restored`,
        );
      }
    }
    // A database this version cannot open, a newer one or a file that is not one, cannot be
    // folded; it is set aside whole, with its log, before the files go back, so that the
    // restore can go on and an older Bot starts on the files.
    if (existsSync(file) && !isOwnDatabase(file)) {
      setAside = setAsideWhole(file, now());
      changed = true;
    }
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
      changed = true;
    }
    if (!version1Items(paths).some((item) => existsSync(item))) {
      throw new Error(
        'Neither the bot root nor archive/v1 holds the version-1 files; nothing was restored',
      );
    }

    before('database');
    if (existsSync(file)) {
      // Fold the log into the database, so that the file set aside holds everything. The
      // last connection to close does that; another one still open keeps the log.
      openBotStateStore({ file, mode: 'writer' }).close();
      if (existsSync(`${file}-wal`)) {
        throw new Error(
          'Another program has bot.db open; close it and restore again. The files are back.',
        );
      }
      removeTree(`${file}-shm`);
      setAside = freeName(`${file}.set-aside-${stamp(now())}`);
      try {
        renameSync(file, setAside);
        changed = true;
      } catch (error) {
        throw new Error(
          `Another program has bot.db open (${errorCode(error)}); close it and restore again. The files are back.`,
          { cause: error },
        );
      }
    }
    before('profile');
    if (lowerProfile(paths, options.profile, now())) changed = true;
    const leftInArchive = existsSync(archive) ? readdirSync(archive).sort() : [];
    return { changed, setAside, leftInArchive };
  } finally {
    lock.release();
  }
}

/** The import's marker, or undefined when there is no finished database. */
function readMarker(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let store;
  try {
    store = openBotStateStore({ file, mode: 'reader' });
  } catch (error) {
    if (error instanceof StateDatabaseError && error.code === 'missing') return undefined;
    // A newer database, or a file that is not one, is never removed.
    throw error;
  }
  try {
    return store.importMarker();
  } finally {
    store.close();
  }
}

/** The copy of the files the finished import read, as its marker names it. */
function backupOf(paths: BotPaths, marker: string | undefined): string | null {
  try {
    const name = (JSON.parse(marker ?? 'null') as { backup?: unknown } | null)?.backup;
    return typeof name === 'string' ? join(migrationBackupDirectory(paths), name) : null;
  } catch {
    return null;
  }
}

/**
 * The profile as today's Bot reads it, at the version the raise starts from, and writable:
 * otherwise the import would finish and the raise after it fail at every start, while an
 * older Bot went on writing files the migration has stopped reading.
 */
function checkProfileBeforeImport(paths: BotPaths, raise: ProfileRaise, at: Date): void {
  const profile = parseRecord(readText(paths.profile));
  if (profile?.schemaVersion === raise.to) {
    const newest = newestSnapshot(paths, at);
    const asides = readdirSync(paths.root).filter(
      (name) =>
        name.startsWith('bot.db.set-aside-') && !name.endsWith('-wal') && !name.endsWith('-shm'),
    );
    throw new Error(
      `${paths.profile} says this bot was migrated, but bot.db holds no finished import; nothing ` +
        'was imported again. If a restore was stopped, run `cats-bot restore` again to finish it' +
        (asides.length > 0 ? ` (the database it set aside: ${asides.join(', ')})` : '') +
        '; otherwise put the database back' +
        (newest ? `, or copy the newest snapshot (${newest.file}) there as bot.db.` : '.'),
    );
  }
  if (profile === null || profile.schemaVersion !== raise.from) {
    throw new Error(
      `${paths.profile} cannot be read at schema version ${raise.from}; nothing was migrated`,
    );
  }
  const placeholder = createProfile({
    id: 'bot',
    name: 'bot',
    provider: 'claude',
    cwd: paths.root,
  });
  const loaded = loadProfile(paths, placeholder);
  if (!loaded.ok) {
    throw new Error(
      `${paths.profile} is not a profile today's Bot reads (${loaded.reason === 'corrupt' ? loaded.error : 'missing'}); nothing was migrated`,
    );
  }
  try {
    accessSync(paths.profile, constants.W_OK);
  } catch (error) {
    throw new Error(
      `${paths.profile} cannot be written (${errorCode(error)}); nothing was migrated`,
    );
  }
}

/** A database and its log and shared memory, by their names, whichever of them exist. */
function removeDatabase(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) removeTree(`${file}${suffix}`);
}

/** A copy is finished once its manifest is written; any other copy is removed. */
function removeIncompleteCopies(paths: BotPaths): void {
  const directory = migrationBackupDirectory(paths);
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const copy = join(directory, name);
    if (!existsSync(join(copy, MANIFEST))) removeTree(copy);
  }
}

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

/**
 * The version-1 files and the profile, copied to `migration-backup/<time>/` with a manifest
 * of every file's size and SHA-256 written last. When the newest finished copy holds the
 * same files, it is used again, so that an import that does not finish does not add a copy
 * at every start.
 */
function copyAside(paths: BotPaths, at: Date): string {
  const items = [...version1Items(paths), paths.profile].filter((item) => existsSync(item));
  const files = items
    .flatMap((item) => (statSync(item).isDirectory() ? listFiles(item) : [item]))
    .map((file) => describe(file, relative(paths.root, file)))
    .sort((a, b) => a.path.localeCompare(b.path));
  const newest = finishedCopies(paths).at(-1);
  if (newest && sameFiles(newest.files, files)) return newest.directory;

  const copy = freeName(join(migrationBackupDirectory(paths), stamp(at)));
  mkdirSync(copy, { recursive: true });
  for (const item of items) copyTree(item, join(copy, basename(item)));
  const copied = listFiles(copy)
    .map((file) => describe(file, relative(copy, file)))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!sameFiles(copied, files)) {
    throw new Error(`The copy in ${copy} does not match the version-1 files; nothing was imported`);
  }
  writeJsonAtomic(join(copy, MANIFEST), { version: 1, madeAt: at.toISOString(), files: copied });
  return copy;
}

function describe(file: string, path: string): ManifestFile {
  const bytes = readFileSync(file);
  return {
    path: path.split(sep).join('/'),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Finished copies, oldest first, with what their manifests list. */
function finishedCopies(paths: BotPaths): Array<{ directory: string; files: ManifestFile[] }> {
  const directory = migrationBackupDirectory(paths);
  if (!existsSync(directory)) return [];
  const found: Array<{ directory: string; files: ManifestFile[] }> = [];
  for (const name of readdirSync(directory).sort()) {
    const manifest = parseRecord(readText(join(directory, name, MANIFEST)));
    if (manifest && Array.isArray(manifest.files)) {
      found.push({ directory: join(directory, name), files: manifest.files as ManifestFile[] });
    }
  }
  return found;
}

function sameFiles(a: ManifestFile[], b: ManifestFile[]): boolean {
  const key = (files: ManifestFile[]): string =>
    JSON.stringify(files.map((file) => [file.path, file.size, file.sha256]));
  return key(a) === key(b);
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

  const lines = report?.finished
    ? [
        '# The bot data migration finished',
        '',
        `Written ${at.toISOString()}. The bot runs on its database. What is listed below was not`,
        'imported as the files held it; this folder holds a copy of the version-1 files, and',
        '`report.json` holds this report in full.',
        '',
      ]
    : [
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
        const more = (found.count ?? 0) - (found.lines?.length ?? 0);
        const where = found.lines
          ? ` line ${found.lines.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
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
  writeFileAtomic(markdown, lines.join('\n'));
  return { report: json, summary: markdown };
}

/**
 * The profile's schema version raised, after a copy of the profile as it was. A profile a
 * power cut left unreadable during the raise is raised from the copy this migration made
 * before it imported, which its marker names, and from no other.
 */
function raiseProfile(paths: BotPaths, raise: ProfileRaise, backup: string | null, at: Date): void {
  let text = readText(paths.profile);
  let profile = parseRecord(text);
  if (profile === null) {
    const copy = backup === null ? null : parseRecord(readText(join(backup, 'profile.json')));
    if (copy === null || copy.schemaVersion !== raise.from) {
      throw new Error(
        `${paths.profile} cannot be read, and the copy the migration made of it cannot either`,
      );
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
  if (text !== null) keepCopy(paths.profile, text, `${paths.profile}.v${raise.from}.bak`, at);
  writeJsonAtomic(paths.profile, { ...profile, schemaVersion: raise.to });
}

/** Whether the profile was lowered; false when it is at the version before already. */
function lowerProfile(paths: BotPaths, raise: ProfileRaise, at: Date): boolean {
  const text = readText(paths.profile);
  const profile = parseRecord(text);
  if (profile === null) throw new Error(`${paths.profile} cannot be read; it was not lowered`);
  if (profile.schemaVersion === raise.from) return false;
  if (profile.schemaVersion !== raise.to) {
    throw new Error(
      `${paths.profile} has schema version ${String(profile.schemaVersion)}; restoring lowers ${raise.to} to ${raise.from}`,
    );
  }
  keepCopy(paths.profile, text!, `${paths.profile}.v${raise.to}.bak`, at);
  writeJsonAtomic(paths.profile, { ...profile, schemaVersion: raise.from });
  return true;
}

/** Whether this version opens the file as its own state database. */
function isOwnDatabase(file: string): boolean {
  try {
    openBotStateStore({ file, mode: 'reader' }).close();
    return true;
  } catch (error) {
    if (error instanceof StateDatabaseError && error.code !== 'missing') return false;
    throw error;
  }
}

/** A database, its log and its shared memory renamed together, under names SQLite pairs. */
function setAsideWhole(file: string, at: Date): string {
  const name = freeName(`${file}.set-aside-${stamp(at)}`);
  renameSync(file, name);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${name}${suffix}`);
  }
  return name;
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

function stamp(at: Date): string {
  return at.toISOString().replace(/[:.]/gu, '-');
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
