import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  connectionSetup,
  localDisplayNumber,
  queryExtension,
  shapeRectangles,
  x11InputRects,
  X11InputShape,
  xauthCookie,
} from '../../src/shell/electron/x11InputShape.ts';

const COOKIE = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const COOKIE_TEXT = COOKIE.toString('latin1');
const EXTENSION = 129;
const RECT = { x: 192, y: 126, width: 96, height: 96 };

function authorityEntry(family: number, address: string, number: string, name: string, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const family16 = Buffer.alloc(2);
  family16.writeUInt16BE(family);
  parts.push(family16);
  for (const value of [Buffer.from(address), Buffer.from(number), Buffer.from(name), data]) {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    parts.push(length, value);
  }
  return Buffer.concat(parts);
}

const LOCAL = 256;
const WILD = 65535;
const MAGIC = 'MIT-MAGIC-COOKIE-1';

test('only local display names have a number', () => {
  assert.equal(localDisplayNumber(':0'), 0);
  assert.equal(localDisplayNumber(':12.3'), 12);
  assert.equal(localDisplayNumber('unix:1'), 1);
  for (const display of [undefined, '', 'host:0', '1', ':x', ':0/../../etc']) assert.equal(localDisplayNumber(display), null);
});

test('window coordinates become enclosing pixels at the display scale', () => {
  assert.deepEqual(x11InputRects([RECT], 1), [RECT]);
  assert.deepEqual(x11InputRects([{ x: 1.5, y: 2.5, width: 3, height: 3 }], 1.5), [{ x: 2, y: 3, width: 5, height: 6 }]);
  for (const scale of [0, -1, Number.NaN]) assert.deepEqual(x11InputRects([RECT], scale), [RECT]);
});

test('the Xauthority cookie is the most specific entry for this local display', () => {
  const other = Buffer.from('ffff', 'hex');
  const file = Buffer.concat([
    authorityEntry(LOCAL, 'elsewhere', '0', MAGIC, other),
    authorityEntry(WILD, '', '0', MAGIC, other),
    authorityEntry(LOCAL, 'pi', '1', MAGIC, other),
    authorityEntry(0, '10.0.0.1', '0', MAGIC, other),
    authorityEntry(LOCAL, 'pi', '0', 'XDM-AUTHORIZATION-1', other),
    authorityEntry(LOCAL, 'pi', '0', MAGIC, COOKIE),
  ]);
  assert.deepEqual(xauthCookie(file, 0, 'pi'), COOKIE);
  assert.deepEqual(xauthCookie(authorityEntry(WILD, '', '', MAGIC, COOKIE), 7, 'pi'), COOKIE);
  // A renamed machine still has this display's cookie under its old name.
  assert.deepEqual(xauthCookie(authorityEntry(LOCAL, 'old-name', '0', MAGIC, COOKIE), 0, 'pi'), COOKIE);
  assert.equal(xauthCookie(authorityEntry(LOCAL, 'pi', '1', MAGIC, COOKIE), 0, 'pi'), null);
  assert.equal(xauthCookie(file.subarray(0, 5), 0, 'pi'), null);
  assert.equal(xauthCookie(Buffer.alloc(0), 0, 'pi'), null);
});

test('requests follow the X11 and SHAPE wire formats', () => {
  const setup = connectionSetup(COOKIE);
  assert.equal(setup.readUInt8(0), 0x6c);
  assert.equal(setup.readUInt16LE(2), 11);
  assert.equal(setup.readUInt16LE(6), MAGIC.length);
  assert.equal(setup.readUInt16LE(8), COOKIE.length);
  assert.equal(setup.toString('latin1', 12, 12 + MAGIC.length), MAGIC);
  assert.deepEqual(setup.subarray(32, 48), COOKIE);
  assert.equal(setup.length, 48);
  assert.equal(connectionSetup(null).length, 12);

  const query = queryExtension('SHAPE');
  assert.equal(query.readUInt8(0), 98);
  assert.equal(query.readUInt16LE(2), 4);
  assert.equal(query.readUInt16LE(4), 5);
  assert.equal(query.toString('latin1', 8, 13), 'SHAPE');

  const shape = shapeRectangles(EXTENSION, 0x00c00004, [RECT, { x: -1, y: 0, width: 10, height: 20 }]);
  assert.equal(shape.readUInt8(0), EXTENSION);
  assert.equal(shape.readUInt8(1), 1, 'Rectangles');
  assert.equal(shape.readUInt16LE(2), 8, 'length in four-byte units');
  assert.equal(shape.readUInt8(4), 0, 'Set');
  assert.equal(shape.readUInt8(5), 2, 'Input, never Bounding');
  assert.equal(shape.readUInt32LE(8), 0x00c00004);
  assert.deepEqual([shape.readInt16LE(16), shape.readInt16LE(18), shape.readUInt16LE(20), shape.readUInt16LE(22)], [192, 126, 96, 96]);
  assert.equal(shape.readInt16LE(24), -1);
});

interface FakeServer {
  server: Server;
  path: string;
  clients: Socket[];
  received: Buffer[];
  connections(): number;
}

/** Just enough of an X server: answers setup, then QueryExtension, and records every request after it. */
async function fakeServer(t: TestContext, respond: 'accept' | 'refuse' | 'no-shape' | 'silent' = 'accept'): Promise<FakeServer> {
  const directory = mkdtempSync(join(tmpdir(), 'cats-bot-x11-'));
  // Where this also runs on Windows, a local socket has to be a named pipe.
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\${basename(directory)}` : join(directory, 'X0');
  const clients: Socket[] = [];
  const received: Buffer[] = [];
  let connections = 0;
  const server = createServer((client) => {
    connections += 1;
    clients.push(client);
    client.on('error', () => {});
    let stage: 'setup' | 'query' | 'requests' = 'setup';
    client.on('data', (chunk) => {
      if (respond === 'silent') return;
      if (stage === 'setup') {
        stage = 'query';
        if (respond === 'refuse') {
          const reason = Buffer.from('No protocol specified\n\0\0');
          const reply = Buffer.alloc(8 + reason.length);
          reply.writeUInt8(0, 0);
          reply.writeUInt8(reason.length - 2, 1);
          reply.writeUInt16LE(reason.length / 4, 6);
          reason.copy(reply, 8);
          client.write(reply);
          return;
        }
        // A real setup reply is longer than its eight-byte header.
        const reply = Buffer.alloc(16);
        reply.writeUInt8(1, 0);
        reply.writeUInt16LE(2, 6);
        client.write(reply);
        return;
      }
      if (stage === 'query') {
        stage = 'requests';
        const reply = Buffer.alloc(32);
        reply.writeUInt8(1, 0);
        reply.writeUInt8(respond === 'no-shape' ? 0 : 1, 8);
        reply.writeUInt8(EXTENSION, 9);
        // Delivered in two pieces, as a stream may.
        client.write(reply.subarray(0, 10));
        setTimeout(() => client.write(reply.subarray(10)), 5);
        return;
      }
      received.push(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(() => {
    for (const client of clients) client.destroy();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { server, path, clients, received, connections: () => connections };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function client(t: TestContext, fake: FakeServer, env: NodeJS.ProcessEnv = { DISPLAY: ':0', XAUTHORITY: '/nonexistent' }) {
  const logs: string[] = [];
  const shape = new X11InputShape({ env, log: (line) => logs.push(line), open: () => connect({ path: fake.path }) });
  t.after(() => shape.close());
  return { shape, logs };
}

test('regions set before the connection is ready send only the newest one per window', async (t) => {
  const fake = await fakeServer(t);
  const { shape, logs } = client(t, fake);
  shape.set(7, [{ x: 0, y: 0, width: 1, height: 1 }]);
  shape.set(7, [RECT]);
  await until(() => fake.received.length > 0, 'queued region');
  assert.deepEqual(Buffer.concat(fake.received), shapeRectangles(EXTENSION, 7, [RECT]));
  shape.set(9, [RECT]);
  await until(() => Buffer.concat(fake.received).length > shapeRectangles(EXTENSION, 7, [RECT]).length, 'ready region');
  assert.deepEqual(Buffer.concat(fake.received).subarray(-24), shapeRectangles(EXTENSION, 9, [RECT]));
  assert.equal(fake.connections(), 1);
  assert.deepEqual(logs, []);
});

test('the setup request carries the cookie and no log ever does', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cats-bot-xauth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const authority = join(directory, 'Xauthority');
  writeFileSync(authority, authorityEntry(WILD, '', '0', MAGIC, COOKIE));
  const fake = await fakeServer(t, 'refuse');
  const setups: Buffer[] = [];
  fake.server.prependListener('connection', (socket: Socket) => socket.once('data', (chunk) => setups.push(chunk)));
  const { shape, logs } = client(t, fake, { DISPLAY: ':0', XAUTHORITY: authority });
  shape.set(7, [RECT]);
  await until(() => logs.length > 0, 'refusal');
  assert.deepEqual(setups, [connectionSetup(COOKIE)]);
  assert.match(logs[0]!, /refused the connection: No protocol specified/u);
  assert.ok(!logs.join('\n').includes(COOKIE_TEXT));
});

test('failure reports once, never throws, and a later region tries again', async (t) => {
  const fake = await fakeServer(t, 'refuse');
  const { shape, logs } = client(t, fake);
  shape.set(7, [RECT]);
  await until(() => logs.length === 1, 'first failure');
  shape.set(7, [RECT]);
  await until(() => fake.connections() === 2, 'second attempt');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(logs.length, 1);
  assert.deepEqual(fake.received, []);
});

test('a server without SHAPE, a remote display or a missing socket only reports', async (t) => {
  const noShape = await fakeServer(t, 'no-shape');
  const first = client(t, noShape);
  first.shape.set(7, [RECT]);
  await until(() => first.logs.length === 1, 'no SHAPE');
  assert.match(first.logs[0]!, /no SHAPE extension/u);

  const remote = client(t, noShape, { DISPLAY: 'host:0' });
  remote.shape.set(7, [RECT]);
  assert.match(remote.logs[0]!, /does not name a local X server/u);

  const logs: string[] = [];
  const missing = new X11InputShape({ env: { DISPLAY: ':0', XAUTHORITY: '/nonexistent' }, log: (line) => logs.push(line), open: () => connect({ path: join(tmpdir(), 'cats-bot-no-such-socket') }) });
  missing.set(7, [RECT]);
  await until(() => logs.length === 1, 'missing socket');
});

test('an X error is logged and the connection stays usable', async (t) => {
  const fake = await fakeServer(t);
  const { shape, logs } = client(t, fake);
  shape.set(7, [RECT]);
  await until(() => fake.received.length === 1, 'first request');
  const error = Buffer.alloc(32);
  error.writeUInt8(0, 0);
  error.writeUInt8(3, 1);
  fake.clients[0]!.write(error);
  await until(() => logs.length === 1, 'BadWindow');
  assert.match(logs[0]!, /X error 3/u);
  shape.set(9, [RECT]);
  await until(() => fake.received.length === 2, 'request after the error');
  assert.equal(fake.connections(), 1);
});

test('a lost connection is replaced by the next region, and invalid input opens nothing', async (t) => {
  const fake = await fakeServer(t);
  const { shape } = client(t, fake);
  shape.set(0, [RECT]);
  shape.set(1.5, [RECT]);
  shape.set(7, []);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fake.connections(), 0);
  shape.set(7, [RECT]);
  await until(() => fake.received.length === 1, 'first request');
  fake.clients[0]!.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  shape.set(7, [RECT]);
  await until(() => fake.received.length === 2, 'request after reconnecting');
  assert.equal(fake.connections(), 2);
});
