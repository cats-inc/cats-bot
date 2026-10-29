import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { AsyncSecretCipher } from '../secrets.ts';
import type { BotHostEvent } from '../types.ts';
import { isCoreCommand, runCoreCommand, type CoreCommandTarget } from './commands.ts';
import { isToken, newLocalSocket, newToken, readDescriptor, removeDescriptor, removeSocket, restrictSocket, tokenMatches, writeDescriptor } from './endpoint.ts';

/**
 * SPEC-008 FR-12 to FR-15: the host channel between a core and the host that
 * presents it (the shell, later the hub). Each host holds one duplex connection
 * carrying newline-delimited JSON frames:
 *
 * - `hello` / `welcome` / `refused`: the host proves the per-start token and
 *   the protocol version first; a mismatch is refused, never worked around.
 * - `req` / `res`: requests in both directions. Host to core carries the
 *   commands of `commands.ts`; core to host carries host services (the
 *   secret cipher, FR-20).
 * - `ev`: core events, numbered by a per-process sequence.
 *
 * Every `res` from the core carries the sequence number current when the
 * request started. A host that subscribed first applies only the events above
 * a snapshot's number (FR-13); events during the request may already be part
 * of the snapshot, so appliers are idempotent (upsert by id or entry `seq`).
 * A slow host is disconnected rather than sent a gap, so a host that
 * reconnects reads its snapshots again. Frames are size-bounded (a frame
 * before the hello to 64 KiB) and their bodies are never logged.
 */

export const CHANNEL_PROTOCOL = 1;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** A hello is small; an unauthenticated connection never buffers more. */
const MAX_HELLO_BYTES = 64 * 1024;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const CALL_TIMEOUT_MS = 120_000;

export const channelDescriptorFile = (root: string): string => join(root, 'host-channel.json');

export interface ChannelDescriptor {
  protocol: number;
  socket: string;
  token: string;
  pid: number;
  /** The installation id of the hub that started the core, or null (SPEC-008 FR-12). */
  manager: string | null;
  startedAt: string;
}

/** The attached host's process, for the desktop-control helper's self-exclusion (FR-21). */
export interface ChannelHostIdentity {
  pid: number;
  executable: string;
  installationId: string | null;
}

/** Host services a host offers its core (FR-20). */
export interface ChannelHostServices {
  cipher?: {
    label: string;
    encrypt(plain: string): Buffer | Promise<Buffer>;
    decrypt(data: Buffer): string | Promise<string>;
  };
}

export class ChannelError extends Error {
  readonly reason: string;
  constructor(message: string, reason = 'channel') {
    super(message);
    this.name = 'ChannelError';
    this.reason = reason;
  }
}

/** The core refused a request; the message is the core's own, never the request body. */
export class ChannelRemoteError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Splits a byte stream into newline-delimited JSON frames, refusing any frame above the limit. */
export class FrameReader {
  private parts: Buffer[] = [];
  private size = 0;
  private max: number;
  constructor(max = MAX_FRAME_BYTES) {
    this.max = max;
  }
  /** Raises or lowers the limit for later frames, for example after the hello. */
  limit(max: number): void {
    this.max = max;
  }
  push(chunk: Buffer): unknown[] {
    const frames: unknown[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      if (newline === -1) {
        if (start < chunk.length) {
          this.parts.push(chunk.subarray(start));
          this.size += chunk.length - start;
        }
        if (this.size > this.max) throw new ChannelError('A channel frame exceeds its size limit.', 'size');
        return frames;
      }
      const tail = chunk.subarray(start, newline);
      const size = this.size + tail.length;
      if (size > this.max) throw new ChannelError('A channel frame exceeds its size limit.', 'size');
      const line = this.parts.length ? Buffer.concat([...this.parts, tail], size) : tail;
      this.parts = [];
      this.size = 0;
      start = newline + 1;
      if (line.length === 0) continue;
      try {
        frames.push(JSON.parse(line.toString('utf8')));
      } catch {
        throw new ChannelError('Invalid channel frame.', 'frame');
      }
    }
  }
}

function encodeFrame(frame: Json): string {
  return `${JSON.stringify(frame)}\n`;
}

interface PendingRequest {
  resolve(frame: Json): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** One side of a connection: writing frames and matching responses to its own requests. */
class Peer {
  readonly socket: Socket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** Requests that timed out; a late answer to one is dropped instead of ending the connection. */
  private readonly expired = new Set<number>();
  constructor(socket: Socket) {
    this.socket = socket;
  }
  /** False when the frame was not sent; a peer that cannot keep up is disconnected. */
  write(line: string): boolean {
    if (this.socket.destroyed || !this.socket.writable) return false;
    if (this.socket.writableLength > MAX_BUFFERED_BYTES) {
      this.socket.destroy();
      return false;
    }
    this.socket.write(line);
    return true;
  }
  send(frame: Json): boolean {
    return this.write(encodeFrame(frame));
  }
  request(method: string, args: unknown[], timeoutMs: number): Promise<Json> {
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.expired.add(id);
        if (this.expired.size > 1024) this.expired.delete(this.expired.values().next().value!);
        reject(new ChannelError(`The channel request ${method} timed out.`, 'timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const line = encodeFrame({ t: 'req', id, m: method, a: args });
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        this.settle(id, null, new ChannelError('A channel request exceeds its size limit.', 'size'));
      } else if (!this.write(line)) {
        this.settle(id, null, new ChannelError('The channel is closed.', 'closed'));
      }
    });
  }
  /** A response to one of this side's requests; false for an id this side never sent. */
  receive(frame: Json): boolean {
    if (typeof frame.id !== 'number') return false;
    if (this.settle(frame.id, frame, null)) return true;
    return this.expired.delete(frame.id);
  }
  private settle(id: number, frame: Json | null, error: Error | null): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(frame!);
    return true;
  }
  close(): void {
    for (const [id] of [...this.pending]) this.settle(id, null, new ChannelError('The channel is closed.', 'closed'));
  }
}

function resultOf(frame: Json): unknown {
  if (frame.ok === true) return frame.v;
  const error = isJson(frame.e) ? frame.e : {};
  throw new ChannelRemoteError(
    typeof error.name === 'string' ? error.name : 'Error',
    typeof error.message === 'string' ? error.message : 'The request failed.',
  );
}

function errorFrame(id: number, error: unknown): Json {
  return {
    t: 'res', id, ok: false,
    e: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : 'The request failed.' },
  };
}

function parseHost(value: unknown): ChannelHostIdentity | null {
  if (!isJson(value)) return null;
  const { pid, executable, installationId } = value;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
  if (typeof executable !== 'string' || executable.length > 4096) return null;
  if (installationId !== null && (typeof installationId !== 'string' || installationId.length > 200)) return null;
  return { pid: pid as number, executable, installationId: installationId as string | null };
}

class HostConnection extends Peer {
  ready = false;
  refused = false;
  host: ChannelHostIdentity | null = null;
  cipherLabel: string | null = null;
  /**
   * Conversations this host shows. Their views close with its connection, so a
   * host that crashed leaves no note focused (FR-15: a host that reattaches
   * opens its views again). One presenting host shows a core's notes.
   */
  readonly views = new Set<string>();
}

export interface HostChannelServerOptions {
  /** The installation id of the hub that started this core (SPEC-008 FR-12). */
  manager?: string | null;
  /** How long a host-service request waits for a host offering the service. */
  hostRequestTimeoutMs?: number;
  /** Limits; the defaults suit production. */
  helloTimeoutMs?: number;
  maxFrameBytes?: number;
  /** Called when hosts attach or detach. */
  onHostsChanged?: (hosts: ChannelHostIdentity[]) => void;
}

export type ChannelTarget = CoreCommandTarget & { subscribe(listener: (event: BotHostEvent) => void): () => void };

/** The core's side of the host channel. */
export class HostChannelServer {
  private server: Server | null = null;
  private readonly root: string;
  private readonly target: ChannelTarget;
  private readonly options: HostChannelServerOptions;
  private readonly descriptor: ChannelDescriptor;
  private readonly connections = new Set<HostConnection>();
  private readonly hostWaiters = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private seq = 0;

  constructor(root: string, target: ChannelTarget, options: HostChannelServerOptions = {}) {
    this.root = root;
    this.target = target;
    this.options = options;
    this.descriptor = {
      protocol: CHANNEL_PROTOCOL, socket: newLocalSocket('cats-bot-ch'), token: newToken(),
      pid: process.pid, manager: options.manager ?? null, startedAt: new Date().toISOString(),
    };
  }

  get manager(): string | null {
    return this.descriptor.manager;
  }

  async start(): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
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
      this.unsubscribe = this.target.subscribe((event) => this.broadcast(event));
      writeDescriptor(channelDescriptorFile(this.root), this.descriptor);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const server = this.server;
    this.server = null;
    for (const connection of this.connections) {
      // End rather than destroy, so a response written just before (to quit) still arrives.
      connection.socket.end();
      setTimeout(() => connection.socket.destroy(), 1_000).unref?.();
    }
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const wake of [...this.hostWaiters]) wake();
    removeDescriptor(channelDescriptorFile(this.root), this.descriptor.token);
    removeSocket(this.descriptor.socket);
  }

  /** The hosts attached now (SPEC-008 FR-21). */
  hosts(): ChannelHostIdentity[] {
    return [...this.connections].filter((c) => c.ready && c.host).map((c) => c.host!);
  }

  /** A cipher an attached host serves under this label (SPEC-008 FR-20). */
  cipher(label: string): AsyncSecretCipher {
    const text = (value: unknown): string => {
      if (typeof value !== 'string') throw new ChannelError('The host answered its cipher with something other than text.', 'frame');
      return value;
    };
    return {
      label,
      encrypt: async (plain) => Buffer.from(text(await this.requestHost(label, 'cipher.encrypt', [plain])), 'base64'),
      decrypt: async (data) => text(await this.requestHost(label, 'cipher.decrypt', [data.toString('base64')])),
    };
  }

  /** The newest attached host offering the cipher, waiting for one to attach until the timeout. */
  private async requestHost(label: string, method: string, args: unknown[]): Promise<unknown> {
    const timeoutMs = this.options.hostRequestTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const host = [...this.connections].reverse().find((c) => c.ready && c.cipherLabel === label);
      if (host) return resultOf(await host.request(method, args, timeoutMs));
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !this.server) throw new ChannelError(`No attached host serves the ${label} cipher.`, 'no_host');
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.hostWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        this.hostWaiters.add(wake);
      });
    }
  }

  private hostsChanged(): void {
    this.options.onHostsChanged?.(this.hosts());
  }

  private accept(socket: Socket): void {
    const connection = new HostConnection(socket);
    this.connections.add(connection);
    const reader = new FrameReader(Math.min(MAX_HELLO_BYTES, this.options.maxFrameBytes ?? MAX_FRAME_BYTES));
    const helloTimer = setTimeout(() => this.refuse(connection, 'hello'), this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        this.onFrame(connection, frame, helloTimer);
        if (connection.ready) reader.limit(this.options.maxFrameBytes ?? MAX_FRAME_BYTES);
      }
    });
    socket.on('error', () => { /* A broken connection ends like a closed one. */ });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.connections.delete(connection);
      connection.close();
      for (const conversationId of connection.views) {
        void Promise.resolve().then(() => this.target.closeView(conversationId)).catch(() => { /* deleted meanwhile */ });
      }
      if (connection.ready) this.hostsChanged();
    });
  }

  private refuse(connection: HostConnection, reason: 'hello' | 'token' | 'protocol'): void {
    if (connection.refused) return;
    connection.refused = true;
    connection.send({ t: 'refused', reason, protocol: CHANNEL_PROTOCOL });
    connection.socket.end();
    // A peer that keeps its side open is cut off.
    setTimeout(() => connection.socket.destroy(), 1_000).unref?.();
  }

  private onFrame(connection: HostConnection, frame: unknown, helloTimer: NodeJS.Timeout): void {
    if (connection.refused) return;
    if (!isJson(frame)) {
      connection.socket.destroy();
      return;
    }
    if (!connection.ready) {
      clearTimeout(helloTimer);
      if (frame.t !== 'hello' || typeof frame.token !== 'string' || !tokenMatches(frame.token, this.descriptor.token)) {
        this.refuse(connection, 'token');
        return;
      }
      if (frame.protocol !== CHANNEL_PROTOCOL) {
        this.refuse(connection, 'protocol');
        return;
      }
      const host = parseHost(frame.host);
      if (!host) {
        this.refuse(connection, 'hello');
        return;
      }
      const services = isJson(frame.services) ? frame.services : {};
      connection.host = host;
      connection.cipherLabel = typeof services.cipher === 'string' && services.cipher.length <= 100 ? services.cipher : null;
      connection.ready = true;
      connection.send({ t: 'welcome', protocol: CHANNEL_PROTOCOL, pid: process.pid, seq: this.seq });
      this.hostsChanged();
      for (const wake of [...this.hostWaiters]) wake();
      return;
    }
    if (frame.t === 'req') void this.dispatch(connection, frame);
    else if (frame.t !== 'res' || !connection.receive(frame)) connection.socket.destroy();
  }

  private async dispatch(connection: HostConnection, frame: Json): Promise<void> {
    const id = frame.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      connection.socket.destroy();
      return;
    }
    const seq = this.seq;
    const method = frame.m;
    if (typeof method !== 'string' || !isCoreCommand(method) || !Array.isArray(frame.a)) {
      connection.send(errorFrame(id, new ChannelError('Unsupported channel request.', 'method')));
      return;
    }
    if (method === 'quit') {
      // Answer first: quitting stops this server.
      connection.send({ t: 'res', id, ok: true, v: null, seq });
      setImmediate(() => { void Promise.resolve().then(() => this.target.quit()).catch(() => undefined); });
      return;
    }
    try {
      const value = await runCoreCommand(this.target, method, frame.a);
      const conversationId = frame.a[0];
      if (typeof conversationId === 'string') {
        if (method === 'openView' || (method === 'setViewFocused' && frame.a[1] === true)) connection.views.add(conversationId);
        else if (method === 'closeView') connection.views.delete(conversationId);
      }
      const line = encodeFrame({ t: 'res', id, ok: true, v: value ?? null, seq });
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new ChannelError('The result exceeds the channel frame limit.', 'size');
      connection.write(line);
    } catch (error) {
      connection.send(errorFrame(id, error));
    }
  }

  private broadcast(event: BotHostEvent): void {
    this.seq += 1;
    const line = encodeFrame({ t: 'ev', seq: this.seq, ev: event });
    for (const connection of this.connections) if (connection.ready) connection.write(line);
  }
}

/**
 * Which process published the descriptor in `root` and for which manager,
 * whatever its protocol, so a host can tell a running core from a stale file;
 * null when there is none.
 */
export function readChannelOwner(root: string): { pid: number; manager: string | null } | null {
  try {
    const value = readDescriptor(channelDescriptorFile(root));
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return null;
    return { pid: value.pid as number, manager: typeof value.manager === 'string' ? value.manager : null };
  } catch {
    return null;
  }
}

/** Reads and checks a core's channel descriptor; a protocol mismatch is refused, not worked around. */
export function readChannelDescriptor(root: string): ChannelDescriptor {
  const value = readDescriptor(channelDescriptorFile(root));
  if (typeof value.protocol !== 'number') throw new ChannelError('Invalid channel descriptor.', 'descriptor');
  if (value.protocol !== CHANNEL_PROTOCOL) {
    throw new ChannelError(`The Bot core speaks channel protocol ${value.protocol}; this host speaks ${CHANNEL_PROTOCOL}.`, 'protocol');
  }
  if (typeof value.socket !== 'string' || !isToken(value.token) || !Number.isSafeInteger(value.pid)
    || (value.manager !== null && typeof value.manager !== 'string') || typeof value.startedAt !== 'string') {
    throw new ChannelError('Invalid channel descriptor.', 'descriptor');
  }
  return value as unknown as ChannelDescriptor;
}

export interface HostChannelClientOptions {
  host: ChannelHostIdentity;
  services?: ChannelHostServices;
  callTimeoutMs?: number;
}

type EventListener = (event: BotHostEvent, seq: number) => void;

/** A host's side of the host channel. */
export class HostChannelClient {
  readonly descriptor: ChannelDescriptor;
  private readonly peer: Peer;
  private readonly options: HostChannelClientOptions;
  private readonly eventListeners = new Set<EventListener>();
  private readonly gapListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly inbound: unknown[] = [];
  private paused = false;
  private lastSeq = 0;
  private closed = false;

  /** Connects to the core whose descriptor is in `root` and completes the handshake. */
  static async connect(root: string, options: HostChannelClientOptions): Promise<HostChannelClient> {
    const descriptor = readChannelDescriptor(root);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(descriptor.socket);
      socket.once('connect', () => { socket.off('error', reject); resolve(socket); });
      socket.once('error', reject);
    });
    const client = new HostChannelClient(socket, descriptor, options);
    await client.handshake();
    return client;
  }

  private welcome: { resolve(): void; reject(error: Error): void } | null = null;

  private constructor(socket: Socket, descriptor: ChannelDescriptor, options: HostChannelClientOptions) {
    this.descriptor = descriptor;
    this.options = options;
    this.peer = new Peer(socket);
    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch (error) {
        this.fail(error as Error);
        return;
      }
      for (const frame of frames) this.inbound.push(frame);
      this.drain();
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new ChannelError('The channel is closed.', 'closed')));
  }

  private handshake(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ChannelError('The Bot core did not answer the channel handshake.', 'timeout')), HELLO_TIMEOUT_MS);
      this.welcome = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.peer.send({
        t: 'hello', protocol: CHANNEL_PROTOCOL, token: this.descriptor.token, host: this.options.host,
        services: this.options.services?.cipher ? { cipher: this.options.services.cipher.label } : {},
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The last event sequence number received. */
  get seq(): number {
    return this.lastSeq;
  }

  async call(method: string, ...args: unknown[]): Promise<unknown> {
    return (await this.callWithSeq(method, args)).value;
  }

  /** A request whose response also says which event sequence number it reflects (FR-13). */
  async callWithSeq(method: string, args: unknown[] = []): Promise<{ value: unknown; seq: number }> {
    if (this.closed) throw new ChannelError('The channel is closed.', 'closed');
    const frame = await this.peer.request(method, args, this.options.callTimeoutMs ?? CALL_TIMEOUT_MS);
    const value = resultOf(frame);
    return { value, seq: typeof frame.seq === 'number' ? frame.seq : this.lastSeq };
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  /** Called when sequence numbers jump: read the snapshots again (FR-13). */
  onGap(listener: () => void): () => void {
    this.gapListeners.add(listener);
    return () => { this.gapListeners.delete(listener); };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  /**
   * FR-13: attach without a gap. Events are buffered while the snapshot is
   * read. The snapshot is handed to `install`; then only the buffered events
   * above its sequence number go to `apply`, and later events go there
   * directly until the returned function detaches it.
   */
  async attach<T>(view: {
    snapshot: () => Promise<{ value: T; seq: number }>;
    install: (value: T) => void;
    apply: EventListener;
  }): Promise<() => void> {
    const buffered: Array<[BotHostEvent, number]> = [];
    let live = false;
    const detach = this.onEvent((event, seq) => {
      if (live) view.apply(event, seq);
      else buffered.push([event, seq]);
    });
    try {
      const { value, seq } = await view.snapshot();
      view.install(value);
      for (const [event, eventSeq] of buffered) if (eventSeq > seq) view.apply(event, eventSeq);
      live = true;
      return detach;
    } catch (error) {
      detach();
      throw error;
    }
  }

  close(): void {
    this.peer.socket.end();
    this.fail(new ChannelError('The channel is closed.', 'closed'));
  }

  private fail(error: Error): void {
    if (this.welcome) {
      const welcome = this.welcome;
      this.welcome = null;
      welcome.reject(error);
    }
    if (this.closed) return;
    this.closed = true;
    this.peer.close();
    this.peer.socket.destroy();
    for (const listener of [...this.closeListeners]) listener();
  }

  /**
   * Frames are handled in the order the core wrote them. After a response the
   * rest waits for the next turn of the event loop, so whoever awaited that
   * response has it before a later event arrives: a snapshot never lands after
   * an event that it predates (FR-13).
   */
  private drain(): void {
    while (!this.paused && !this.closed && this.inbound.length > 0) {
      const frame = this.inbound.shift();
      this.onFrame(frame);
      if (isJson(frame) && frame.t === 'res' && this.inbound.length > 0) {
        this.paused = true;
        setImmediate(() => {
          this.paused = false;
          this.drain();
        });
      }
    }
  }

  private onFrame(frame: unknown): void {
    if (!isJson(frame)) {
      this.fail(new ChannelError('Invalid channel frame.', 'frame'));
      return;
    }
    if (this.welcome) {
      const welcome = this.welcome;
      this.welcome = null;
      if (frame.t === 'welcome' && frame.protocol === CHANNEL_PROTOCOL && frame.pid === this.descriptor.pid) {
        this.lastSeq = typeof frame.seq === 'number' ? frame.seq : 0;
        welcome.resolve();
      } else if (frame.t === 'welcome' && frame.protocol === CHANNEL_PROTOCOL) {
        // FR-15: the core that answered must be the process its descriptor names.
        welcome.reject(new ChannelError('The Bot core that answered is not the one its descriptor names.', 'descriptor'));
        this.fail(new ChannelError('The channel is closed.', 'closed'));
      } else if (frame.t === 'refused') {
        const reason = typeof frame.reason === 'string' ? frame.reason : 'refused';
        welcome.reject(new ChannelError(reason === 'protocol'
          ? `The Bot core refused channel protocol ${CHANNEL_PROTOCOL}; it speaks ${String(frame.protocol)}.`
          : 'The Bot core refused this host.', reason));
        this.fail(new ChannelError('The channel is closed.', 'closed'));
      } else {
        welcome.reject(new ChannelError('Unexpected channel handshake.', 'frame'));
        this.fail(new ChannelError('The channel is closed.', 'closed'));
      }
      return;
    }
    switch (frame.t) {
      case 'ev': {
        const seq = typeof frame.seq === 'number' ? frame.seq : NaN;
        if (!Number.isSafeInteger(seq) || !isJson(frame.ev)) return;
        const gap = seq !== this.lastSeq + 1;
        this.lastSeq = seq;
        if (gap) for (const listener of [...this.gapListeners]) listener();
        for (const listener of [...this.eventListeners]) listener(frame.ev as unknown as BotHostEvent, seq);
        return;
      }
      case 'res':
        if (!this.peer.receive(frame)) this.fail(new ChannelError('Unexpected channel response.', 'frame'));
        return;
      case 'req':
        void this.serve(frame);
        return;
      default:
        this.fail(new ChannelError('Unexpected channel frame.', 'frame'));
    }
  }

  /** Host services the core asks for (FR-20). */
  private async serve(frame: Json): Promise<void> {
    const id = typeof frame.id === 'number' ? frame.id : -1;
    const args = Array.isArray(frame.a) ? frame.a : [];
    try {
      const cipher = this.options.services?.cipher;
      let value: unknown;
      if (frame.m === 'cipher.encrypt' && cipher && typeof args[0] === 'string') {
        value = (await cipher.encrypt(args[0])).toString('base64');
      } else if (frame.m === 'cipher.decrypt' && cipher && typeof args[0] === 'string') {
        value = await cipher.decrypt(Buffer.from(args[0], 'base64'));
      } else {
        throw new ChannelError('Unsupported host service.', 'method');
      }
      this.peer.send({ t: 'res', id, ok: true, v: value });
    } catch (error) {
      this.peer.send(errorFrame(id, error));
    }
  }
}
