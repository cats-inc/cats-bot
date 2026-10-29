import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * SPEC-008 FR-26: at most one bot controls the desktop at a time. The lease
 * is a local endpoint named for the OS account, which only one process can
 * listen on; the OS releases it when that process exits, however it ends.
 * Every core takes it itself, so a core another program hosts obeys it too.
 */

export interface DesktopLease {
  /** True when this process holds the lease now or just took it. */
  acquire(): Promise<boolean>;
  release(): void;
  readonly held: boolean;
}

/** The account's lease endpoint: a named pipe on Windows, a socket file elsewhere. */
export function desktopLeaseEndpoint(platform: NodeJS.Platform = process.platform): string {
  const account = createHash('sha256').update(`${userInfo().username}\0${homedir()}`).digest('hex').slice(0, 24);
  return platform === 'win32'
    ? `\\\\.\\pipe\\cats-bot-desktop-lease-${account}`
    : join(process.env.XDG_RUNTIME_DIR || tmpdir(), `cats-bot-desktop-lease-${account}.sock`);
}

export function createDesktopLease(endpoint: string = desktopLeaseEndpoint()): DesktopLease {
  let server: Server | null = null;
  let taking: Promise<boolean> | null = null;

  const listen = () => new Promise<Server | null>((resolve, reject) => {
    const candidate = createServer((socket) => socket.destroy());
    candidate.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    });
    candidate.listen(endpoint, () => {
      candidate.removeAllListeners('error');
      candidate.on('error', () => undefined);
      resolve(candidate);
    });
  });
  // A socket file left by a process that ended answers nobody; it is removed and taken.
  const stale = () => new Promise<boolean>((resolve) => {
    const probe = createConnection(endpoint);
    probe.once('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'));
  });

  const take = async (): Promise<boolean> => {
    let listening = await listen();
    if (!listening && process.platform !== 'win32' && await stale()) {
      rmSync(endpoint, { force: true });
      listening = await listen();
    }
    server = listening;
    return listening !== null;
  };

  return {
    get held() {
      return server !== null;
    },
    acquire() {
      if (server) return Promise.resolve(true);
      if (!taking) {
        taking = take().finally(() => {
          taking = null;
        });
      }
      return taking;
    },
    release() {
      const current = server;
      server = null;
      current?.close();
    },
  };
}
