import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, test } from 'node:test';
import { createProfile, loadProfile } from '../../src/core/profile/profile.ts';
import type { BotProfile } from '../../src/core/types.ts';
import { writeJsonAtomic } from '../../src/core/store/atomicFile.ts';
import { appendJournal } from '../../src/core/store/journal.ts';
import { acquireInstanceLock } from '../../src/core/store/lock.ts';
import {
  botPathsFor,
  conversationFile,
  stateDatabaseFile,
  transcriptFile,
  type BotPaths,
} from '../../src/core/store/paths.ts';
import { savePresentation } from '../../src/core/store/presentation.ts';
import { removeTree } from '../../src/core/store/removeTree.ts';
import { sqliteDriver } from '../../src/core/store/sqliteDriver.ts';
import { openBotStateStore } from '../../src/core/store/stateStore.ts';
import { appendTranscript, readTranscript } from '../../src/core/store/transcript.ts';
import {
  migrateVersion1,
  migrationBackupDirectory,
  restoreVersion1,
  version1ArchiveDirectory,
  version1Items,
  type MigrateVersion1Options,
  type MigrationResult,
  type MigrationStep,
} from '../../src/core/store/version1Migration.ts';
import type {
  ConversationRecord,
  JournalEntry,
  TranscriptEntry,
  WorkItem,
} from '../../src/core/types.ts';

const scratch = mkdtempSync(join(tmpdir(), 'cats bot 遷移 '));
// Not `rmSync`, which in Electron 41 ends the process on a read-only file under some paths.
after(() => removeTree(scratch));
let made = 0;

const AT = '2026-11-11T08:00:00.000Z';
const RAISE = { from: 2, to: 3 };
let clock = Date.parse(AT);
/** A later time at each call, as runs at different times have. */
const now = (): Date => new Date((clock += 1000));

function conversation(id: string): ConversationRecord {
  return {
    schemaVersion: 1,
    id,
    role: id === 'home' ? 'home' : 'note',
    title: id,
    createdAt: AT,
    updatedAt: AT,
    attachment: {
      state: 'none',
      sessionId: null,
      providerSessionId: null,
      provider: null,
      model: null,
      configRevision: null,
      updatedAt: AT,
    },
    unreadCount: 0,
    lastOwnerMessageAt: null,
    lastBotMessageAt: null,
    checkpoint: null,
    contactOf: null,
    contactName: null,
  };
}

function entry(seq: number, text: string): TranscriptEntry {
  return { seq, at: AT, kind: 'owner', origin: 'owner', text };
}

function workItem(id: string, state: WorkItem['state']): WorkItem {
  return {
    id,
    kind: 'owner_message',
    source: 'note',
    conversationId: 'home',
    prompt: `prompt of ${id}`,
    createdAt: AT,
    admittedAt: null,
    configRevision: 1,
    state,
    attempts: 0,
    updatedAt: AT,
  };
}

/** A bot as today's core leaves it, profile included. */
function versionOneBot(name = 'bot'): BotPaths {
  made += 1;
  const paths = botPathsFor(join(scratch, `${name}-${made}`));
  mkdirSync(paths.root, { recursive: true });
  olderBotSaves(
    paths,
    createProfile({
      id: 'mochi',
      name: 'Mochi',
      provider: 'claude',
      cwd: paths.root,
      now: new Date(AT),
    }),
  );
  writeJsonAtomic(conversationFile(paths, 'home'), conversation('home'));
  writeJsonAtomic(conversationFile(paths, 'note-a'), conversation('note-a'));
  appendTranscript(paths, 'home', entry(1, 'hello'));
  appendTranscript(paths, 'home', entry(2, '去公園'));
  appendTranscript(paths, 'note-a', entry(1, 'a note'));
  savePresentation(paths, 'home', {
    ...entry(2, 'reply'),
    kind: 'bot',
    workItemId: 'w1',
    presentationRevision: 1,
    presentationSeqs: [2],
    presentationTerminalSeq: 2,
    presentation: { version: 1, id: 'p1', phase: 'sealed', blocks: [] },
  } as TranscriptEntry);
  appendJournal(paths, { type: 'work', at: AT, item: workItem('w1', 'completed') });
  return paths;
}

function locked<T>(paths: BotPaths, work: () => T): T {
  const lock = acquireInstanceLock(paths);
  assert.equal(lock.held, true);
  try {
    return work();
  } finally {
    lock.release();
  }
}

function migrate(paths: BotPaths, extra: Partial<MigrateVersion1Options> = {}): MigrationResult {
  return locked(paths, () => migrateVersion1({ paths, profile: RAISE, now, ...extra }));
}

/** Every file under a directory with its SHA-256, by its path relative to it. */
function contents(directory: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else
        found[relative(directory, full).split(sep).join('/')] = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex');
    }
  };
  if (existsSync(directory)) walk(directory);
  return found;
}

/** The version-1 files of a root, as `contents` lists them. */
function versionOneFiles(paths: BotPaths): Record<string, string> {
  const found: Record<string, string> = {};
  for (const item of version1Items(paths)) {
    if (!existsSync(item)) continue;
    const name = relative(paths.root, item);
    if (statSync(item).isFile()) found[name] = contents(paths.root)[name]!;
    else for (const [file, hash] of Object.entries(contents(item))) found[`${name}/${file}`] = hash;
  }
  return found;
}

function profileOf(paths: BotPaths): Record<string, unknown> {
  return JSON.parse(readFileSync(paths.profile, 'utf8')) as Record<string, unknown>;
}

/** A profile as a Bot of 0.5 writes it: schema version 2. */
function olderBotSaves(paths: BotPaths, profile: BotProfile): void {
  writeJsonAtomic(paths.profile, { ...profile, schemaVersion: 2 });
}

/**
 * The rule a Bot of 0.5 reads a profile by (its `loadProfile`, as of 0.5.9): schema 1, or 2
 * with a provider policy. Pinned here, since this version's own rule now takes 3 as well.
 */
function olderBotReads(paths: BotPaths): boolean {
  const raw = JSON.parse(readFileSync(paths.profile, 'utf8')) as Record<string, unknown>;
  return (
    [1, 2].includes(raw.schemaVersion as number) &&
    !(raw.schemaVersion === 2 && !Object.hasOwn(raw, 'providerPolicy'))
  );
}

function placeholder(paths: BotPaths) {
  return createProfile({ id: 'mochi', name: 'Mochi', provider: 'claude', cwd: paths.root });
}

/** What a finished migration leaves, whichever way it got there. */
function assertMigrated(
  paths: BotPaths,
  before: Record<string, string>,
  original: Record<string, unknown>,
): void {
  const archive = version1ArchiveDirectory(paths);
  for (const item of version1Items(paths)) assert.equal(existsSync(item), false, item);
  assert.deepEqual(versionOneFiles(botPathsFor(archive)), before);
  assert.deepEqual(profileOf(paths), { ...original, schemaVersion: 3 });
  const store = openBotStateStore({ file: stateDatabaseFile(paths), mode: 'reader' });
  try {
    assert.notEqual(store.importMarker(), undefined);
    const archived = botPathsFor(archive);
    for (const id of ['home', 'note-a']) {
      assert.equal(
        JSON.stringify(store.entries(id)),
        JSON.stringify(readTranscript(archived, id)),
        id,
      );
    }
    assert.equal(store.responses('home').length, 1);
    assert.equal(store.workItems().length, 1);
  } finally {
    store.close();
  }
}

test('a version-1 root is copied aside, imported, its profile raised and its files archived', () => {
  const paths = versionOneBot();
  const before = versionOneFiles(paths);
  const original = profileOf(paths);
  const profileBytes = readFileSync(paths.profile);

  const result = migrate(paths);
  assert.equal(result.outcome, 'migrated');
  assert.ok(result.outcome === 'migrated' && result.imported?.finished);
  assert.deepEqual(result.outcome === 'migrated' && result.notArchived, []);
  assertMigrated(paths, before, original);

  // The copy: every version-1 file and the profile, listed with its size and hash.
  const copy = result.backup!;
  assert.equal(relative(migrationBackupDirectory(paths), copy).includes(sep), false);
  const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8')) as {
    files: Array<{ path: string; size: number; sha256: string }>;
  };
  const copied = contents(copy);
  delete copied['manifest.json'];
  assert.deepEqual(
    Object.fromEntries(manifest.files.map((file) => [file.path, file.sha256])),
    copied,
  );
  assert.deepEqual(copied, {
    ...before,
    'profile.json': contents(paths.root)['profile.json.v2.bak']!,
  });
  assert.equal(existsSync(join(copy, 'copy-in-progress')), false);

  // The profile as it was is kept, and today's Bot refuses the raised one.
  assert.deepEqual(readFileSync(`${paths.profile}.v2.bak`), profileBytes);
  assert.equal(olderBotReads(paths), false);
  const read = loadProfile(paths, placeholder(paths), true);
  assert.ok(
    read.ok && read.profile.schemaVersion === 3,
  );

  // A second run finds nothing to do.
  const again = migrate(paths);
  assert.deepEqual(again, { outcome: 'migrated', imported: null, backup: null, notArchived: [] });
  assertMigrated(paths, before, original);
});

test('it runs only in the process that holds the lock', () => {
  const paths = versionOneBot();
  assert.throws(() => migrateVersion1({ paths, profile: RAISE }), /holds the bot's lock/u);
  assert.equal(existsSync(stateDatabaseFile(paths)), false);
});

test('an import that does not finish leaves the version-1 files as they were, with a report beside their copy', () => {
  const paths = versionOneBot();
  appendTranscript(paths, 'home', entry(1, 'out of order'));
  const before = versionOneFiles(paths);
  const profile = readFileSync(paths.profile);

  const result = migrate(paths);
  assert.equal(result.outcome, 'not_migrated');
  if (result.outcome !== 'not_migrated') return;
  for (const suffix of ['', '-wal', '-shm']) {
    assert.equal(existsSync(`${stateDatabaseFile(paths)}${suffix}`), false, suffix);
  }
  assert.deepEqual(versionOneFiles(paths), before);
  assert.deepEqual(readFileSync(paths.profile), profile);
  assert.equal(existsSync(version1ArchiveDirectory(paths)), false);

  const report = JSON.parse(readFileSync(result.report, 'utf8')) as {
    error: string | null;
    import: { finished: boolean; problems: Array<{ kind: string; file: string; lines: number[] }> };
  };
  assert.equal(report.error, null);
  assert.equal(report.import.finished, false);
  assert.deepEqual(
    report.import.problems.map((found) => `${found.kind} ${found.file} ${found.lines.join(',')}`),
    ['seq_out_of_order transcripts/home.jsonl 3'],
  );
  const summary = readFileSync(result.summary, 'utf8');
  assert.match(
    summary,
    /## What stopped it\n\n- seq_out_of_order: transcripts\/home\.jsonl line 3/u,
  );
  assert.equal(relative(result.backup, result.report), 'report.json');

  // A failure on the way is reported the same way, with its message.
  const failing = versionOneBot();
  const second = migrate(failing, {
    open: (options) => {
      const store = openBotStateStore(options);
      return new Proxy(store, {
        get: (target, name) =>
          name === 'importEntries'
            ? () => {
                throw new Error('the disk is full');
              }
            : ((Reflect.get(target, name) as (...args: unknown[]) => unknown).bind?.(target) ??
              Reflect.get(target, name)),
      });
    },
  });
  assert.equal(second.outcome, 'not_migrated');
  if (second.outcome !== 'not_migrated') return;
  assert.equal(
    (JSON.parse(readFileSync(second.report, 'utf8')) as { error: string }).error,
    'the disk is full',
  );
  assert.match(readFileSync(second.summary, 'utf8'), /## Error\n\nthe disk is full/u);
  assert.equal(existsSync(stateDatabaseFile(failing)), false);
});

test('a migration stopped before any step is finished by the next run', () => {
  const stops: Array<[MigrationStep, string?]> = [
    ['discard'],
    ['backup'],
    ['import'],
    ['profile'],
    ['archive', 'conversations'],
    ['archive', 'transcripts'],
    ['archive', 'presentations'],
    ['archive', 'journal.jsonl'],
  ];
  for (const [step, item] of stops) {
    const paths = versionOneBot();
    const before = versionOneFiles(paths);
    const original = profileOf(paths);
    assert.throws(
      () =>
        migrate(paths, {
          beforeStep: (at, about) => {
            if (at === step && about === item) throw new Error(`stopped before ${step}`);
          },
        }),
      /stopped before/u,
      `${step} ${item ?? ''}`,
    );
    const result = migrate(paths);
    assert.equal(result.outcome, 'migrated', `${step} ${item ?? ''}`);
    assertMigrated(paths, before, original);
    // A copy an earlier run could not finish is not left behind.
    for (const name of readdirSync(migrationBackupDirectory(paths))) {
      assert.ok(
        existsSync(join(migrationBackupDirectory(paths), name, 'manifest.json')),
        `${step}: ${name}`,
      );
    }
  }

  // A failure inside the import, at its marker: reported, and the next run starts again.
  const paths = versionOneBot();
  const before = versionOneFiles(paths);
  const original = profileOf(paths);
  const failed = migrate(paths, {
    open: (options) => {
      const store = openBotStateStore(options);
      return new Proxy(store, {
        get: (target, name) =>
          name === 'setImportMarker'
            ? () => {
                throw new Error('the disk is full');
              }
            : ((Reflect.get(target, name) as (...args: unknown[]) => unknown).bind?.(target) ??
              Reflect.get(target, name)),
      });
    },
  });
  assert.equal(failed.outcome, 'not_migrated');
  assert.equal(existsSync(stateDatabaseFile(paths)), false);
  assert.equal(migrate(paths).outcome, 'migrated');
  assertMigrated(paths, before, original);
});

test('a database without a marker is removed, a newer one never', () => {
  // Left by an import that did not finish, with a record in it.
  const unfinished = versionOneBot();
  const before = versionOneFiles(unfinished);
  const original = profileOf(unfinished);
  const store = openBotStateStore({ file: stateDatabaseFile(unfinished), mode: 'writer' });
  store.appendJournal({ type: 'presence', at: AT } as unknown as JournalEntry);
  store.close();
  assert.equal(migrate(unfinished).outcome, 'migrated');
  assertMigrated(unfinished, before, original);

  // A log and shared memory left without their database.
  const stale = versionOneBot();
  writeFileSync(`${stateDatabaseFile(stale)}-wal`, 'not a log');
  writeFileSync(`${stateDatabaseFile(stale)}-shm`, '');
  assert.equal(migrate(stale).outcome, 'migrated');
  assert.equal(
    existsSync(`${stateDatabaseFile(stale)}-wal`) &&
      readFileSync(`${stateDatabaseFile(stale)}-wal`, 'utf8') === 'not a log',
    false,
  );

  // A database of a newer version, or a file that is not one, stops it and stays.
  for (const make of [
    (file: string) => {
      const newer = openBotStateStore({ file, mode: 'writer' });
      newer.close();
      const { DatabaseSync } = sqliteDriver();
      const database = new DatabaseSync(file);
      database.exec(`update meta set value = '99' where key = 'schema_version'`);
      database.close();
    },
    (file: string) => writeFileSync(file, 'not a database, but somebody may want it'),
  ]) {
    const paths = versionOneBot();
    make(stateDatabaseFile(paths));
    const kept = readFileSync(stateDatabaseFile(paths));
    assert.throws(
      () => migrate(paths),
      /written by a newer Cats Bot|is not a Cats Bot state database/u,
    );
    assert.deepEqual(readFileSync(stateDatabaseFile(paths)), kept);
    assert.equal(existsSync(migrationBackupDirectory(paths)), false);
  }
});

const stopBeforeProfile = {
  beforeStep: (step: MigrationStep): void => {
    if (step === 'profile') throw new Error('stop');
  },
};

test("a profile a power cut left unreadable during the raise is raised from this migration's copy", () => {
  const paths = versionOneBot();
  const before = versionOneFiles(paths);
  const original = profileOf(paths);
  // The import finished; the run stopped before the raise, and the profile was lost.
  assert.throws(() => migrate(paths, stopBeforeProfile), /stop/u);
  writeFileSync(paths.profile, '');
  assert.equal(migrate(paths).outcome, 'migrated');
  assertMigrated(paths, before, original);

  // After a restore and a change, a second migration raises from its own copy, not from
  // the copy the first one kept: the narrower permission stays narrow.
  const again = versionOneBot();
  const profile = loadProfile(again, placeholder(again));
  assert.ok(profile.ok);
  olderBotSaves(again, {
    ...profile.profile,
    permissions: { ...profile.profile.permissions, permissionMode: 'skip' },
  });
  migrate(again);
  restoreVersion1({ paths: again, profile: RAISE, now });
  const lowered = loadProfile(again, placeholder(again));
  assert.ok(lowered.ok);
  olderBotSaves(again, {
    ...lowered.profile,
    name: 'Mochi Two',
    permissions: { ...lowered.profile.permissions, permissionMode: 'default' },
  });
  const changed = profileOf(again);
  assert.throws(() => migrate(again, stopBeforeProfile), /stop/u);
  writeFileSync(again.profile, '');
  assert.equal(migrate(again).outcome, 'migrated');
  assert.deepEqual(profileOf(again), { ...changed, schemaVersion: 3 });

  // Without that copy there is nothing to raise from, and the start stops.
  const lost = versionOneBot();
  assert.throws(() => migrate(lost, stopBeforeProfile), /stop/u);
  const [copy] = readdirSync(migrationBackupDirectory(lost));
  rmSync(join(migrationBackupDirectory(lost), copy!, 'profile.json'));
  writeFileSync(lost.profile, '');
  assert.throws(
    () => migrate(lost),
    /cannot be read, and the copy the migration made of it cannot either/u,
  );
  // A profile of a version the raise does not start from stops it too.
  writeJsonAtomic(lost.profile, { ...original, schemaVersion: 1 });
  assert.throws(() => migrate(lost), /schema version 1; the migration raises 2 to 3/u);
});

test('the profile is checked before anything is imported', () => {
  // Read-only: the raise after the import would fail at every start.
  const readOnly = versionOneBot();
  chmodSync(readOnly.profile, 0o444);
  try {
    assert.throws(() => migrate(readOnly), /cannot be written/u);
  } finally {
    chmodSync(readOnly.profile, 0o666);
  }
  // One today's Bot refuses.
  const refused = versionOneBot();
  writeJsonAtomic(refused.profile, { ...profileOf(refused), permissions: { cwd: 1 } });
  assert.throws(() => migrate(refused), /is not a profile today's Bot reads/u);
  // Of a version the raise does not start from.
  const older = versionOneBot();
  writeJsonAtomic(older.profile, { ...profileOf(older), schemaVersion: 1 });
  assert.throws(() => migrate(older), /cannot be read at schema version 2/u);
  for (const paths of [readOnly, refused, older]) {
    assert.equal(existsSync(stateDatabaseFile(paths)), false);
    assert.equal(existsSync(migrationBackupDirectory(paths)), false);
  }

  // Raised, with no finished database: the bot was migrated and its database is gone.
  const migrated = versionOneBot();
  migrate(migrated);
  rmSync(stateDatabaseFile(migrated));
  assert.throws(
    () => migrate(migrated),
    /says this bot was migrated, but bot\.db holds no finished import/u,
  );
  assert.equal(existsSync(stateDatabaseFile(migrated)), false);
});

test('an import that does not finish again uses the copy it made before', () => {
  const paths = versionOneBot();
  appendTranscript(paths, 'home', entry(1, 'out of order'));
  const first = migrate(paths);
  const second = migrate(paths);
  assert.ok(first.outcome === 'not_migrated' && second.outcome === 'not_migrated');
  assert.equal(first.backup, second.backup);
  assert.equal(readdirSync(migrationBackupDirectory(paths)).length, 1);
  // A change to the files makes a new copy.
  appendJournal(paths, { type: 'work', at: AT, item: workItem('w2', 'queued') });
  const third = migrate(paths);
  assert.ok(third.outcome === 'not_migrated' && third.backup !== first.backup);
  assert.equal(readdirSync(migrationBackupDirectory(paths)).length, 2);
});

test('what is made again after the archive is kept beside it, or removed when empty', () => {
  const paths = versionOneBot();
  migrate(paths);
  // Today's code makes the directories again when it finds none.
  mkdirSync(paths.conversations);
  mkdirSync(paths.transcripts);
  appendFileSync(join(paths.transcripts, 'note-b.jsonl'), `${JSON.stringify(entry(1, 'late'))}\n`);
  const result = migrate(paths);
  assert.deepEqual(result.outcome === 'migrated' && result.notArchived, []);
  assert.equal(existsSync(paths.conversations), false);
  assert.equal(existsSync(paths.transcripts), false);
  // The empty one was removed, not archived.
  assert.deepEqual(
    readdirSync(version1ArchiveDirectory(paths)).filter((name) =>
      name.startsWith('conversations.'),
    ),
    [],
  );
  const kept = readdirSync(version1ArchiveDirectory(paths)).filter((name) =>
    name.startsWith('transcripts.'),
  );
  assert.equal(kept.length, 1);
  assert.deepEqual(readdirSync(join(version1ArchiveDirectory(paths), kept[0]!)), ['note-b.jsonl']);
});

test('an item that cannot be archived is reported, and archived at the next start', () => {
  const paths = versionOneBot();
  const before = versionOneFiles(paths);
  const original = profileOf(paths);
  // A file where the archive's directory goes.
  mkdirSync(join(paths.root, 'archive'));
  writeFileSync(version1ArchiveDirectory(paths), '');
  const result = migrate(paths);
  assert.equal(result.outcome, 'migrated');
  assert.deepEqual(
    result.outcome === 'migrated' && result.notArchived.map((line) => line.split(':')[0]),
    ['conversations', 'transcripts', 'presentations', 'journal.jsonl'],
  );
  rmSync(version1ArchiveDirectory(paths));
  assert.deepEqual(migrate(paths), {
    outcome: 'migrated',
    imported: null,
    backup: null,
    notArchived: [],
  });
  assertMigrated(paths, before, original);
});

test('restoring puts the files back, sets the database aside and lowers the profile, and migrating again sees what was written since', () => {
  const paths = versionOneBot();
  const before = versionOneFiles(paths);
  const original = profileOf(paths);
  migrate(paths);

  const { setAside } = restoreVersion1({ paths, profile: RAISE, now });
  assert.deepEqual(versionOneFiles(paths), before);
  assert.deepEqual(readdirSync(version1ArchiveDirectory(paths)), []);
  assert.equal(existsSync(stateDatabaseFile(paths)), false);
  assert.ok(setAside && existsSync(setAside));
  assert.deepEqual(profileOf(paths), original);
  // An older Bot reads the root again.
  assert.equal(olderBotReads(paths), true);
  const loaded = loadProfile(paths, placeholder(paths));
  assert.equal(loaded.ok, true);
  // The set-aside database still holds what the migration made.
  const kept = openBotStateStore({ file: setAside!, mode: 'reader' });
  assert.notEqual(kept.importMarker(), undefined);
  kept.close();
  // Restoring again finds nothing more to do.
  assert.deepEqual(restoreVersion1({ paths, profile: RAISE, now }), {
    setAside: null,
    leftInArchive: [],
  });
  // The raised profile is kept beside the lowered one.
  assert.equal(JSON.parse(readFileSync(`${paths.profile}.v3.bak`, 'utf8')).schemaVersion, 3);

  // Today's Bot writes on; then the new version migrates again.
  appendTranscript(paths, 'home', entry(3, 'written by the older Bot'));
  olderBotSaves(paths, { ...(loaded.ok ? loaded.profile : placeholder(paths)), name: 'Mochi Two' });
  const changed = profileOf(paths);
  assert.equal(migrate(paths).outcome, 'migrated');
  assert.deepEqual(profileOf(paths), { ...changed, schemaVersion: 3 });
  const store = openBotStateStore({ file: stateDatabaseFile(paths), mode: 'reader' });
  try {
    assert.deepEqual(
      store.entries('home').map((item) => item.text),
      ['hello', '去公園', 'written by the older Bot'],
    );
  } finally {
    store.close();
  }
  // The first copy of the profile stays; the changed one is kept beside it.
  const copies = readdirSync(paths.root)
    .filter((name) => /^profile\.json\.v2\./u.test(name))
    .sort();
  assert.equal(copies.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(`${paths.profile}.v2.bak`, 'utf8')), original);
});

test('restoring refuses while the bot runs, and when an item is in both places', () => {
  const paths = versionOneBot();
  migrate(paths);
  locked(paths, () => {
    assert.throws(() => restoreVersion1({ paths, profile: RAISE }), /The bot is running/u);
  });

  mkdirSync(paths.transcripts);
  writeFileSync(join(paths.transcripts, 'home.jsonl'), 'made since\n');
  assert.throws(
    () => restoreVersion1({ paths, profile: RAISE }),
    /transcripts is both in the bot root and in archive\/v1/u,
  );
  // Nothing after the refusal was done: the database is still the bot's.
  assert.equal(existsSync(stateDatabaseFile(paths)), true);
  assert.equal(profileOf(paths).schemaVersion, 3);
});

test('a restore stopped before any step leaves a root the new version starts on, or one a second restore finishes', () => {
  for (const step of ['files', 'database', 'profile'] as const) {
    const paths = versionOneBot();
    const before = versionOneFiles(paths);
    const original = profileOf(paths);
    migrate(paths);
    assert.throws(
      () =>
        restoreVersion1({
          paths,
          profile: RAISE,
          now,
          beforeStep: (at) => {
            if (at === step) throw new Error(`stopped before ${step}`);
          },
        }),
      /stopped before/u,
    );
    if (step === 'profile') {
      // The files are back and the database aside, and the profile still says migrated:
      // the new version refuses to import again, and a second restore finishes.
      assert.deepEqual(versionOneFiles(paths), before);
      assert.equal(existsSync(stateDatabaseFile(paths)), false);
      assert.deepEqual(restoreVersion1({ paths, profile: RAISE, now }), {
        setAside: null,
        leftInArchive: [],
      });
      assert.deepEqual(profileOf(paths), original);
    } else {
      // The database is still the bot's: the new version archives the files again.
      assert.equal(migrate(paths).outcome, 'migrated');
      assertMigrated(paths, before, original);
    }
  }
});

test('a copy an earlier run could not finish is removed, a finished one kept', () => {
  const paths = versionOneBot();
  const unfinished = join(migrationBackupDirectory(paths), 'unfinished');
  const finished = join(migrationBackupDirectory(paths), 'finished');
  mkdirSync(unfinished, { recursive: true });
  writeFileSync(join(unfinished, 'copy-in-progress'), '');
  writeFileSync(join(unfinished, 'journal.jsonl'), 'half');
  mkdirSync(finished, { recursive: true });
  writeFileSync(join(finished, 'manifest.json'), '{}');
  assert.equal(migrate(paths).outcome, 'migrated');
  assert.equal(existsSync(unfinished), false);
  assert.equal(existsSync(finished), true);
});

test('a restore folds the log of a core that was killed into the database it sets aside', () => {
  const paths = versionOneBot();
  migrate(paths);
  const file = stateDatabaseFile(paths);
  // A core killed with writes in its log: copy the three files while it still holds them.
  const core = openBotStateStore({ file, mode: 'writer' });
  core.appendJournal({
    type: 'presence',
    at: AT,
    note: 'only in the log',
  } as unknown as JournalEntry);
  const held = new Map<string, Buffer>();
  for (const suffix of ['', '-wal', '-shm']) held.set(suffix, readFileSync(`${file}${suffix}`));
  core.close();
  for (const [suffix, bytes] of held) writeFileSync(`${file}${suffix}`, bytes);
  assert.ok(held.get('-wal')!.length > 0);

  const { setAside } = restoreVersion1({ paths, profile: RAISE, now });
  for (const suffix of ['-wal', '-shm']) {
    assert.equal(existsSync(`${file}${suffix}`), false, suffix);
    assert.equal(existsSync(`${setAside!}${suffix}`), false, suffix);
  }
  const kept = openBotStateStore({ file: setAside!, mode: 'reader' });
  try {
    assert.equal(kept.journal().at(-1)?.type, 'presence');
  } finally {
    kept.close();
  }
});

test('a restore stops while another program has the database open, and finishes once it is closed', () => {
  const paths = versionOneBot();
  migrate(paths);
  const other = new (sqliteDriver().DatabaseSync)(stateDatabaseFile(paths));
  // Reading opens the log, as a program that reads the database holds it.
  other.prepare('select count(*) as n from meta').get();
  try {
    assert.throws(
      () => restoreVersion1({ paths, profile: RAISE, now }),
      /Another program has bot\.db open/u,
    );
    assert.equal(existsSync(stateDatabaseFile(paths)), true);
    assert.equal(profileOf(paths).schemaVersion, 3);
  } finally {
    other.close();
  }
  const { setAside } = restoreVersion1({ paths, profile: RAISE, now });
  assert.ok(setAside);
  assert.equal(profileOf(paths).schemaVersion, 2);
});

test('a restore with nothing to put back changes nothing, and names what it leaves in the archive', () => {
  const paths = versionOneBot();
  migrate(paths);
  rmSync(version1ArchiveDirectory(paths), { recursive: true });
  assert.throws(
    () => restoreVersion1({ paths, profile: RAISE, now }),
    /Neither the bot root nor archive\/v1/u,
  );
  assert.equal(existsSync(stateDatabaseFile(paths)), true);
  assert.equal(profileOf(paths).schemaVersion, 3);

  // What was kept beside an archived item is named; an empty directory made again in the
  // root gives way to the item put back.
  const kept = versionOneBot();
  migrate(kept);
  mkdirSync(kept.transcripts);
  writeFileSync(join(kept.transcripts, 'note-b.jsonl'), `${JSON.stringify(entry(1, 'late'))}\n`);
  migrate(kept);
  mkdirSync(kept.conversations);
  const result = restoreVersion1({ paths: kept, profile: RAISE, now });
  assert.equal(result.leftInArchive.length, 1);
  assert.match(result.leftInArchive[0]!, /^transcripts\./u);
  assert.equal(readTranscript(kept, 'home').length, 2);
});

test('the profile is raised before any file is archived', () => {
  const paths = versionOneBot();
  assert.throws(
    () =>
      migrate(paths, {
        beforeStep: (step) => {
          if (step === 'archive') {
            assert.equal(profileOf(paths).schemaVersion, 3);
            throw new Error('stop');
          }
        },
      }),
    /stop/u,
  );
});

test('an unfinished copy holding a read-only file is removed, under a path in any script', () => {
  // Korean, an emoji and simplified Chinese: outside the code page a Traditional Chinese
  // Windows uses for its older calls, which is where Electron's own removal fails.
  const paths = versionOneBot('이동 🐱 迁移');
  const unfinished = join(migrationBackupDirectory(paths), 'unfinished');
  mkdirSync(join(unfinished, 'transcripts'), { recursive: true });
  writeFileSync(join(unfinished, 'transcripts', 'home.jsonl'), 'half');
  chmodSync(join(unfinished, 'transcripts', 'home.jsonl'), 0o444);
  // A read-only file in the version-1 files is copied read-only.
  chmodSync(transcriptFile(paths, 'note-a'), 0o444);
  const before = versionOneFiles(paths);
  const original = profileOf(paths);
  assert.equal(migrate(paths).outcome, 'migrated');
  assert.equal(existsSync(unfinished), false);
  assertMigrated(paths, before, original);
});
