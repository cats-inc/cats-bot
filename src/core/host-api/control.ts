import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import type { BotHostApi, BotInteractionResponse } from '../types.ts';
import { isToken, newLocalSocket, newToken, readDescriptor, removeDescriptor, removeSocket, restrictSocket, tokenMatches, writeDescriptor } from './endpoint.ts';

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
    this.descriptor = { version: 1, pid: process.pid, token: newToken(), socket: newLocalSocket('cats-bot') };
  }
  async start(): Promise<void> {
    const server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      const auth = req.headers.authorization ?? '';
      if (!tokenMatches(auth, `Bearer ${this.descriptor.token}`)) {
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
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> | null;
        // Stopping desktop control everywhere (`desktop_stop` with `all`) is the only operation without a conversation.
        const everyConversation = body?.operation === 'desktop_stop' && body.all === true;
        if (!body || (!everyConversation
          && (typeof body.conversationId !== 'string' || !body.conversationId || body.conversationId.length > 200))) {
          throw new Error('Invalid conversation.');
        }
        const conversationId = body.conversationId as string;
        let result: unknown;
        switch (body.operation) {
          case 'interactions': result = await this.api.providerInteractions(conversationId); break;
          case 'capabilities': result = await this.api.sessionCapabilities(conversationId, body.refresh === true); break;
          case 'respond':
            if (typeof body.interactionId !== 'string' || !body.interactionId) throw new Error('Invalid interaction.');
            await this.api.respondProviderInteraction(conversationId, body.interactionId, body.response as BotInteractionResponse);
            result = { accepted: true }; break;
          // SPEC-006 BDC-07 / BDC-10: desktop control has its own operations; `respond` never answers a grant.
          case 'desktop_state': result = await this.api.desktopControlState(conversationId); break;
          case 'desktop_switch':
            if (typeof body.enabled !== 'boolean') throw new Error('Invalid switch.');
            result = await this.api.setConversationDesktopControl(conversationId, body.enabled); break;
          case 'desktop_grant':
            if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 200
              || (body.decision !== 'allow' && body.decision !== 'deny')) throw new Error('Invalid grant answer.');
            await this.api.respondDesktopGrant(conversationId, body.requestId, body.decision);
            result = await this.api.desktopControlState(conversationId); break;
          case 'desktop_stop':
            await this.api.stopDesktopControl(everyConversation ? undefined : conversationId);
            result = await this.api.desktopControlState(everyConversation ? undefined : conversationId); break;
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
        server.listen(this.descriptor.socket, () => {
          server.off('error', reject);
          // A failed accept (for example no file descriptors left) leaves the server listening.
          server.on('error', () => undefined);
          resolve();
        });
      });
      restrictSocket(this.descriptor.socket);
      writeDescriptor(descriptorFile(this.root), this.descriptor);
    } catch (error) { await this.stop(); throw error; }
  }
  async stop(): Promise<void> {
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server = null;
    }
    removeDescriptor(descriptorFile(this.root), this.descriptor.token);
    removeSocket(this.descriptor.socket);
  }
}

/** The live Bot refused the request (an unknown or answered id, a bad answer); it says no more on purpose. */
export class HostControlRejectedError extends Error {}

export async function callHostControl(root: string, body: Record<string, unknown>): Promise<unknown> {
  const descriptor = readDescriptor(descriptorFile(root));
  if (descriptor.version !== 1 || typeof descriptor.socket !== 'string' || !isToken(descriptor.token)) {
    throw new Error('No compatible live Bot control endpoint.');
  }
  const { socket, token } = descriptor as unknown as Descriptor;
  const data = JSON.stringify(body);
  if (Buffer.byteLength(data) > MAX_REQUEST_BYTES) throw new Error('Control request exceeds its size limit.');
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: 'POST', path: '/control',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { res.destroy(); reject(new Error('Control response too large.')); }
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new HostControlRejectedError('Control request rejected. Refresh the live interaction before retrying.')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid control response.')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Bot control request timed out.')), 20_000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(data);
  });
}
