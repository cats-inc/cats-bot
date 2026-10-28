import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { RuntimeMcpServer } from '../runtime/client.ts';

/**
 * SPEC-001 FR-24: the bot's own tools, served to the provider CLI as a session
 * MCP server. cats-runtime only accepts Streamable HTTP servers on loopback,
 * so this is a minimal JSON-RPC-over-HTTP endpoint: `initialize`,
 * `notifications/initialized`, `ping`, `tools/list`, `tools/call`. One server
 * per bot; the conversation that owns a session is encoded in the URL path, so
 * each session gets its own descriptor. SPEC-006 BDC-06 serves `cats-desktop`
 * with the same class under its own name, with a token per conversation that
 * `authorize` checks, and with image and structured results.
 */

export const MCP_SERVER_NAME = 'cats-bot';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_BYTES = 256 * 1024;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallContext {
  conversationId: string;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolCallResult {
  text: string;
  isError?: boolean;
  /** Replaces the default single text item, for example to return an image. */
  content?: ToolContent[];
  structuredContent?: Record<string, unknown>;
}

export interface ToolHandlers {
  list(): ToolDefinition[];
  call(name: string, args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult>;
}

export interface BotToolServerOptions {
  handlers: ToolHandlers;
  serverVersion: string;
  /** The MCP server name; defaults to `cats-bot`. */
  name?: string;
  /** MCP `initialize` instructions. */
  instructions?: string;
  host?: string;
  token?: string;
  /** Replaces the single server token: whether `token` may call tools of `conversationId`. */
  authorize?(conversationId: string, token: string): boolean;
  maxBodyBytes?: number;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export class BotToolServer {
  readonly token: string;
  private readonly options: BotToolServerOptions;
  private server: Server | null = null;
  private port = 0;

  constructor(options: BotToolServerOptions) {
    this.options = options;
    this.token = options.token ?? randomBytes(24).toString('base64url');
  }

  get url(): string | null {
    return this.port ? `http://${this.options.host ?? '127.0.0.1'}:${this.port}/mcp` : null;
  }

  get name(): string {
    return this.options.name ?? MCP_SERVER_NAME;
  }

  /** The `mcpServers` descriptor for a session of `conversationId`. */
  descriptorFor(conversationId: string, token = this.token): RuntimeMcpServer[] {
    if (!this.url) return [];
    return [{
      name: this.name,
      transport: 'http',
      url: `${this.url}/${encodeURIComponent(conversationId)}`,
      auth: { kind: 'bearer_env', token },
    }];
  }

  async start(): Promise<void> {
    if (this.server) return;
    const host = this.options.host ?? '127.0.0.1';
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
    server.unref();
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/mcp(?:\/([^/]+))?\/?$/u.exec(url.pathname);
    if (!match) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    let conversationId: string;
    try {
      conversationId = match[1] ? decodeURIComponent(match[1]) : 'home';
    } catch {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const authorized = this.options.authorize
      ? header.startsWith('Bearer ') && this.options.authorize(conversationId, header.slice('Bearer '.length))
      : header === `Bearer ${this.token}`;
    if (!authorized) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'GET') {
      // No server-initiated stream: the CLI only needs request/response.
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req, this.options.maxBodyBytes ?? MAX_BODY_BYTES));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const batch = Array.isArray(parsed);
    const requests = (batch ? parsed : [parsed]) as JsonRpcRequest[];
    const responses: unknown[] = [];
    for (const request of requests) {
      const response = await this.dispatch(request, { conversationId });
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, batch ? responses : responses[0]);
  }

  private async dispatch(request: JsonRpcRequest, context: ToolCallContext): Promise<unknown> {
    const id = request.id ?? null;
    const method = request.method ?? '';
    const isNotification = request.id === undefined || method.startsWith('notifications/');
    const reply = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const requested = typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '';
        return reply({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: this.options.serverVersion },
          ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: this.options.handlers.list() });
      case 'tools/call': {
        const name = typeof request.params?.name === 'string' ? request.params.name : '';
        const args = typeof request.params?.arguments === 'object' && request.params.arguments !== null
          ? (request.params.arguments as Record<string, unknown>)
          : {};
        if (!this.options.handlers.list().some((tool) => tool.name === name)) {
          return fail(-32602, `Unknown tool ${name}`);
        }
        try {
          const result = await this.options.handlers.call(name, args, context);
          return reply({
            content: result.content ?? [{ type: 'text', text: result.text }],
            ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
            ...(result.isError ? { isError: true } : {}),
          });
        } catch (error) {
          return reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }
}
