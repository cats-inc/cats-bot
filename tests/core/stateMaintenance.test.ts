import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BotCore } from '../../src/core/bot.ts';
import { botPathsFor, stateDatabaseFile, type BotPaths } from '../../src/core/store/paths.ts';
import { sqliteDriver } from '../../src/core/store/sqliteDriver.ts';
import { checkDatabaseFile, snapshotDatabaseFile } from '../../src/core/store/stateDatabase.ts';
import {
  backupsDirectory,
  checkStateDatabase,
  isDamagedDatabaseError,
  newestSnapshot,
  SNAPSHOTS_KEPT,
  snapshotDue,
  snapshots,
  takeSnapshot,
  writeCheckReport,
} from '../../src/core/store/stateMaintenance.ts';
import { openBotStateStore } from '../../src/core/store/stateStore.ts';
import type { ConversationRecord } from '../../src/core/types.ts';
import { makeTempHome, openTestBot, sendAndWait, type TempHome } from '../support/harness.ts';

/**
 * SPEC-014 FR-13 (PLAN-014 task 1.6): the check of the state database at start, the daily
 * snapshot, and a damaged database stopping the core with a report that names the newest
 * snapshot, which then starts the bot again. This file also runs inside Electron.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-maintenance-');
});
after(() => home.cleanup());

const AT = '2026-11-12T08:00:00.000Z';

/** A bot root holding a database with a conversation of `entries` entries, closed. */
function filledRoot(name: string, entries = 50): BotPaths {
  const root = join(home.root, name);
  mkdirSync(root, { recursive: true });
  const paths = botPathsFor(root);
  const store = openBotStateStore({ file: stateDatabaseFile(paths), mode: 'writer' });
  try {
    store.saveConversation({
      id: 'home',
      role: 'home',
      title: 'Direct message',
    } as unknown as ConversationRecord);
    store.transaction(() => {
      for (let index = 0; index < entries; index += 1) {
        store.appendEntry('home', {
          at: AT,
          kind: 'owner',
          origin: 'owner',
          text: `line ${index} 去公園散步`,
        } as never);
      }
    });
  } finally {
    store.close();
  }
  return paths;
}

/**
 * Breaks the root page of an index nothing reads at start, as a bad sector would: SQLite
 * opens the file, and `quick_check` finds the page.
 */
function damage(file: string): void {
  const { DatabaseSync } = sqliteDriver();
  const database = new DatabaseSync(file);
  const page = Number(
    database
      .prepare(`select rootpage from sqlite_master where name = 'deleted_work_by_delivery'`)
      .get()?.rootpage,
  );
  const size = Number(database.prepare('pragma page_size').get()?.page_size);
  database.close();
  assert.ok(page > 1 && size > 0);
  const handle = openSync(file, 'r+');
  try {
    // The page's type byte: no kind of page SQLite knows.
    writeSync(handle, Buffer.from([0x07, 0xff, 0xff, 0xff]), 0, 4, (page - 1) * size);
  } finally {
    closeSync(handle);
  }
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waited ${ms} ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('the check finds nothing in a sound database, and the damage in a broken one', async () => {
  const paths = filledRoot('check');
  assert.deepEqual(checkDatabaseFile(stateDatabaseFile(paths)), []);
  assert.deepEqual(await checkStateDatabase(paths).result, []);
  damage(stateDatabaseFile(paths));
  const problems = await checkStateDatabase(paths).result;
  assert.ok(problems.length > 0, 'a problem is found');
  assert.match(problems.join('\n'), /page/u);
  // Not a database at all.
  writeFileSync(
    stateDatabaseFile(paths),
    'not a database, and long enough to be read as a header'.repeat(100),
  );
  assert.equal((await checkStateDatabase(paths).result).length, 1);
  // None there: the check does not make one.
  rmSync(stateDatabaseFile(paths));
  await assert.rejects(checkStateDatabase(paths).result, /holds no bot state yet/u);
  assert.equal(existsSync(stateDatabaseFile(paths)), false);
});

test('a snapshot is a whole copy, made beside the writer that keeps working', async () => {
  const paths = filledRoot('snapshot copy', 20);
  const writer = openBotStateStore({ file: stateDatabaseFile(paths), mode: 'writer' });
  try {
    const task = takeSnapshot(paths, new Date(AT));
    const taken = await task.result;
    assert.equal(taken.file, join(backupsDirectory(paths), 'bot-20261112T080000000Z.db'));
    assert.equal(taken.takenAt.toISOString(), AT);
    // The writer went on meanwhile and after.
    writer.appendEntry('home', {
      at: AT,
      kind: 'owner',
      origin: 'owner',
      text: 'after the snapshot',
    } as never);
    const copy = openBotStateStore({ file: taken.file, mode: 'reader' });
    try {
      assert.equal(copy.entries('home').length, 20);
      assert.equal(copy.search('公園', { limit: 5 }).length, 5);
    } finally {
      copy.close();
    }
    assert.equal(writer.entries('home').length, 21);
  } finally {
    writer.close();
  }
  assert.deepEqual(
    checkDatabaseFile(join(backupsDirectory(paths), 'bot-20261112T080000000Z.db')),
    [],
  );
  // `vacuum into` writes only a new file.
  assert.throws(() =>
    snapshotDatabaseFile(
      stateDatabaseFile(paths),
      join(backupsDirectory(paths), 'bot-20261112T080000000Z.db'),
    ),
  );
});

test('the newest three snapshots are kept, and one that did not finish is never one of them', async () => {
  const paths = filledRoot('snapshot rotation', 5);
  const day = 24 * 3_600_000;
  const start = Date.parse(AT);
  assert.equal(snapshotDue(paths, new Date(start)), true);
  for (let index = 0; index < 5; index += 1) {
    // One left by a snapshot that was stopped.
    if (index === 3)
      writeFileSync(join(backupsDirectory(paths), 'bot-20261113T000000000Z.db.partial'), 'half');
    await takeSnapshot(paths, new Date(start + index * day)).result;
  }
  const kept = snapshots(paths).map((snapshot) => snapshot.takenAt.toISOString());
  assert.equal(kept.length, SNAPSHOTS_KEPT);
  assert.deepEqual(kept, [
    '2026-11-16T08:00:00.000Z',
    '2026-11-15T08:00:00.000Z',
    '2026-11-14T08:00:00.000Z',
  ]);
  assert.deepEqual(
    readdirSync(backupsDirectory(paths)).filter((name) => name.endsWith('.partial')),
    [],
  );
  assert.equal(snapshotDue(paths, new Date(start + 4 * day + day - 1)), false);
  assert.equal(snapshotDue(paths, new Date(start + 5 * day)), true);
  // A snapshot that fails leaves nothing behind and keeps the ones before.
  rmSync(stateDatabaseFile(paths));
  await assert.rejects(takeSnapshot(paths, new Date(start + 6 * day)).result);
  assert.equal(snapshots(paths).length, SNAPSHOTS_KEPT);
  assert.deepEqual(
    readdirSync(backupsDirectory(paths)).filter((name) => !/^bot-\d{8}T\d{9}Z\.db$/u.test(name)),
    [],
  );
});

test('the report names the problems, the newest snapshot and how to put it back', () => {
  const paths = filledRoot('report', 1);
  const none = readFileSync(
    writeCheckReport(paths, ['Tree 9 page 9: btreeInitPage() returns error code 11'], new Date(AT)),
    'utf8',
  );
  assert.match(none, /failed its check/u);
  assert.match(none, /btreeInitPage/u);
  assert.match(none, /There is no snapshot yet/u);
  mkdirSync(backupsDirectory(paths), { recursive: true });
  writeFileSync(join(backupsDirectory(paths), 'bot-20261111T080000000Z.db'), '');
  const many = Array.from({ length: 150 }, (_, index) => `problem ${index}`);
  const text = readFileSync(writeCheckReport(paths, many, new Date(Date.parse(AT) + 1000)), 'utf8');
  assert.ok(text.includes(join(backupsDirectory(paths), 'bot-20261111T080000000Z.db')));
  assert.match(text, /taken 2026-11-11T08:00:00\.000Z/u);
  assert.match(text, /and 50 more/u);
  assert.match(text, /copy the snapshot there as bot\.db/u);
  assert.equal(newestSnapshot(paths)?.takenAt.toISOString(), '2026-11-11T08:00:00.000Z');
});

test('a running core checks its database, then takes a snapshot while it is idle, once a day', async () => {
  const { core, root } = openTestBot({
    botsHome: home.botsHome,
    id: 'snapshot-core',
    core: { stateMaintenance: { snapshotCheckMs: 50 } },
  });
  const paths = botPathsFor(root);
  await core.start();
  try {
    await sendAndWait(core, 'home', 'remember the kettle');
    await until(() => snapshots(paths).length === 1, 'the first snapshot');
    const first = snapshots(paths)[0]!;
    const copy = openBotStateStore({ file: first.file, mode: 'reader' });
    try {
      assert.ok(copy.importMarker() !== undefined);
    } finally {
      copy.close();
    }
    // Not again the same day.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(snapshots(paths).length, 1);
  } finally {
    await core.stop();
  }
  // Stopped, the core holds nothing open: the file can be renamed, as a restore does.
  renameSync(stateDatabaseFile(paths), `${stateDatabaseFile(paths)}.moved`);
  renameSync(`${stateDatabaseFile(paths)}.moved`, stateDatabaseFile(paths));
});

test('a damaged database stops the core with a report, and the newest snapshot starts the bot again', async () => {
  const logs: string[] = [];
  const open = (check = true): BotCore =>
    BotCore.open({
      root: join(home.botsHome, 'damaged'),
      log: (line) => logs.push(line),
      runtime: {
        runtimeEntry: join(import.meta.dirname, '../support/fake-runtime.mjs'),
        readyTimeoutMs: 15_000,
        stopTimeoutMs: 3_000,
      },
      handoffPollMs: 100,
      life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
      stateMaintenance: { check, snapshotCheckMs: 50 },
    });
  const { core: first, root } = openTestBot({
    botsHome: home.botsHome,
    id: 'damaged',
    core: { stateMaintenance: { snapshotCheckMs: 50 } },
  });
  const paths = botPathsFor(root);
  await first.start();
  await sendAndWait(first, 'home', 'before the snapshot');
  await until(() => snapshots(paths).length === 1, 'the snapshot');
  const snapshot = snapshots(paths)[0]!;
  await sendAndWait(first, 'home', 'after the snapshot');
  await first.stop();

  damage(stateDatabaseFile(paths));
  const damaged = open();
  await damaged.start();
  await within(damaged.whenStopped(), 20_000, 'the core stopping itself');
  const reports = readdirSync(root).filter((name) => name.startsWith('state-check-'));
  assert.equal(reports.length, 1);
  const report = readFileSync(join(root, reports[0]!), 'utf8');
  assert.ok(report.includes(snapshot.file), report);
  assert.ok(logs.some((line) => line.includes('failed its check') && line.includes(reports[0]!)));
  // No snapshot of the damaged database replaced the good one.
  assert.deepEqual(snapshots(paths), [snapshot]);

  // As the report says: the database moved out, the snapshot copied in its place.
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${stateDatabaseFile(paths)}${suffix}`)) {
      renameSync(`${stateDatabaseFile(paths)}${suffix}`, join(home.root, `kept-bot.db${suffix}`));
    }
  }
  copyFileSync(snapshot.file, stateDatabaseFile(paths));
  const restored = open();
  await restored.start();
  try {
    const texts = restored.transcript('home').map((entry) => entry.text);
    assert.ok(texts.includes('before the snapshot'));
    assert.equal(texts.includes('after the snapshot'), false);
  } finally {
    await restored.stop();
  }
});

test('a database SQLite cannot open stops every host with a report', () => {
  const logs: string[] = [];
  const { root } = openTestBot({ botsHome: home.botsHome, id: 'unreadable' });
  const paths = botPathsFor(root);
  writeFileSync(stateDatabaseFile(paths), 'this is not a database file at all; '.repeat(200));
  // Any host that opens the bot hears it, the one about to start its core too.
  assert.throws(
    () => BotCore.open({ root, log: (line) => logs.push(line) }),
    (error: unknown) =>
      error instanceof Error &&
      /cannot be read; see .*state-check-/u.test(error.message) &&
      isDamagedDatabaseError(error.cause),
  );
  const reports = readdirSync(root).filter((name) => name.startsWith('state-check-'));
  assert.equal(reports.length, 1);
  assert.match(readFileSync(join(root, reports[0]!), 'utf8'), /There is no snapshot yet/u);
  assert.ok(logs.some((line) => line.includes('cannot be read')));
});
