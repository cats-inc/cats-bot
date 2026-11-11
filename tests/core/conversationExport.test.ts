import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { main } from '../../src/cli/main.ts';
import { initializeBot } from '../../src/core/bot.ts';
import { acquireInstanceLock } from '../../src/core/store/lock.ts';
import {
  botPathsFor,
  stateDatabaseFile,
  transcriptFile,
  type BotPaths,
} from '../../src/core/store/paths.ts';
import { presentationsDirectory } from '../../src/core/store/presentation.ts';
import { exportLines } from '../../src/core/store/conversationExport.ts';
import { migrateVersion1 } from '../../src/core/store/version1Migration.ts';
import { STATE_DATABASE_PROFILE_RAISE } from '../../src/core/profile/profile.ts';
import { openBotStateStore } from '../../src/core/store/stateStore.ts';
import { makeTempHome, type TempHome } from '../support/harness.ts';

/**
 * SPEC-014 FR-14 and its acceptance: `cats-bot export` writes the same lines from a bot's
 * version-1 files and from its database, so an export from before the migration and one
 * from after it are equal byte for byte.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-export-');
});
after(() => home.cleanup());

const AT = '2026-11-12T08:00:00.000Z';

function record(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // Fields in an order of their own, as a record written by hand or an older version may be.
  return {
    title: id === 'home' ? 'Direct message' : `Note ${id}`,
    id,
    schemaVersion: 1,
    role: id === 'home' ? 'home' : 'note',
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
    lastBotMessageAt: null,
    checkpoint: null,
    ...extra,
  };
}

function response(seq: number, id: string, text: string): Record<string, unknown> {
  return {
    seq,
    at: AT,
    kind: 'bot',
    origin: 'owner',
    text,
    workItemId: `w-${id}`,
    presentationRevision: 2,
    presentationSeqs: [seq],
    presentationTerminalSeq: seq,
    presentation: { version: 1, id, phase: 'sealed', blocks: [] },
  };
}

/** A bot as 0.5 left it, with what an export has to carry over unchanged. */
function versionOneBot(id: string): BotPaths {
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
  mkdirSync(presentationsDirectory(paths), { recursive: true });
  writeFileSync(join(paths.conversations, 'home.json'), JSON.stringify(record('home'), null, 2));
  writeFileSync(
    join(paths.conversations, 'note-1.json'),
    JSON.stringify(record('note-1', { contactOf: null })),
  );
  writeFileSync(
    transcriptFile(paths, 'home'),
    [
      '{"seq":1,"at":"2026-11-12T08:00:00.000Z","kind":"owner","origin":"owner","text":"去公園散步 🐈"}',
      // `seq` last, spaces and an escaped character, as a hand edit may leave them.
      '{ "at": "2026-11-12T08:00:01.000Z", "kind": "bot", "origin": "owner", "text": "a reply \\u00e9", "seq": 2 }',
      '{"seq":3,"at":"2026-11-12T08:00:02.000Z","kind":"system","origin":"event","text":"","workItemId":"w-3"}',
      // A crash left half a line; 0.5 skipped it, and so does the import.
      '{"seq":4,"at":"2026-11-1',
      '{"seq":5,"at":"2026-11-12T08:00:03.000Z","kind":"owner","origin":"owner","text":"after the broken line","n":1.50}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    transcriptFile(paths, 'note-1'),
    `${JSON.stringify({ seq: 1, at: AT, kind: 'owner', origin: 'owner', text: 'in the note' })}\n`,
  );
  writeFileSync(
    join(presentationsDirectory(paths), 'home.json'),
    JSON.stringify({
      version: 1,
      conversationId: 'home',
      // Two of the same `seq`, written out of order.
      responses: [response(2, 'p-b', 'second'), response(2, 'p-a', 'first')],
    }),
  );
  writeFileSync(paths.journal, '');
  return paths;
}

async function exported(paths: BotPaths, conversation: string): Promise<string> {
  const output = join(home.root, `export-${Math.random().toString(36).slice(2)}.jsonl`);
  const id = paths.root.split(/[\\/]/u).pop()!;
  const code = await main(['export', conversation, '--id', id, '--output', output], {
    ...process.env,
    CATS_BOT_HOME: home.root,
  });
  assert.equal(code, 0);
  return readFileSync(output, 'utf8');
}

function migrate(paths: BotPaths): void {
  const lock = acquireInstanceLock(paths);
  assert.equal(lock.held, true);
  try {
    assert.equal(
      migrateVersion1({ paths, profile: STATE_DATABASE_PROFILE_RAISE }).outcome,
      'migrated',
    );
  } finally {
    lock.release();
  }
}

test('an export from before the migration equals the one from after it, byte for byte', async () => {
  const paths = versionOneBot('export-old');
  const before = {
    home: await exported(paths, 'home'),
    note: await exported(paths, 'note-1'),
  };
  migrate(paths);
  assert.equal(await exported(paths, 'home'), before.home);
  assert.equal(await exported(paths, 'note-1'), before.note);

  // What the lines hold: the record, the entries the import keeps, the presentations in order.
  const lines = before.home
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    lines.map((line) => line.type),
    ['conversation', 'entry', 'entry', 'entry', 'entry', 'presentation', 'presentation'],
  );
  assert.deepEqual(Object.keys(lines[0]!.record as object).slice(0, 2), ['title', 'id']);
  assert.deepEqual(Object.keys(lines[2]!.entry as object), ['at', 'kind', 'origin', 'text', 'seq']);
  assert.equal((lines[1]!.entry as { text: string }).text, '去公園散步 🐈');
  assert.deepEqual(
    lines
      .slice(5)
      .map((line) => (line.response as { presentation: { id: string } }).presentation.id),
    ['p-a', 'p-b'],
  );
});

test('an export of a migrated bot has what was written since, and a missing conversation is an error', async () => {
  const paths = versionOneBot('export-later');
  migrate(paths);
  const store = openBotStateStore({ file: stateDatabaseFile(paths), mode: 'writer' });
  try {
    store.appendEntry('note-1', {
      at: AT,
      kind: 'bot',
      origin: 'owner',
      text: 'written by 0.6',
    } as never);
  } finally {
    store.close();
  }
  const text = await exported(paths, 'note-1');
  assert.match(text, /written by 0\.6/u);
  assert.equal(text.trimEnd().split('\n').length, 3);
  const id = paths.root.split(/[\\/]/u).pop()!;
  assert.equal(
    await main(['export', 'nobody', '--id', id, '--output', join(home.root, 'none.jsonl')], {
      ...process.env,
      CATS_BOT_HOME: home.root,
    }),
    1,
  );
  assert.equal(await main(['export', '--id', id], { ...process.env, CATS_BOT_HOME: home.root }), 2);
});

test('the lines are a conversation, its entries and its presentations, each record as it was stored', () => {
  const lines = exportLines({
    record: { id: 'home', b: 1, a: 2 },
    entries: [{ seq: 1, text: 'x' }],
    responses: [response(3, 'p2', 'z'), response(1, 'p9', 'y'), response(3, 'p10', 'w')],
  });
  assert.equal(lines[0], '{"type":"conversation","record":{"id":"home","b":1,"a":2}}\n');
  assert.equal(lines[1], '{"type":"entry","entry":{"seq":1,"text":"x"}}\n');
  // By `seq`, then by id as text.
  assert.deepEqual(
    lines
      .slice(2)
      .map(
        (line) =>
          (JSON.parse(line) as { response: { presentation: { id: string } } }).response.presentation
            .id,
      ),
    ['p9', 'p10', 'p2'],
  );
});
