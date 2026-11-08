import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import type { HandoffMessage } from '../types.ts';
import { readJsonFile, writeJsonAtomic } from './atomicFile.ts';
import type { BotPaths } from './paths.ts';
import { identityCreatedAt, readProcessIdentity, type ProcessIdentity } from './processIdentity.ts';

/** For the update leases, which the shell writes through this module. */
export { ownProcessIdentity } from './processIdentity.ts';

/**
 * SPEC-001 FR-3: one writer per data root. The lock file names the owning
 * process; a second instance of the same bot hands its startup arguments to
 * the first through the handoff directory and exits.
 */

export type { InstanceLock } from '../types.ts';
import type { InstanceLock } from '../types.ts';

export type LockResult =
  | { held: true; release: () => void }
  | { held: false; owner: InstanceLock };

export type { HandoffMessage };

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * What a lock check asks the system. A live PID alone does not show that the
 * process which wrote a lock still runs: Windows ends programs at shutdown
 * without their quit handlers, so locks outlive a restart, and by the next
 * start their PIDs can belong to other processes. A service took a stale hub
 * lock's PID 15 seconds after boot and kept the hub from starting.
 */
export interface LockOwnerProbe {
  alive(pid: number): boolean;
  /** See `readProcessIdentity`: a token for the process now using `pid`, `gone`, or null when unknown. */
  identity(pid: number): ProcessIdentity | 'gone' | null;
}

export const systemLockOwnerProbe: LockOwnerProbe = { alive: processAlive, identity: readProcessIdentity };

/**
 * Records written before identities (Cats Bot 0.5.4 and earlier) are judged by
 * time on Windows, where the creation time is known: a process created this
 * long after the record cannot have written it. The margin absorbs a clock
 * step between a writer's start and its record; restarts are far longer.
 */
const LEGACY_SLACK_MS = 60_000;
const ownStartedAt = Date.now() - process.uptime() * 1000;

/** Who wrote a record: the writer's identity when it stored one, and when it was written. */
export interface RecordWriter {
  identity?: unknown;
  /** ms since the epoch; only records without an identity use it. */
  writtenAt?: number;
}

/**
 * Whether the process now using `pid` is the one that wrote a record. An
 * identity that differs, or no process at all, means the writer is gone.
 * When this system cannot tell, the record stands, as a live PID did before.
 */
export function processStillOwns(pid: number, writer: RecordWriter, probe: LockOwnerProbe = systemLockOwnerProbe): boolean {
  if (!probe.alive(pid)) return false;
  const current = probe.identity(pid);
  if (current === 'gone') return false;
  if (current === null) return true;
  if (typeof writer.identity === 'string') return writer.identity === current;
  if (writer.writtenAt === undefined || !Number.isFinite(writer.writtenAt)) return true;
  // An old record naming this process's PID was written by an earlier process.
  if (pid === process.pid) return writer.writtenAt >= ownStartedAt - LEGACY_SLACK_MS;
  const created = identityCreatedAt(current);
  return created === null || created <= writer.writtenAt + LEGACY_SLACK_MS;
}

interface LockRecord { pid: number; host: string; startedAt?: unknown; identity?: unknown }

/** Whether a lock file's record names a process on this host that still holds it. */
export function lockOwnerHolds(record: LockRecord, probe: LockOwnerProbe = systemLockOwnerProbe): boolean {
  if (typeof record !== 'object' || record === null || record.host !== hostname()) return false;
  return processStillOwns(record.pid, {
    identity: record.identity,
    writtenAt: typeof record.startedAt === 'string' ? Date.parse(record.startedAt) : undefined,
  }, probe);
}

export function acquireInstanceLock(paths: BotPaths, pid: number = process.pid): LockResult {
  return acquireLockFile<InstanceLock>(paths.lock, { pid, host: hostname(), startedAt: new Date().toISOString() });
}

function readRaw(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseRecord<T>(raw: string): T | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null ? value as T : null;
  } catch {
    return null;
  }
}

/**
 * A lock file that names the process holding it on this host, and that
 * process's identity, created exclusively. A file whose process is gone (see
 * `lockOwnerHolds`), or that cannot be read, is replaced, but only while it
 * still holds what was judged, so a lock another process wrote meanwhile is
 * never removed; `release` removes the file only while it still names this
 * process. The instance lock (SPEC-001 FR-3), the hub's root lock (SPEC-008
 * FR-1) and the registry's write lock are such files.
 */
export function acquireLockFile<T extends LockRecord>(
  file: string,
  record: T,
  probe: LockOwnerProbe = systemLockOwnerProbe,
): { held: true; release: () => void } | { held: false; owner: T } {
  mkdirSync(dirname(file), { recursive: true });
  const identity = record.identity === undefined ? probe.identity(record.pid) : record.identity;
  const written = typeof identity === 'string' ? { ...record, identity } : record;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(file, `${JSON.stringify(written, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return {
        held: true,
        release: () => {
          const current = readJsonFile<T>(file);
          if (current.ok && current.value.pid === record.pid) {
            rmSync(file, { force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const raw = readRaw(file);
    if (raw === null) continue;
    const existing = parseRecord<T>(raw);
    if (existing && lockOwnerHolds(existing, probe)) {
      return { held: false, owner: existing };
    }
    // Stale or unreadable, so the lock is ours to replace, unless another
    // process replaced it while it was judged.
    if (readRaw(file) !== raw) continue;
    rmSync(file, { force: true });
  }
  throw new Error(`Could not acquire the lock at ${file}`);
}

/** The process holding a lock file on this host, or null when it is free or stale. */
export function readLockFile<T extends LockRecord>(
  file: string,
  probe: LockOwnerProbe = systemLockOwnerProbe,
): T | null {
  const raw = readRaw(file);
  const existing = raw === null ? null : parseRecord<T>(raw);
  return existing && lockOwnerHolds(existing, probe) ? existing : null;
}

export function readInstanceLock(paths: BotPaths, probe: LockOwnerProbe = systemLockOwnerProbe): InstanceLock | null {
  return readLockFile<InstanceLock>(paths.lock, probe);
}

/** Orders handoffs written by one process within the same millisecond. */
let handoffSequence = 0;

/** The second instance drops its request here; the running core picks it up. */
export function writeHandoff(paths: BotPaths, message: Omit<HandoffMessage, 'id' | 'at'>): HandoffMessage {
  mkdirSync(paths.handoff, { recursive: true });
  const full: HandoffMessage = { id: randomUUID(), at: new Date().toISOString(), ...message };
  handoffSequence += 1;
  const name = `${full.at.replace(/[:.]/gu, '-')}-${String(handoffSequence).padStart(6, '0')}-${full.id}.json`;
  writeJsonAtomic(join(paths.handoff, name), full);
  return full;
}

/** Drains pending handoff files in arrival order; each file is removed once read. */
export function takeHandoffs(paths: BotPaths): HandoffMessage[] {
  let names: string[];
  try {
    names = readdirSync(paths.handoff).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const messages: HandoffMessage[] = [];
  for (const name of names) {
    const file = join(paths.handoff, name);
    try {
      messages.push(JSON.parse(readFileSync(file, 'utf8')) as HandoffMessage);
    } catch {
      // A torn or foreign file is dropped rather than retried forever.
    }
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
  return messages;
}
