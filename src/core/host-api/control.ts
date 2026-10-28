import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotHostApi, BotInteractionResponse } from '../types.ts';

interface Descriptor { version: 1; socket: string; token: string; pid: number }
const MAX_REQUEST_BYTES = 40_960;
const descriptorFile = (root: string) => join(root, 'host-control.json');

/** Local owner control, outside the model turn queue. Secrets never use file handoffs. */
export class HostControlServer {
  private server: Server | null = null;
  private readonly root: string;
  private readonly api: BotHostApi;
  private readonly descriptor: Descriptor;
  constructor(root: string, api: BotHostApi) {
    this.root = root;
    this.api = api;
    const name = `cats-bot-${randomUUID()}`;
    this.descriptor = { version: 1, pid: process.pid, token: randomBytes(32).toString('hex'),
      socket: process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`) };
  }
  async start(): Promise<void> {
    const server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      const auth = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${this.descriptor.token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        res.writeHead(401).end('{"error":"Unauthorized"}'); return;
      }
      try {
        if (req.method !== 'POST' || req.url !== '/control') throw new Error('Unsupported control request.');
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > MAX_REQUEST_BYTES) throw new Error('Control request exceeds its size limit.');
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (!body || typeof body.conversationId !== 'string' || !body.conversationId || body.conversationId.length > 200) {
          throw new Error('Invalid conversation.');
        }
        let result: unknown;
        switch (body.operation) {
          case 'interactions': result = await this.api.providerInteractions(body.conversationId); break;
          case 'capabilities': result = await this.api.sessionCapabilities(body.conversationId, body.refresh === true); break;
          case 'respond':
            if (typeof body.interactionId !== 'string' || !body.interactionId) throw new Error('Invalid interaction.');
            await this.api.respondProviderInteraction(body.conversationId, body.interactionId, body.response as BotInteractionResponse);
            result = { accepted: true }; break;
          default: throw new Error('Unsupported control operation.');
        }
        res.end(JSON.stringify(result));
      } catch {
        // No raw input, provider error, or secret answer in the response/log.
        res.writeHead(409).end('{"error":"Control request failed; refresh the live request and check its identity and answer."}');
      }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.descriptor.socket, () => { server.off('error', reject); resolve(); });
      });
      if (process.platform !== 'win32') chmodSync(this.descriptor.socket, 0o600);
      const file = descriptorFile(this.root);
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(this.descriptor), { mode: 0o600, flag: 'wx' });
        renameSync(temp, file);
      } finally { rmSync(temp, { force: true }); }
    } catch (error) { await this.stop(); throw error; }
  }
  async stop(): Promise<void> {
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server = null;
    }
    try {
      const current = JSON.parse(readFileSync(descriptorFile(this.root), 'utf8')) as Descriptor;
      if (current.token === this.descriptor.token) rmSync(descriptorFile(this.root), { force: true });
    } catch { /* Absent descriptor after failed start. */ }
    if (process.platform !== 'win32') rmSync(this.descriptor.socket, { force: true });
  }
}

export async function callHostControl(root: string, body: Record<string, unknown>): Promise<unknown> {
  const descriptor = JSON.parse(readFileSync(descriptorFile(root), 'utf8')) as Descriptor;
  if (descriptor.version !== 1 || typeof descriptor.socket !== 'string' || !/^[a-f0-9]{64}$/u.test(descriptor.token)) {
    throw new Error('No compatible live Bot control endpoint.');
  }
  const data = JSON.stringify(body);
  if (Buffer.byteLength(data) > MAX_REQUEST_BYTES) throw new Error('Control request exceeds its size limit.');
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: descriptor.socket, method: 'POST', path: '/control',
      headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' } }, res => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { res.destroy(); reject(new Error('Control response too large.')); }
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('Control request rejected. Refresh the live interaction before retrying.')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid control response.')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Bot control request timed out.')), 20_000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(data);
  });
}
