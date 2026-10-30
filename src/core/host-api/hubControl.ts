import { createServer, request, type Server } from 'node:http';

import { hubPathsFor } from '../store/paths.ts';
import { isToken, newLocalSocket, newToken, readDescriptor, removeDescriptor, removeSocket, restrictSocket, tokenMatches, writeDescriptor } from './endpoint.ts';

/**
 * SPEC-008 FR-25: the hub's own control endpoint under `<CATS_BOT_HOME>`,
 * with owner control's transport, token and account rules (FR-12). Owner CLI
 * commands that act on the hub go through it while the hub runs; without a
 * running hub they refuse instead of writing the registry themselves.
 */

interface HubDescriptor { version: 1; socket: string; token: string; pid: number; installationId: string }

const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** A refusal whose message the owner may read, such as the bot cap. */
export class HubControlRefusal extends Error {}

export type HubControlHandler = (body: Record<string, unknown>) => unknown;

export class HubControlServer {
  private server: Server | null = null;
  private readonly file: string;
  private readonly descriptor: HubDescriptor;
  private readonly handlers: Record<string, HubControlHandler>;

  constructor(home: string, installationId: string, handlers: Record<string, HubControlHandler>) {
    this.file = hubPathsFor(home).control;
    this.handlers = handlers;
    this.descriptor = { version: 1, socket: newLocalSocket('cats-bot-hub'), token: newToken(), pid: process.pid, installationId };
  }

  async start(): Promise<void> {
    const server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      if (!tokenMatches(req.headers.authorization ?? '', `Bearer ${this.descriptor.token}`)) {
        res.writeHead(401).end('{"error":"Unauthorized"}');
        return;
      }
      try {
        if (req.method !== 'POST' || req.url !== '/control') throw new HubControlRefusal('Unsupported hub request.');
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > MAX_REQUEST_BYTES) throw new HubControlRefusal('The hub request exceeds its size limit.');
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HubControlRefusal('Invalid hub request.');
        const operation = (body as Record<string, unknown>).operation;
        const handler = typeof operation === 'string' && Object.hasOwn(this.handlers, operation) ? this.handlers[operation] : undefined;
        if (!handler) throw new HubControlRefusal('Unsupported hub operation.');
        res.end(JSON.stringify((await handler(body as Record<string, unknown>)) ?? null));
      } catch (error) {
        // Only deliberate refusals say why; anything else stays generic.
        const message = error instanceof HubControlRefusal ? error.message : 'The hub could not complete the request.';
        res.writeHead(409).end(JSON.stringify({ error: message }));
      }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.descriptor.socket, () => {
          server.off('error', reject);
          server.on('error', () => undefined);
          resolve();
        });
      });
      restrictSocket(this.descriptor.socket);
      writeDescriptor(this.file, this.descriptor);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    removeDescriptor(this.file, this.descriptor.token);
    removeSocket(this.descriptor.socket);
  }
}

export class HubNotRunningError extends Error {
  constructor() {
    super('No Cats Bot hub is running for this data root; start Cats Bot first.');
    this.name = 'HubNotRunningError';
  }
}

/** The hub refused the request; the message is the hub's own. */
export class HubControlRejectedError extends Error {}

export async function callHubControl(home: string, body: Record<string, unknown>): Promise<unknown> {
  let descriptor: Record<string, unknown>;
  try {
    descriptor = readDescriptor(hubPathsFor(home).control);
  } catch {
    throw new HubNotRunningError();
  }
  if (descriptor.version !== 1 || typeof descriptor.socket !== 'string' || !isToken(descriptor.token)) {
    throw new Error('The running hub speaks another control version.');
  }
  const { socket, token } = descriptor as unknown as HubDescriptor;
  const data = JSON.stringify(body);
  if (Buffer.byteLength(data) > MAX_REQUEST_BYTES) throw new Error('The hub request exceeds its size limit.');
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: socket, method: 'POST', path: '/control',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, (res) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          res.destroy();
          reject(new Error('The hub response is too large.'));
        } else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(new Error('Invalid hub response.'));
          return;
        }
        if (res.statusCode === 200) resolve(parsed);
        else {
          const message = (parsed as { error?: unknown } | null)?.error;
          reject(new HubControlRejectedError(typeof message === 'string' ? message : 'The hub refused the request.'));
        }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('The hub request timed out.')), 20_000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (error: NodeJS.ErrnoException) => {
      // A descriptor left by a hub that is gone.
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EPIPE' ? new HubNotRunningError() : error);
    });
    req.end(data);
  });
}
