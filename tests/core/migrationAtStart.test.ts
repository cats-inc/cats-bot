import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { main } from '../../src/cli/main.ts';
import { BotCore, initializeBot } from '../../src/core/bot.ts';
import { readInstanceLock } from '../../src/core/store/lock.ts';
import {
  botPathsFor,
  stateDatabaseFile,
  transcriptFile,
  type BotPaths,
} from '../../src/core/store/paths.ts';
import {
  version1ArchiveDirectory,
  type MigrationStep,
} from '../../src/core/store/version1Migration.ts';
import { fakeRuntimeEntry, makeTempHome, type TempHome } from '../support/harness.ts';

/**
 * PLAN-014 task 1.5 and SPEC-014's acceptance: a start stopped before each step of the
 * migration leaves the version-1 files whole and the bot's lock free, and the next start
 * migrates and runs. Also `cats-bot reindex` (task 1.3).
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-migration-start-');
});
after(() => home.cleanup());

const AT = '2026-11-12T08:00:00.000Z';
const STEPS: MigrationStep[] = ['discard', 'backup', 'import', 'report', 'profile', 'archive'];

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
  writeFileSync(
    join(paths.conversations, 'home.json'),
    JSON.stringify({
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
    }),
  );
  writeFileSync(
    transcriptFile(paths, 'home'),
    `${JSON.stringify({ seq: 1, at: AT, kind: 'owner', origin: 'owner', text: 'written by 0.5' })}\n`,
  );
  writeFileSync(paths.journal, '');
  return { root, paths };
}

function open(root: string, step?: MigrationStep): BotCore {
  return BotCore.open({
    root,
    log: () => {},
    runtime: { runtimeEntry: fakeRuntimeEntry, readyTimeoutMs: 15_000, stopTimeoutMs: 3_000 },
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
    handoffPollMs: 100,
    stateMaintenance: { check: false },
    ...(step
      ? {
          migrationStep: (at: MigrationStep) => {
            if (at === step) throw new Error(`stopped before ${step}`);
          },
        }
      : {}),
  });
}

for (const step of STEPS) {
  test(`a start stopped before the migration's ${step} step is finished by the next start`, async () => {
    const { root, paths } = versionOneBot(`stopped-${step}`);
    const transcript = readFileSync(transcriptFile(paths, 'home'), 'utf8');
    const first = open(root, step);
    let stopped = false;
    try {
      await first.start();
    } catch (error) {
      stopped = true;
      assert.match(String(error), new RegExp(`stopped before ${step}`, 'u'));
    }
    if (stopped) {
      assert.equal(readInstanceLock(paths), null, 'the lock is free');
      // The files are whole, where they are: in the root, or archived once the profile was raised.
      const kept = existsSync(transcriptFile(paths, 'home'))
        ? transcriptFile(paths, 'home')
        : join(version1ArchiveDirectory(paths), 'transcripts', 'home.jsonl');
      assert.equal(readFileSync(kept, 'utf8'), transcript);
    } else {
      // A step this migration does not take: the report is written only when it fails.
      assert.equal(step, 'report');
      await first.stop();
    }
    const second = open(root);
    await second.start();
    try {
      assert.deepEqual(
        second
          .transcript('home')
          .map((entry) => entry.text)
          .slice(0, 1),
        ['written by 0.5'],
      );
      assert.equal(existsSync(join(version1ArchiveDirectory(paths), 'transcripts')), true);
      assert.equal(existsSync(paths.transcripts), false);
    } finally {
      await second.stop();
    }
  });
}

test('cats-bot reindex rebuilds the search index while the bot is stopped, and refuses while it runs', async () => {
  const { root, paths } = versionOneBot('reindex');
  const env = { ...process.env, CATS_BOT_HOME: home.root };
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    // A bot of 0.5: the rebuild is a write, so it migrates first.
    assert.equal(await main(['reindex', '--id', 'reindex'], env), 0);
  } finally {
    process.stdout.write = write;
  }
  assert.match(written.join(''), /The search index holds 1 entries again/u);
  assert.equal(existsSync(stateDatabaseFile(paths)), true);

  const core = open(root);
  await core.start();
  try {
    assert.equal(await main(['reindex', '--id', 'reindex'], env), 1);
    assert.throws(() => core.rebuildSearchIndex(), /while the bot is stopped/u);
  } finally {
    await core.stop();
  }
});
