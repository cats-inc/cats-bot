import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BotCore, MigrationNotFinishedError, initializeBot } from '../../src/core/bot.ts';
import { main } from '../../src/cli/main.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';
import { readInstanceLock } from '../../src/core/store/lock.ts';
import {
  botPathsFor,
  stateDatabaseFile,
  transcriptFile,
  type BotPaths,
} from '../../src/core/store/paths.ts';
import {
  migrationBackupDirectory,
  version1ArchiveDirectory,
} from '../../src/core/store/version1Migration.ts';
import type { WorkItem } from '../../src/core/types.ts';
import {
  fakeRuntimeEntry,
  makeTempHome,
  openTestBot,
  sendAndWait,
  type TempHome,
  waitForEvent,
} from '../support/harness.ts';
import { readStateJournal, withStateStore } from '../support/stateData.ts';

/**
 * PLAN-014 cutover (SPEC-014): the core keeps a bot's records in its state database, migrates
 * a bot of 0.5 at the first write under the lock, and keeps no prompt of a deleted conversation.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-cutover-');
});
after(() => home.cleanup());

const AT = '2026-11-11T08:00:00.000Z';

function coreOptions(root: string) {
  return {
    root,
    log: () => {},
    runtime: { runtimeEntry: fakeRuntimeEntry, readyTimeoutMs: 15_000, stopTimeoutMs: 3_000 },
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
    handoffPollMs: 100,
  };
}

/** A bot as 0.5 left it: a schema-2 profile and version-1 files, no database. */
function versionOneBot(id: string): { root: string; paths: BotPaths } {
  const { root, profile } = initializeBot(home.botsHome, {
    id,
    name: 'Old Bot',
    provider: 'claude',
  });
  const paths = botPathsFor(root);
  rmSync(stateDatabaseFile(paths));
  writeFileSync(paths.profile, JSON.stringify({ ...profile, schemaVersion: 2 }));
  mkdirSync(paths.conversations, { recursive: true });
  mkdirSync(paths.transcripts, { recursive: true });
  const record = {
    schemaVersion: 1,
    id: 'home',
    role: 'home',
    title: 'Direct message',
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
    lastOwnerMessageAt: AT,
    lastBotMessageAt: AT,
    checkpoint: null,
  };
  writeFileSync(join(paths.conversations, 'home.json'), JSON.stringify(record));
  writeFileSync(
    transcriptFile(paths, 'home'),
    [
      { seq: 1, at: AT, kind: 'owner', origin: 'owner', text: 'written by 0.5' },
      { seq: 2, at: AT, kind: 'bot', origin: 'owner', text: 'answered by 0.5' },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(''),
  );
  const item = {
    ...createWorkItem(
      { kind: 'owner_message', source: 'owner', conversationId: 'home', prompt: 'written by 0.5' },
      new Date(AT),
    ),
    state: 'completed',
  };
  writeFileSync(paths.journal, `${JSON.stringify({ type: 'work', at: AT, item })}\n`);
  return { root, paths };
}

function profileVersion(paths: BotPaths): unknown {
  return (JSON.parse(readFileSync(paths.profile, 'utf8')) as { schemaVersion: unknown })
    .schemaVersion;
}

test('a bot of 0.5 is migrated at its first start and runs on its database', async () => {
  const { root, paths } = versionOneBot('old-start');
  const core = BotCore.open(coreOptions(root));
  // A read-only host reads nothing of a bot not migrated yet, and makes no database.
  assert.deepEqual(await core.listConversations(), []);
  assert.equal(existsSync(stateDatabaseFile(paths)), false);
  await core.start();
  try {
    assert.deepEqual(
      core
        .transcript('home')
        .map((entry) => entry.text)
        .slice(0, 2),
      ['written by 0.5', 'answered by 0.5'],
    );
    assert.equal(core.listWorkItems().length, 1);
    const reply = await sendAndWait(core, 'home', 'written by 0.6');
    assert.equal(reply.state, 'completed');
    assert.equal(profileVersion(paths), 3);
    assert.equal(readdirSync(migrationBackupDirectory(paths)).length, 1);
    assert.deepEqual(readdirSync(version1ArchiveDirectory(paths)).sort(), [
      'conversations',
      'journal.jsonl',
      'transcripts',
    ]);
    assert.equal(existsSync(paths.journal), false);
  } finally {
    await core.stop();
  }
  // What it wrote is in the database, read beside nothing.
  assert.ok(
    withStateStore(root, (store) =>
      store.entries('home').some((entry) => entry.text === 'written by 0.6'),
    ),
  );
  assert.equal(readInstanceLock(paths), null);
});

test('a write while the bot is stopped takes the lock and migrates first', async () => {
  const { root, paths } = versionOneBot('old-write');
  const core = BotCore.open(coreOptions(root));
  const schedule = core.createSchedule({
    conversationId: 'home',
    prompt: 'water the plants',
    kind: 'once',
    at: new Date(Date.now() + 3_600_000),
    createdBy: 'owner',
  });
  assert.equal(readInstanceLock(paths), null, 'the lock is let go after the write');
  assert.equal(profileVersion(paths), 3);
  assert.equal(readStateJournal(root).schedules.get(schedule.id)?.prompt, 'water the plants');
  assert.ok(
    withStateStore(root, (store) =>
      store.entries('home').some((entry) => entry.text.startsWith('Schedule created')),
    ),
  );
  await core.cancelSchedule(schedule.id);
  assert.equal(readStateJournal(root).schedules.get(schedule.id)?.state, 'cancelled');
});

test('a migration that does not finish stops the start and leaves the files as they were', async () => {
  const { root, paths } = versionOneBot('old-broken');
  // A hand edit: an entry that does not come after the one before it.
  writeFileSync(
    transcriptFile(paths, 'home'),
    `${readFileSync(transcriptFile(paths, 'home'), 'utf8')}${JSON.stringify({ seq: 1, at: AT, kind: 'owner', origin: 'owner', text: 'again' })}\n`,
  );
  const before = readFileSync(transcriptFile(paths, 'home'));
  const core = BotCore.open(coreOptions(root));
  await assert.rejects(core.start(), (error: unknown) => {
    assert.ok(error instanceof MigrationNotFinishedError);
    assert.match(
      readFileSync(error.report, 'utf8'),
      /seq_out_of_order: transcripts\/home\.jsonl line 3/u,
    );
    return true;
  });
  assert.deepEqual(readFileSync(transcriptFile(paths, 'home')), before);
  assert.equal(existsSync(stateDatabaseFile(paths)), false);
  assert.equal(profileVersion(paths), 2);
  assert.equal(readInstanceLock(paths), null);
  await core.stop();
});

test('a turn that ends after its conversation was deleted does not bring its work item back', async () => {
  const { core, root } = openTestBot({ botsHome: home.botsHome, id: 'late-turn' });
  await core.start();
  try {
    const note = await core.createConversation('Note');
    const done = await sendAndWait(core, note.id, 'in the note');
    await core.deleteConversation(note.id);
    // As a turn of the deleted conversation would record its end.
    (core as unknown as { record(item: WorkItem): WorkItem }).record({
      ...done,
      state: 'cancelled',
      updatedAt: new Date().toISOString(),
    });
    const journal = readStateJournal(root);
    assert.equal(journal.workItems.has(done.id), false);
    assert.equal(
      journal.entries.some((entry) => entry.type === 'work' && entry.item.id === done.id),
      false,
    );
  } finally {
    await core.stop();
  }
});

test('a delivery whose conversation was deleted is answered as cancelled and not admitted again', async () => {
  const { core, root } = openTestBot({ botsHome: home.botsHome, id: 'deleted-delivery' });
  const delivery = {
    deliveryId: 'd-gone-1',
    chainId: 'chain-gone-1',
    hop: 1,
    kind: 'message' as const,
    from: 'ada',
    fromName: 'Ada',
    text: 'hello',
  };
  await core.start();
  try {
    const done = waitForEvent(
      core,
      (event) => event.type === 'turn.completed' && event.workItem.conversationId === 'bot-ada',
    );
    core.admitBotMessage(delivery);
    await done;
    await core.deleteConversation('bot-ada');
  } finally {
    await core.stop();
  }
  const again = BotCore.open(coreOptions(root));
  await again.start();
  try {
    const item = again.admitBotMessage(delivery);
    assert.equal(item.state, 'cancelled');
    assert.equal(item.error, 'The conversation was deleted.');
    assert.equal(
      (await again.listConversations()).some((record) => record.id === 'bot-ada'),
      false,
      'no conversation is made again',
    );
    assert.deepEqual(
      (await again.botDeliveries(['d-gone-1', 'd-unknown'])).map((state) => [
        state.deliveryId,
        state.state,
        state.reply,
        state.error,
      ]),
      [['d-gone-1', 'cancelled', null, 'The conversation was deleted.']],
    );
  } finally {
    await again.stop();
  }
  // What is kept of it says nothing it said.
  assert.equal(
    withStateStore(root, (store) => JSON.stringify(store.journal())).includes('hello'),
    false,
  );
});

test("a new bot's database is made before its profile, and made again after a crash between them", () => {
  const { root } = initializeBot(home.botsHome, {
    id: 'new-bot',
    name: 'New Bot',
    provider: 'claude',
  });
  const paths = botPathsFor(root);
  assert.notEqual(
    withStateStore(root, (store) => store.importMarker()),
    undefined,
  );
  assert.equal(profileVersion(paths), 3);
  // A crash after the database and before the profile.
  rmSync(paths.profile);
  initializeBot(home.botsHome, { id: 'new-bot', name: 'New Bot', provider: 'claude' });
  assert.equal(profileVersion(paths), 3);
});

test('cats-bot restore puts the version-1 files back while the bot is stopped', async () => {
  const { root, paths } = versionOneBot('old-restore');
  const core = BotCore.open(coreOptions(root));
  await core.start();
  await core.stop();
  const env = { ...process.env, CATS_BOT_HOME: home.root };
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await main(['restore', '--id', 'old-restore', '--json'], env);
  } finally {
    process.stdout.write = write;
  }
  assert.equal(code, 0);
  const result = JSON.parse(written.join('')) as { restored: boolean; setAside: string | null };
  assert.equal(result.restored, true);
  assert.ok(result.setAside && existsSync(result.setAside));
  assert.equal(profileVersion(paths), 2);
  assert.ok(existsSync(transcriptFile(paths, 'home')));
  assert.equal(existsSync(stateDatabaseFile(paths)), false);

  // While the bot runs, it is refused.
  const running = BotCore.open(coreOptions(root));
  await running.start();
  try {
    const errors: string[] = [];
    const writeError = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(await main(['restore', '--id', 'old-restore'], env), 1);
    } finally {
      process.stderr.write = writeError;
    }
    assert.match(errors.join(''), /is running/u);
  } finally {
    await running.stop();
  }
});
