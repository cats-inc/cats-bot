import {
  closeSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { LOG_MAX_BYTES, trimLegacyLog } from './diagnosticLog.ts';

/**
 * The host opens fd 2 with O_APPEND, then detaches. Keep that descriptor alive:
 * renaming the current file would leave stderr writing to the old inode.
 * The core snapshots a bounded tail and truncates in place once a second.
 */
export function rotateStderrLog(
  file: string,
  fd: number,
  force = false,
  maxBytes = LOG_MAX_BYTES,
): void {
  const previous = join(file, '..', 'core-stderr.previous.log');
  let maintenance: number | undefined;
  try {
    const descriptor = fstatSync(fd);
    const named = statSync(file);
    if (!descriptor.isFile() || descriptor.dev !== named.dev || descriptor.ino !== named.ino)
      return;
    trimLegacyLog(previous, maxBytes);
    if (descriptor.size === 0 || (!force && descriptor.size < maxBytes)) return;
    // Windows append-only handles cannot truncate. A separate r+ handle can;
    // verify it still identifies the same file before touching it.
    maintenance = openSync(file, 'r+');
    const current = fstatSync(maintenance);
    if (descriptor.dev !== current.dev || descriptor.ino !== current.ino) return;
    const tail = Buffer.alloc(Math.min(descriptor.size, maxBytes));
    const length = readSync(maintenance, tail, 0, tail.length, descriptor.size - tail.length);
    writeFileSync(previous, tail.subarray(0, length), { mode: 0o600 });
    ftruncateSync(maintenance, 0);
  } catch {
    /* a terminal, closed descriptor or unavailable disk is not fatal */
  } finally {
    if (maintenance !== undefined) {
      try {
        closeSync(maintenance);
      } catch {
        /* diagnostics remain best-effort */
      }
    }
  }
}

export function boundStderrLog(
  file: string,
  options: { fd?: number; maxBytes?: number; intervalMs?: number } = {},
) {
  const check = () =>
    rotateStderrLog(file, options.fd ?? 2, false, options.maxBytes ?? LOG_MAX_BYTES);
  const timer = setInterval(check, options.intervalMs ?? 1_000);
  timer.unref();
  return {
    check,
    stop: () => {
      clearInterval(timer);
      check();
    },
  };
}
