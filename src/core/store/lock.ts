import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

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
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireInstanceLock(paths: BotPaths, pid: number = process.pid): LockResult {
  mkdirSync(paths.root, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lock: InstanceLock = { pid, host: hostname(), startedAt: new Date().toISOString() };
    try {
      writeFileSync(paths.lock, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return {
        held: true,
        release: () => {
          const current = readJsonFile<InstanceLock>(paths.lock);
          if (current.ok && current.value.pid === pid) {
            rmSync(paths.lock, { force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = readJsonFile<InstanceLock>(paths.lock);
    if (existing.ok && existing.value.host === hostname() && processAlive(existing.value.pid)) {
      return { held: false, owner: existing.value };
    }
    // Stale or unreadable: the owner is gone, so the lock is ours to replace.
    rmSync(paths.lock, { force: true });
  }
  throw new Error(`Could not acquire the instance lock at ${paths.lock}`);
}

export function readInstanceLock(paths: BotPaths): InstanceLock | null {
  const existing = readJsonFile<InstanceLock>(paths.lock);
  if (!existing.ok) return null;
  return existing.value.host === hostname() && processAlive(existing.value.pid) ? existing.value : null;
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
