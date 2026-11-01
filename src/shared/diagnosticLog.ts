import {
  appendFileSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const LOG_MAX_BYTES = 256 * 1024;
export const LOG_BACKUPS = 3;
export const LOG_ENTRY_BYTES = 16 * 1024;

/** Bounded UTF-8 records; a giant error cannot bypass rotation's disk budget. */
export function boundedText(text: string, bytes: number): string {
  const data = Buffer.from(text);
  if (data.length <= bytes) return text;
  const suffix = '\n[truncated]\n';
  let end = Math.max(0, bytes - Buffer.byteLength(suffix));
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8') + suffix;
}

export interface LogLimits {
  maxBytes?: number;
  backups?: number;
}

/** Older versions had unbounded core.log; retain only its newest bytes on first use. */
export function trimLegacyLog(file: string, maxBytes: number): void {
  let fd: number | undefined;
  try {
    if (statSync(file).size <= maxBytes) return;
    fd = openSync(file, 'r+');
    const size = fstatSync(fd).size;
    if (size <= maxBytes) return;
    const data = Buffer.alloc(maxBytes);
    const length = readSync(fd, data, 0, data.length, size - data.length);
    let start = 0;
    while (start < length && (data[start]! & 0xc0) === 0x80) start++;
    writeSync(fd, data, start, length - start, 0);
    ftruncateSync(fd, length - start);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One process owns each file. Failures must never interrupt the Bot. */
export function createLogWriter(file: string, options: LogLimits = {}): (line: string) => void {
  const maxBytes = Math.max(64, options.maxBytes ?? LOG_MAX_BYTES);
  const backups = Math.max(0, Math.min(10, options.backups ?? LOG_BACKUPS));
  let initialized = false;
  return (line) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (!initialized) {
        for (let n = 0; n <= backups; n++) trimLegacyLog(n === 0 ? file : `${file}.${n}`, maxBytes);
        initialized = true;
      }
      const entry = boundedText(line, Math.min(maxBytes, LOG_ENTRY_BYTES));
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        /* first record */
      }
      if (size + Buffer.byteLength(entry) > maxBytes) {
        if (backups === 0) rmSync(file, { force: true });
        else {
          rmSync(`${file}.${backups}`, { force: true });
          for (let n = backups - 1; n >= 1; n--) {
            try {
              renameSync(`${file}.${n}`, `${file}.${n + 1}`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
          try {
            renameSync(file, `${file}.1`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
      appendFileSync(file, entry, { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* unavailable disk, permissions and mirror failures are non-fatal */
    }
  };
}

/** Do not persist arbitrary exception messages: they may quote a prompt or a credential. */
export function diagnosticError(error: unknown): string {
  if (!(error instanceof Error)) return `non-Error (${typeof error})`;
  const name = /^[A-Za-z][A-Za-z0-9_.]{0,79}$/u.test(error.name) ? error.name : 'Error';
  const code = (error as NodeJS.ErrnoException).code;
  const safeCode =
    typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? ` code=${code}` : '';
  // Only frame locations, never the message, function arguments or source excerpts.
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /u.test(line))
    .map(
      (line) => line.match(/(?:\()?((?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*?:\d+:\d+)\)?$/u)?.[1],
    )
    .filter((frame): frame is string => Boolean(frame))
    .slice(0, 12);
  return `${name}${safeCode}${frames.map((frame) => `\n    at ${frame}`).join('')}`;
}
