import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SPEC-001 FR-3 / FR-4: every write goes to a temporary file in the same
 * directory and is renamed into place, so a reader never sees a torn file and
 * a crash never leaves an empty one. Reads never write back.
 */

export type JsonReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'corrupt'; error: string };

export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, data, { encoding: 'utf8' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonFile<T>(path: string): JsonReadResult<T> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'missing' };
    }
    return { ok: false, reason: 'corrupt', error: describeError(error) };
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return { ok: false, reason: 'corrupt', error: describeError(error) };
  }
}

/** Appends one JSON line. Appends are atomic enough for a single writer (FR-3). */
export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8' });
}

/** Reads every parseable JSON line; a corrupt tail line is reported, not fatal. */
export function readJsonLines<T>(path: string): { entries: T[]; corruptLines: number } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], corruptLines: 0 };
    }
    throw error;
  }
  const entries: T[] = [];
  let corruptLines = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as T);
    } catch {
      corruptLines += 1;
    }
  }
  return { entries, corruptLines };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
