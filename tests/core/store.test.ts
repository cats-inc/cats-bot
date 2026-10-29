import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { readJsonFile, writeJsonAtomic } from '../../src/core/store/atomicFile.ts';
import { appendJournal, readJournal, rebuildJournalState } from '../../src/core/store/journal.ts';
import { acquireInstanceLock, readInstanceLock, takeHandoffs, writeHandoff } from '../../src/core/store/lock.ts';
import { botPathsFor, resolveBotRoot, resolveBotsHome, resolveCatsBotHome } from '../../src/core/store/paths.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';
import { makeTempHome, type TempHome } from '../support/harness.ts';

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-store-');
});
after(() => home.cleanup());

test('CATS_BOT_HOME places every bot root under bots/ (SPEC-007 FR-3, FR-4)', () => {
  const env = { CATS_BOT_HOME: home.root };
  assert.equal(resolveCatsBotHome(env), home.root);
  assert.equal(resolveBotsHome(env), home.botsHome);
  assert.equal(resolveBotRoot('abc', env), join(home.root, 'bots', 'abc'));
  const paths = botPathsFor(join(home.botsHome, 'abc'));
  assert.equal(paths.profile, join(home.botsHome, 'abc', 'profile.json'));
  assert.equal(paths.runtime, join(home.botsHome, 'abc', 'runtime'));
});

test('the root defaults to ~/.catsbot and ignores CATS_BOTS_HOME (SPEC-007 FR-3, FR-4)', () => {
  // Resolves paths only; nothing under the real home directory is created or read.
  const root = join(homedir(), '.catsbot');
  assert.equal(resolveCatsBotHome({}), root);
  assert.equal(resolveBotRoot('abc', {}), join(root, 'bots', 'abc'));
  assert.equal(resolveCatsBotHome({ CATS_BOTS_HOME: home.root }), root);
  assert.equal(resolveCatsBotHome({ CATS_BOT_HOME: '  ' }), root);
});

test('writeJsonAtomic leaves no temporary file and readJsonFile classifies failures (FR-3, FR-4)', () => {
  const dir = join(home.botsHome, 'atomic');
  const file = join(dir, 'value.json');
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(readdirSync(dir), ['value.json']);
  assert.deepEqual(readJsonFile(file), { ok: true, value: { a: 2 } });
  assert.deepEqual(readJsonFile(join(dir, 'missing.json')), { ok: false, reason: 'missing' });
  writeFileSync(file, '{broken');
  const corrupt = readJsonFile(file);
  assert.equal(corrupt.ok, false);
  assert.equal(!corrupt.ok && corrupt.reason, 'corrupt');
});

test('the instance lock admits one live writer and replaces a stale one (FR-3)', () => {
  const paths = botPathsFor(join(home.botsHome, 'lock'));
  const first = acquireInstanceLock(paths);
  assert.ok(first.held);
  const second = acquireInstanceLock(paths);
  assert.equal(second.held, false);
  assert.equal(!second.held && second.owner.pid, process.pid);
  assert.equal(readInstanceLock(paths)?.pid, process.pid);
  first.release();
  assert.equal(readInstanceLock(paths), null);

  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.lock, JSON.stringify({ pid: 2_147_483_000, host: 'elsewhere', startedAt: 'x' }));
  const replaced = acquireInstanceLock(paths);
  assert.ok(replaced.held, 'a lock from another host or dead process is stale');
  replaced.release();
});

test('handoff files arrive in order and are consumed once', () => {
  const paths = botPathsFor(join(home.botsHome, 'handoff'));
  assert.deepEqual(takeHandoffs(paths), []);
  writeHandoff(paths, { kind: 'say', conversationId: 'home', text: 'one' });
  writeHandoff(paths, { kind: 'open', conversationId: 'home' });
  const taken = takeHandoffs(paths);
  assert.deepEqual(taken.map((message) => message.kind), ['say', 'open']);
  assert.equal(taken[0]?.text, 'one');
  assert.deepEqual(takeHandoffs(paths), []);
  assert.equal(readdirSync(paths.handoff).length, 0);
});

test('the journal rebuilds the last record per id and counts unreadable lines (ADR-001 §6)', () => {
  const paths = botPathsFor(join(home.botsHome, 'journal'));
  const now = new Date('2026-10-27T10:00:00.000Z');
  const item = createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: 'home', prompt: 'hi' }, now);
  appendJournal(paths, { type: 'work', at: now.toISOString(), item });
  appendJournal(paths, { type: 'work', at: now.toISOString(), item: { ...item, state: 'running' } });
  appendJournal(paths, { type: 'runtime', at: now.toISOString(), event: 'ready' });
  appendFileSync(paths.journal, '{"type":"work","at":"x","item":{"id":"broken"\n');
  const state = readJournal(paths);
  assert.equal(state.workItems.get(item.id)?.state, 'running');
  assert.equal(state.corruptLines, 1);
  assert.equal(state.entries.length, 3);
  assert.equal(rebuildJournalState([]).workItems.size, 0);
  assert.ok(existsSync(paths.journal));
});
