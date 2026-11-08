import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
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
import { readProcessIdentity, windowsSnapshotIdentity } from '../../src/core/store/processIdentity.ts';
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


/** A system where every PID is alive (unless said otherwise) and has the given identity. */
function probe(identity: string | 'gone' | null | ((pid: number) => string | 'gone' | null), alive = true): LockOwnerProbe {
  return { alive: () => alive, identity: typeof identity === 'function' ? identity : () => identity };
}

/** A Windows identity for a process created at `iso`. */
function windowsIdentity(iso: string): string {
  return `win:${BigInt(Date.parse(iso)) * 10_000n + 116_444_736_000_000_000n}`;
}

test('a lock stands only while the process using its PID is the one that wrote it', () => {
  const writer = { identity: windowsIdentity('2026-11-08T13:40:57.787Z') };
  // The hub lock left by the 13:40 start; a service took PID 2408 at 14:22 after a restart.
  assert.equal(processStillOwns(2408, writer, probe(windowsIdentity('2026-11-08T14:22:21.412Z'))), false);
  assert.equal(processStillOwns(2408, writer, probe(writer.identity)), true);
  assert.equal(processStillOwns(2408, writer, probe('gone')), false, 'ended since the PID check');
  assert.equal(processStillOwns(2408, writer, probe(writer.identity, false)), false);
  assert.equal(processStillOwns(2408, writer, probe(null)), true, 'when this system cannot tell, it stands as before');
  // No clock is compared, so a clock step after the writer started changes nothing.
  assert.equal(processStillOwns(2408, { ...writer, writtenAt: Date.parse('2000-01-01T00:00:00Z') }, probe(writer.identity)), true);
});

test('a lock from 0.5.4 or earlier is judged by its time where the creation time is known', () => {
  const writtenAt = Date.parse('2026-11-08T13:40:58.038Z');
  assert.equal(processStillOwns(2408, { writtenAt }, probe(windowsIdentity('2026-11-08T14:22:21.412Z'))), false);
  assert.equal(processStillOwns(2408, { writtenAt }, probe(windowsIdentity('2026-11-08T13:40:57.787Z'))), true);
  assert.equal(processStillOwns(2408, { writtenAt }, probe(windowsIdentity('2026-11-08T13:41:40Z'))), true, 'a clock step within the margin');
  assert.equal(processStillOwns(2408, { writtenAt }, probe('linux:boot:123')), true, 'no creation time elsewhere, so it stands');
  assert.equal(processStillOwns(2408, {}, probe(windowsIdentity('2026-11-08T14:22:21Z'))), true, 'no time either');
  assert.equal(processStillOwns(process.pid, { writtenAt: Date.now() }, probe('linux:boot:1')), true);
  assert.equal(processStillOwns(process.pid, { writtenAt: Date.parse('2000-01-01T00:00:00Z') }, probe('linux:boot:1')), false,
    'an earlier process with this PID wrote it');
  assert.equal(lockOwnerHolds({ pid: process.pid, host: 'elsewhere', startedAt: new Date().toISOString() }, probe('x')), false);
  assert.equal(lockOwnerHolds(null as unknown as { pid: number; host: string }, probe('x')), false, 'a lock file that is not an object');
});

test('a lock left before a restart is replaced even though its PID is in use again', () => {
  const file = join(home.botsHome, 'reused', 'hub.lock.json');
  mkdirSync(join(home.botsHome, 'reused'), { recursive: true });
  const stale = { pid: 2408, host: hostname(), startedAt: '2026-11-08T13:40:58.038Z', identity: windowsIdentity('2026-11-08T13:40:57.787Z') };
  const mine = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(stale));
  const taken = acquireLockFile(file, mine, probe((pid) => (pid === 2408 ? windowsIdentity('2026-11-08T14:22:21.412Z') : 'me')));
  assert.equal(taken.held, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).identity, 'me', 'the new lock carries its writer identity');
  if (taken.held) taken.release();
  writeFileSync(file, JSON.stringify(stale));
  const refused = acquireLockFile(file, mine, probe((pid) => (pid === 2408 ? stale.identity : 'me')));
  assert.equal(refused.held, false, 'the process that wrote it still runs');
});

test('a stale lock that another process replaces while it is judged is kept', () => {
  const file = join(home.botsHome, 'raced', 'hub.lock.json');
  mkdirSync(join(home.botsHome, 'raced'), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: 2408, host: hostname(), startedAt: '2026-11-08T13:40:58.038Z', identity: 'old' }));
  const other = { pid: 5555, host: hostname(), startedAt: new Date().toISOString(), identity: 'other' };
  const result = acquireLockFile(file, { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }, probe((pid) => {
    // Another hub judges the same stale lock first, and replaces it while this one is still deciding.
    if (pid === 2408) writeFileSync(file, JSON.stringify(other));
    return pid === 2408 ? 'new' : pid === 5555 ? 'other' : 'me';
  }));
  assert.equal(result.held, false);
  assert.equal(!result.held && result.owner.pid, 5555);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 5555, 'the other hub keeps its lock');
});

test('this system reads process identities and tells a live writer from a later process with its PID', () => {
  // The test runner outlives this file and started before it.
  const runner = readProcessIdentity(process.ppid);
  if (['win32', 'linux', 'darwin'].includes(process.platform)) assert.equal(typeof runner, 'string');
  assert.equal(readProcessIdentity(process.ppid), runner, 'stable while the process runs');
  assert.equal(readProcessIdentity(2 ** 31 - 2), process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin' ? 'gone' : null);

  const paths = botPathsFor(join(home.botsHome, 'system-probe'));
  mkdirSync(paths.root, { recursive: true });
  const record = { pid: process.ppid, host: hostname(), startedAt: new Date().toISOString() };
  writeFileSync(paths.lock, JSON.stringify({ ...record, identity: runner }));
  assert.equal(readInstanceLock(paths)?.pid, process.ppid);
  assert.equal(acquireInstanceLock(paths).held, false);
  writeFileSync(paths.lock, JSON.stringify({ ...record, identity: 'a process that ended' }));
  assert.equal(readInstanceLock(paths), runner === null ? process.ppid : null);
  // A lock from 0.5.4 or earlier, written in 2000: only Windows knows the runner was created later.
  writeFileSync(paths.lock, JSON.stringify({ ...record, startedAt: '2000-01-01T00:00:00.000Z' }));
  assert.equal(readInstanceLock(paths)?.pid ?? null, process.platform === 'win32' ? null : process.ppid);
  writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: '2000-01-01T00:00:00.000Z' }));
  const replaced = acquireInstanceLock(paths);
  assert.equal(replaced.held, true, 'a lock naming this PID from before this process is stale too');
  if (replaced.held) {
    assert.equal(readInstanceLock(paths)?.identity, readProcessIdentity(process.pid) ?? undefined);
    replaced.release();
  }
});

test('Windows reads the same creation time with and without a handle', { skip: process.platform !== 'win32' }, () => {
  for (const pid of [process.pid, process.ppid]) assert.equal(windowsSnapshotIdentity(pid), readProcessIdentity(pid));
  // The System process cannot be opened by an ordinary account; the list still answers.
  assert.match(readProcessIdentity(4) ?? '', /^win:\d+$/u);
  assert.equal(windowsSnapshotIdentity(2 ** 31 - 2), 'gone');
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
