import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What the owner control endpoint and the host channel share (SPEC-008 FR-12):
 * a named pipe on Windows or a 0600 Unix socket elsewhere, a per-start random
 * token of 32 bytes, and a descriptor file readable by the current account only.
 */

/** A fresh local socket path; Unix paths stay short enough for macOS's 104-byte limit. */
export function newLocalSocket(prefix: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${prefix}-${randomUUID()}`
    : join(tmpdir(), `${prefix}-${randomBytes(8).toString('hex')}.sock`);
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function restrictSocket(socket: string): void {
  if (process.platform !== 'win32') chmodSync(socket, 0o600);
}

export function removeSocket(socket: string): void {
  if (process.platform !== 'win32') rmSync(socket, { force: true });
}

export function writeDescriptor(file: string, descriptor: object): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

export function readDescriptor(file: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!value || typeof value !== 'object') throw new Error('Invalid endpoint descriptor.');
  return value as Record<string, unknown>;
}

/** Removes the descriptor only while it still names this start's token. */
export function removeDescriptor(file: string, token: string): void {
  try {
    if (readDescriptor(file).token === token) rmSync(file, { force: true });
  } catch { /* Absent descriptor after a failed start. */ }
}
