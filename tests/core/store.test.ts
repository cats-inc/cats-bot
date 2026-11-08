import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { readJsonFile, writeJsonAtomic } from '../../src/core/store/atomicFile.ts';
import { appendJournal, readJournal, rebuildJournalState } from '../../src/core/store/journal.ts';
import {
  acquireInstanceLock, acquireLockFile, lockOwnerHolds, processStillOwns, readInstanceLock, takeHandoffs, writeHandoff,
  type LockOwnerProbe,
} from '../../src/core/store/lock.ts';
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

/** A system where `pid` is alive, was created at `created`, and the machine booted at `booted`. */
function probe(created: number | 'gone' | null, booted = Date.parse('2026-11-08T14:22:06Z'), alive = true): LockOwnerProbe {
  return { alive: () => alive, createdAt: () => created, bootedAt: () => booted };
}

test('a lock whose PID now belongs to a process started after it is stale', () => {
  // The hub lock left by the 13:40 start; a service took PID 2408 at 14:22 after a restart.
  const written = Date.parse('2026-11-08T13:40:58.038Z');
  assert.equal(processStillOwns(2408, written, probe(Date.parse('2026-11-08T14:22:21.412Z'))), false);
  assert.equal(processStillOwns(2408, written, probe(Date.parse('2026-11-08T13:40:57.787Z'))), true, 'its writer, created first');
  assert.equal(processStillOwns(2408, written, probe(written + 1_500)), true, 'a small clock step after start');
  assert.equal(processStillOwns(2408, written, probe('gone')), false, 'ended since the PID check');
  assert.equal(processStillOwns(2408, written, probe(Date.parse('2026-11-08T13:40:57Z'), Date.parse('2026-11-08T14:22:06Z'), false)), false);
  assert.equal(processStillOwns(2408, Number.NaN, probe(Date.parse('2026-11-08T14:22:21Z'))), true, 'no time to compare, so it stands');
});

test('without a creation time, a lock from before the last boot is stale', () => {
  const booted = Date.parse('2026-11-08T14:22:06Z');
  assert.equal(processStillOwns(2408, Date.parse('2026-11-08T13:40:58Z'), probe(null, booted)), false);
  assert.equal(processStillOwns(2408, Date.parse('2026-11-08T14:23:12Z'), probe(null, booted)), true);
  assert.equal(processStillOwns(2408, booted - 60_000, probe(null, booted)), true, 'a clock step within the margin');
});

test('a lock naming this process stands only if written after it started', () => {
  assert.equal(processStillOwns(process.pid, Date.now(), probe(null)), true);
  assert.equal(processStillOwns(process.pid, Date.parse('2000-01-01T00:00:00Z'), probe(null, 0)), false,
    'an earlier process with the same PID wrote it');
  assert.equal(lockOwnerHolds({ pid: process.pid, host: 'elsewhere', startedAt: new Date().toISOString() }, probe(null)), false);
  assert.equal(lockOwnerHolds(null as unknown as { pid: number; host: string }, probe(null)), false, 'a lock file that is not an object');
});

test('a lock left before a restart is replaced even though its PID is in use again', () => {
  const file = join(home.botsHome, 'reused', 'hub.lock.json');
  mkdirSync(join(home.botsHome, 'reused'), { recursive: true });
  const stale = { pid: 2408, host: hostname(), startedAt: '2026-11-08T13:40:58.038Z' };
  writeFileSync(file, JSON.stringify(stale));
  const taken = acquireLockFile(file, { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() },
    probe(Date.parse('2026-11-08T14:22:21.412Z')));
  assert.equal(taken.held, true);
  if (taken.held) taken.release();
  writeFileSync(file, JSON.stringify(stale));
  const refused = acquireLockFile(file, { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() },
    probe(Date.parse('2026-11-08T13:40:57.787Z')));
  assert.equal(refused.held, false, 'the process that wrote it still runs');
});

test('the system check tells a live writer from a later process with its PID', () => {
  // The test runner outlives this file; it started before now and long after 2000.
  const paths = botPathsFor(join(home.botsHome, 'system-probe'));
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.lock, JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: new Date().toISOString() }));
  assert.equal(readInstanceLock(paths)?.pid, process.ppid);
  assert.equal(acquireInstanceLock(paths).held, false);
  writeFileSync(paths.lock, JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: '2000-01-01T00:00:00.000Z' }));
  assert.equal(readInstanceLock(paths), null);
  writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: '2000-01-01T00:00:00.000Z' }));
  const replaced = acquireInstanceLock(paths);
  assert.equal(replaced.held, true, 'a lock naming this PID from before this process is stale too');
  if (replaced.held) replaced.release();
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
