import { existsSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

/**
 * ADR-014: the avatar's Linux input region. Electron's setShape changes what a
 * window draws, and XWayland keeps showing the rest of its buffer; only an X11
 * input shape reaches the compositor as a Wayland input region. Electron has
 * no API for one, so this client asks the X server itself. It speaks the
 * protocol over its own connection because an Xlib error ends the process by
 * default, and a window the server has not seen yet is an ordinary error here.
 */

export interface InputRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInputShape {
  /** Replaces a window's input region. `rects` are in the window's pixels. */
  set(window: number, rects: readonly InputRect[]): void;
}

const AUTH_NAME = 'MIT-MAGIC-COOKIE-1';
const FAMILY_LOCAL = 256;
const FAMILY_WILD = 65535;
const QUERY_EXTENSION = 98;
const SHAPE_RECTANGLES = 1;
const SHAPE_SET = 0;
const SHAPE_INPUT = 2;
const SHAPE_UNSORTED = 0;
const SETUP_TIMEOUT_MS = 5000;

const paddingFor = (length: number): number => (4 - (length % 4)) % 4;

/** The number of a display on this machine, or null for anything reached another way. */
export function localDisplayNumber(display: string | undefined): number | null {
  const match = /^(?:unix)?:(\d+)(?:\.\d+)?$/u.exec(display ?? '');
  return match ? Number(match[1]) : null;
}

/** The renderer reports window coordinates; the X server wants enclosing pixels. */
export function x11InputRects(regions: readonly InputRect[], scale: number): InputRect[] {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return regions.map(({ x, y, width, height }) => {
    const left = Math.floor(x * factor);
    const top = Math.floor(y * factor);
    return { x: left, y: top, width: Math.ceil((x + width) * factor) - left, height: Math.ceil((y + height) * factor) - top };
  });
}

/** The cookie an Xauthority file holds for a local display, preferring the most specific entry. */
export function xauthCookie(file: Buffer, display: number, host = hostname()): Buffer | null {
  let best: Buffer | null = null;
  let bestRank = -1;
  let at = 0;
  const field = (): Buffer | null => {
    if (at + 2 > file.length) return null;
    const length = file.readUInt16BE(at);
    at += 2;
    if (at + length > file.length) return null;
    const value = file.subarray(at, at + length);
    at += length;
    return value;
  };
  while (at + 2 <= file.length) {
    const family = file.readUInt16BE(at);
    at += 2;
    const address = field();
    const number = field();
    const name = field();
    const data = field();
    if (!address || !number || !name || !data) break;
    if (family !== FAMILY_LOCAL && family !== FAMILY_WILD) continue;
    if (name.toString('latin1') !== AUTH_NAME || data.length === 0) continue;
    const exact = number.toString('latin1') === String(display);
    if (!exact && number.length > 0) continue;
    const place = family === FAMILY_WILD ? 1 : address.toString('latin1') === host ? 2 : 0;
    const rank = (exact ? 4 : 0) + place;
    if (rank > bestRank) {
      best = data;
      bestRank = rank;
    }
  }
  return best;
}

/** The first bytes on a connection: little-endian requests, protocol 11.0 and the cookie, if any. */
export function connectionSetup(cookie: Buffer | null): Buffer {
  const name = Buffer.from(cookie ? AUTH_NAME : '', 'latin1');
  const data = cookie ?? Buffer.alloc(0);
  const dataAt = 12 + name.length + paddingFor(name.length);
  const request = Buffer.alloc(dataAt + data.length + paddingFor(data.length));
  request.writeUInt8(0x6c, 0);
  request.writeUInt16LE(11, 2);
  request.writeUInt16LE(0, 4);
  request.writeUInt16LE(name.length, 6);
  request.writeUInt16LE(data.length, 8);
  name.copy(request, 12);
  data.copy(request, dataAt);
  return request;
}

export function queryExtension(name: string): Buffer {
  const bytes = Buffer.from(name, 'latin1');
  const request = Buffer.alloc(8 + bytes.length + paddingFor(bytes.length));
  request.writeUInt8(QUERY_EXTENSION, 0);
  request.writeUInt16LE(request.length / 4, 2);
  request.writeUInt16LE(bytes.length, 4);
  bytes.copy(request, 8);
  return request;
}

/** SHAPE's Rectangles request, replacing only the input kind: the bounding shape is left alone. */
export function shapeRectangles(extension: number, window: number, rects: readonly InputRect[]): Buffer {
  const request = Buffer.alloc(16 + rects.length * 8);
  request.writeUInt8(extension, 0);
  request.writeUInt8(SHAPE_RECTANGLES, 1);
  request.writeUInt16LE(request.length / 4, 2);
  request.writeUInt8(SHAPE_SET, 4);
  request.writeUInt8(SHAPE_INPUT, 5);
  request.writeUInt8(SHAPE_UNSORTED, 6);
  request.writeUInt32LE(window, 8);
  rects.forEach((rect, index) => {
    const at = 16 + index * 8;
    request.writeInt16LE(rect.x, at);
    request.writeInt16LE(rect.y, at + 2);
    request.writeUInt16LE(rect.width, at + 4);
    request.writeUInt16LE(rect.height, at + 6);
  });
  return request;
}

function readCookie(env: NodeJS.ProcessEnv, display: number): Buffer | null {
  try {
    return xauthCookie(readFileSync(env.XAUTHORITY || join(homedir(), '.Xauthority')), display);
  } catch {
    return null; // A server that needs no cookie still accepts the connection.
  }
}

function openDisplaySocket(display: number): Socket {
  const path = `/tmp/.X11-unix/X${display}`;
  // Without the file, the same display can still listen on the abstract socket of that name.
  return connect({ path: existsSync(path) ? path : `\0${path}` });
}

export interface X11InputShapeOptions {
  env?: NodeJS.ProcessEnv;
  log?(line: string): void;
  /** Opens the socket to a display; a test supplies its own server. */
  open?(display: number): Socket;
}

export class X11InputShape implements WindowInputShape {
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: ((line: string) => void) | undefined;
  private readonly open: (display: number) => Socket;
  private socket: Socket | null = null;
  private stage: 'closed' | 'setup' | 'extension' | 'ready' = 'closed';
  private received: Buffer = Buffer.alloc(0);
  private extension = 0;
  private failureReported = false;
  /** Only the newest region of a window matters while the connection is not ready. */
  private readonly wanted = new Map<number, readonly InputRect[]>();

  constructor(options: X11InputShapeOptions = {}) {
    this.env = options.env ?? process.env;
    this.log = options.log;
    this.open = options.open ?? openDisplaySocket;
  }

  set(window: number, rects: readonly InputRect[]): void {
    if (!Number.isInteger(window) || window <= 0 || rects.length === 0) return;
    if (this.stage === 'ready') {
      this.socket?.write(shapeRectangles(this.extension, window, rects));
      return;
    }
    this.wanted.set(window, rects);
    if (this.stage === 'closed') this.connectToDisplay();
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.stage = 'closed';
    this.wanted.clear();
    socket?.destroy();
  }

  private connectToDisplay(): void {
    const display = localDisplayNumber(this.env.DISPLAY);
    if (display === null) {
      this.fail('DISPLAY does not name a local X server');
      return;
    }
    const socket = this.open(display);
    this.socket = socket;
    this.stage = 'setup';
    this.received = Buffer.alloc(0);
    socket.unref();
    socket.setTimeout(SETUP_TIMEOUT_MS, () => {
      if (this.socket === socket && this.stage !== 'ready') this.fail('the X server did not answer');
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.socket === socket) this.receive(chunk);
    });
    socket.on('error', (error) => {
      if (this.socket === socket) this.fail(error.message);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      if (this.stage === 'ready') this.close(); // The next region reconnects.
      else this.fail('the X server closed the connection');
    });
    socket.write(connectionSetup(readCookie(this.env, display)));
  }

  private receive(chunk: Buffer): void {
    this.received = this.received.length > 0 ? Buffer.concat([this.received, chunk]) : chunk;
    while (this.socket) {
      if (this.stage === 'setup') {
        if (this.received.length < 8) return;
        const size = 8 + this.received.readUInt16LE(6) * 4;
        if (this.received.length < size) return;
        const reply = this.received.subarray(0, size);
        this.received = this.received.subarray(size);
        if (reply.readUInt8(0) !== 1) {
          const reasonLength = reply.readUInt8(0) === 0 ? reply.readUInt8(1) : size - 8;
          const reason = reply.toString('latin1', 8, 8 + reasonLength).replace(/\0+$/u, '').trim();
          this.fail(`the X server refused the connection: ${reason}`);
          return;
        }
        this.stage = 'extension';
        this.socket.write(queryExtension('SHAPE'));
        continue;
      }
      if (this.received.length < 32) return;
      const type = this.received.readUInt8(0);
      const size = type === 1 ? 32 + this.received.readUInt32LE(4) * 4 : 32;
      if (this.received.length < size) return;
      const message = this.received.subarray(0, size);
      this.received = this.received.subarray(size);
      if (type === 0) this.log?.(`floating bot input region: X error ${message.readUInt8(1)}`);
      else if (type === 1 && this.stage === 'extension') this.extensionAnswered(message);
    }
  }

  private extensionAnswered(reply: Buffer): void {
    if (reply.readUInt8(8) === 0) {
      this.fail('the X server has no SHAPE extension');
      return;
    }
    this.extension = reply.readUInt8(9);
    this.stage = 'ready';
    this.failureReported = false;
    this.socket?.setTimeout(0);
    for (const [window, rects] of this.wanted) this.socket?.write(shapeRectangles(this.extension, window, rects));
    this.wanted.clear();
  }

  private fail(reason: string): void {
    this.close();
    if (this.failureReported) return;
    this.failureReported = true;
    this.log?.(`floating bot input region unavailable: ${reason}`);
  }
}

let shared: X11InputShape | null = null;

/** One connection serves every bot's avatar under the hub. */
export function sharedX11InputShape(log?: (line: string) => void): X11InputShape {
  shared ??= new X11InputShape(log ? { log } : {});
  return shared;
}
