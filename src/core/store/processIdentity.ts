import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * A token naming one process for as long as it runs, which no later process
 * with the same PID shares. Lock files and update leases store their writer's
 * token, so a record left by a process that ended (Windows ends programs at
 * shutdown without their quit handlers) is told apart from a live writer even
 * when another process took the PID. No clock is read after the process
 * starts, so a clock step cannot change the answer.
 *
 * - Windows: the creation FILETIME, from `GetProcessTimes` or, for processes
 *   this account cannot open (services), from the system process list.
 * - Linux: the boot id and the start time in clock ticks since boot.
 * - macOS: the start time `ps` reports, in UTC.
 *
 * `gone` means no process uses the PID; null means it cannot be told here,
 * and callers then keep the record as before.
 */
export type ProcessIdentity = string;

const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const STATUS_INFO_LENGTH_MISMATCH = -1_073_741_820;
const SYSTEM_PROCESS_INFORMATION = 5;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

interface Win32Api {
  /** Through a handle; null when this account cannot open the process. */
  opened(pid: number): bigint | null;
  /** Every process's creation time, from one system snapshot. */
  snapshot(): Map<number, bigint> | null;
}

let win32: Win32Api | null | undefined;
let snapshotTrusted: boolean | undefined;

function loadWin32(): Win32Api | null {
  if (win32 !== undefined) return win32;
  win32 = null;
  try {
    const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    const ntdll = koffi.load('ntdll.dll');
    const openProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
    const getProcessTimes = kernel32.func('bool __stdcall GetProcessTimes(intptr_t process, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)');
    const closeHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t handle)');
    const querySystem = ntdll.func('int32_t __stdcall NtQuerySystemInformation(int32_t kind, void *buffer, uint32_t length, _Out_ uint32_t *needed)');
    win32 = {
      opened(pid) {
        const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) as number | bigint;
        if (!handle) return null;
        try {
          const creation: unknown[] = [0];
          const ignored: unknown[] = [0];
          if (!getProcessTimes(handle, creation, [0], ignored, [0])) return null;
          return BigInt(creation[0] as number | bigint);
        } finally {
          closeHandle(handle);
        }
      },
      snapshot() {
        // SYSTEM_PROCESS_INFORMATION on 64-bit Windows: NextEntryOffset at 0,
        // CreateTime at 32, UniqueProcessId at 80.
        if (process.arch !== 'x64' && process.arch !== 'arm64') return null;
        let size = 1 << 20;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const buffer = Buffer.alloc(size);
          const needed: unknown[] = [0];
          const status = querySystem(SYSTEM_PROCESS_INFORMATION, buffer, size, needed) as number;
          if (status === STATUS_INFO_LENGTH_MISMATCH) {
            size = Math.max(size * 2, Number(needed[0]) + 65_536);
            continue;
          }
          if (status !== 0) return null;
          const times = new Map<number, bigint>();
          for (let offset = 0; offset + 88 <= size;) {
            const next = buffer.readUInt32LE(offset);
            times.set(Number(buffer.readBigUInt64LE(offset + 80)), buffer.readBigInt64LE(offset + 32));
            if (next === 0) break;
            offset += next;
          }
          return times;
        }
        return null;
      },
    };
  } catch {
    win32 = null;
  }
  return win32;
}

function windowsIdentity(pid: number): ProcessIdentity | 'gone' | null {
  const api = loadWin32();
  if (!api) return null;
  const opened = api.opened(pid);
  return opened !== null ? `win:${opened}` : windowsSnapshotIdentity(pid);
}

/**
 * Windows, from the system process list, which needs no handle. Its layout is
 * not documented, so it is used only once it agrees with GetProcessTimes for
 * this process; exported so tests can compare the two.
 */
export function windowsSnapshotIdentity(pid: number): ProcessIdentity | 'gone' | null {
  const api = process.platform === 'win32' ? loadWin32() : null;
  if (!api) return null;
  if (snapshotTrusted === undefined) {
    const own = api.opened(process.pid);
    snapshotTrusted = own !== null && api.snapshot()?.get(process.pid) === own;
  }
  if (!snapshotTrusted) return null;
  const times = api.snapshot();
  if (!times) return null;
  const created = times.get(pid);
  return created === undefined ? 'gone' : `win:${created}`;
}

let bootId: string | null | undefined;

function linuxIdentity(pid: number): ProcessIdentity | 'gone' | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : null;
  }
  if (bootId === undefined) {
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    } catch {
      bootId = null;
    }
  }
  // Field 22, counted from field 3 after the command name's closing parenthesis.
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return bootId && startTicks && /^\d+$/u.test(startTicks) ? `linux:${bootId}:${startTicks}` : null;
}

/** `attachOrStartCore` reads a lock every 100 ms; `ps` is spared that pace. */
const darwinMemo = new Map<number, { value: ProcessIdentity | 'gone' | null; at: number }>();

function darwinIdentity(pid: number): ProcessIdentity | 'gone' | null {
  const memo = darwinMemo.get(pid);
  if (memo && Date.now() - memo.at < 500) return memo.value;
  let value: ProcessIdentity | 'gone' | null = null;
  try {
    const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC0', LC_ALL: 'C' },
    });
    const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (!result.error) value = output ? `darwin:${output}` : result.status === 1 ? 'gone' : null;
  } catch {
    value = null;
  }
  darwinMemo.set(pid, { value, at: Date.now() });
  return value;
}

/** The identity of the process now using `pid`. */
export function readProcessIdentity(pid: number): ProcessIdentity | 'gone' | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') return windowsIdentity(pid);
  if (process.platform === 'linux') return linuxIdentity(pid);
  if (process.platform === 'darwin') return darwinIdentity(pid);
  return null;
}

let own: ProcessIdentity | null | undefined;

/** This process's identity, read once. */
export function ownProcessIdentity(): ProcessIdentity | null {
  if (own === undefined) {
    const value = readProcessIdentity(process.pid);
    own = value === 'gone' ? null : value;
  }
  return own;
}

/** When the process was created, in ms since the epoch, for identities that carry it (Windows). */
export function identityCreatedAt(identity: ProcessIdentity): number | null {
  const match = /^win:(\d+)$/u.exec(identity);
  return match ? Number((BigInt(match[1]!) - FILETIME_UNIX_EPOCH) / 10_000n) : null;
}
