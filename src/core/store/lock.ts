import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, uptime } from 'node:os';
import { dirname, join } from 'node:path';

import type { HandoffMessage } from '../types.ts';
import { readJsonFile, writeJsonAtomic } from './atomicFile.ts';
import type { BotPaths } from './paths.ts';

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
  /** When the process now using `pid` was created, in ms since the epoch; `gone` when none does; null when unknown. */
  createdAt(pid: number): number | 'gone' | null;
  /** When the system last booted, in ms since the epoch. */
  bootedAt(): number;
}

/** A writer records its time after it starts; this covers rounding and a small clock step in between. */
const CREATED_SLACK_MS = 2_000;
/** A wall-clock step after a lock was written moves the computed boot time by as much. */
const BOOT_MARGIN_MS = 5 * 60_000;
/** A process creation time is asked again after this, in case its PID was reused unseen. */
const CREATED_CACHE_MS = 10 * 60_000;

const ownStartedAt = Date.now() - process.uptime() * 1000;
const createdCache = new Map<number, { value: number; at: number }>();

/**
 * Windows: one hidden PowerShell asks CIM, which also answers for processes
 * of other accounts. It runs only for a PID that is alive and not this
 * process, so only on a real or suspected conflict, and takes about a second.
 */
function windowsProcessCreatedAt(pid: number): number | 'gone' | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; `
    + `if ($p) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() } else { 'gone' }`;
  try {
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const output = result.status === 0 ? result.stdout.trim() : '';
    if (output === 'gone') return 'gone';
    return /^\d{12,15}$/u.test(output) ? Number(output) : null;
  } catch {
    return null;
  }
}

/**
 * Creation times are read on Windows, where PIDs are reused soonest and Fast
 * Startup keeps the boot time across a shutdown. Elsewhere a restart is
 * caught by the boot time, and reuse within one boot is far rarer.
 */
export const systemLockOwnerProbe: LockOwnerProbe = {
  alive(pid) {
    const alive = processAlive(pid);
    if (!alive) createdCache.delete(pid);
    return alive;
  },
  createdAt(pid) {
    if (process.platform !== 'win32') return null;
    const cached = createdCache.get(pid);
    if (cached && Date.now() - cached.at < CREATED_CACHE_MS) return cached.value;
    const value = windowsProcessCreatedAt(pid);
    if (typeof value === 'number') createdCache.set(pid, { value, at: Date.now() });
    else createdCache.delete(pid);
    return value;
  },
  bootedAt: () => Date.now() - uptime() * 1000,
};

/**
 * Whether the process now using `pid` is the one that wrote a record at
 * `writtenAt` (ms since the epoch). A process created after the record, or a
 * record from before the last boot, names a process that is gone.
 */
export function processStillOwns(pid: number, writtenAt: number, probe: LockOwnerProbe = systemLockOwnerProbe): boolean {
  if (!probe.alive(pid)) return false;
  // A record without a time cannot be told apart from its writer, so it stands.
  if (!Number.isFinite(writtenAt)) return true;
  if (pid === process.pid) return writtenAt >= ownStartedAt - CREATED_SLACK_MS;
  const created = probe.createdAt(pid);
  if (created === 'gone') return false;
  // Both times were taken from the same clock before any later step, so this holds across one.
  if (created !== null) return created <= writtenAt + CREATED_SLACK_MS;
  return writtenAt >= probe.bootedAt() - BOOT_MARGIN_MS;
}

/** Whether a lock file's record names a process on this host that still holds it. */
export function lockOwnerHolds(record: { pid: number; host: string; startedAt?: unknown }, probe: LockOwnerProbe = systemLockOwnerProbe): boolean {
  if (typeof record !== 'object' || record === null || record.host !== hostname()) return false;
  return processStillOwns(record.pid, typeof record.startedAt === 'string' ? Date.parse(record.startedAt) : Number.NaN, probe);
}

export function acquireInstanceLock(paths: BotPaths, pid: number = process.pid): LockResult {
  return acquireLockFile<InstanceLock>(paths.lock, { pid, host: hostname(), startedAt: new Date().toISOString() });
}

/**
 * A lock file that names the process holding it on this host, created
 * exclusively. A file whose process is gone (see `lockOwnerHolds`), or that
 * cannot be read, is replaced; `release` removes the file only while it still
 * names this process. The instance lock (SPEC-001 FR-3) and the hub's root
 * lock (SPEC-008 FR-1) are such files.
 */
export function acquireLockFile<T extends { pid: number; host: string; startedAt?: unknown }>(
  file: string,
  record: T,
  probe: LockOwnerProbe = systemLockOwnerProbe,
): { held: true; release: () => void } | { held: false; owner: T } {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
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
    const existing = readJsonFile<T>(file);
    if (existing.ok && lockOwnerHolds(existing.value, probe)) {
      return { held: false, owner: existing.value };
    }
    // Stale or unreadable: the owner is gone, so the lock is ours to replace.
    rmSync(file, { force: true });
  }
  throw new Error(`Could not acquire the lock at ${file}`);
}

/** The process holding a lock file on this host, or null when it is free or stale. */
export function readLockFile<T extends { pid: number; host: string; startedAt?: unknown }>(
  file: string,
  probe: LockOwnerProbe = systemLockOwnerProbe,
): T | null {
  const existing = readJsonFile<T>(file);
  if (!existing.ok) return null;
  return lockOwnerHolds(existing.value, probe) ? existing.value : null;
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
