import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  ChannelError, ChannelRemoteError, CHANNEL_PROTOCOL, channelDescriptorFile, FrameReader, HostChannelClient,
  HostChannelServer, readChannelDescriptor, type ChannelTarget,
} from '../../src/core/host-api/channel.ts';
import { newLocalSocket } from '../../src/core/host-api/endpoint.ts';
import type { BotHostEvent, WorkItem } from '../../src/core/types.ts';

// SPEC-008 FR-12 to FR-15 against a fake core, so each protocol rule is checked alone.

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'cats-bot-channel-'));
  roots.push(root);
  return root;
};
const host = { pid: process.pid, executable: process.execPath, installationId: null };
const event = (n: number): BotHostEvent => ({ type: 'runtime.status', state: 'ready', detail: `e${n}` });

function fakeCore() {
  const listeners = new Set<(event: BotHostEvent) => void>();
  const emit = (value: BotHostEvent) => { for (const listener of listeners) listener(value); };
  const calls: string[] = [];
  let quits = 0;
  const target = {
    subscribe(listener: (event: BotHostEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async getProfile() { calls.push('getProfile'); return { id: 'fake', name: 'Fake' }; },
    async sendOwnerMessage(conversationId: string, text: string) { calls.push(`send ${conversationId} ${text}`); return { id: 'w1' }; },
    // Emits while it builds its snapshot, the way a running turn would.
    listWorkItems(): WorkItem[] {
      emit(event(99));
      return [];
    },
    async quit() { quits += 1; },
    async openView(id: string) { calls.push(`open ${id}`); },
    async closeView(id: string) { calls.push(`close ${id}`); },
    async setViewFocused(id: string, focused: boolean) { calls.push(`focus ${id} ${focused}`); },
  };
  return { target: target as unknown as ChannelTarget, emit, calls, get quits() { return quits; } };
}

async function started(options: ConstructorParameters<typeof HostChannelServer>[2] = {}) {
  const root = tempRoot();
  const core = fakeCore();
  const server = new HostChannelServer(root, core.target, options);
  await server.start();
  return { root, core, server };
}

function rawHello(socketPath: string, hello: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const reader = new FrameReader();
    socket.on('connect', () => socket.write(`${JSON.stringify(hello)}\n`));
    socket.on('data', (chunk: Buffer) => {
      const [frame] = reader.push(chunk);
      if (frame) { resolve(frame as Record<string, unknown>); socket.destroy(); }
    });
    socket.on('error', reject);
  });
}

test('frames split across chunks, and an oversize or broken frame is refused', () => {
  const reader = new FrameReader(64);
  assert.deepEqual(reader.push(Buffer.from('{"a":1}\n{"b"')), [{ a: 1 }]);
  assert.deepEqual(reader.push(Buffer.from(':2}\n\n{"c":3}\n')), [{ b: 2 }, { c: 3 }]);
  assert.throws(() => new FrameReader(8).push(Buffer.from('{"long":"value"}')), (error: ChannelError) => error.reason === 'size');
  assert.throws(() => new FrameReader().push(Buffer.from('not json\n')), (error: ChannelError) => error.reason === 'frame');
});

test('the descriptor names protocol, socket, token, pid and manager, for this account only', async () => {
  const { root, server } = await started({ manager: 'install-1' });
  try {
    const descriptor = readChannelDescriptor(root);
    assert.equal(descriptor.protocol, CHANNEL_PROTOCOL);
    assert.match(descriptor.token, /^[a-f0-9]{64}$/u);
    assert.equal(descriptor.pid, process.pid);
    assert.equal(descriptor.manager, 'install-1');
    if (process.platform !== 'win32') {
      assert.equal(statSync(channelDescriptorFile(root)).mode & 0o777, 0o600);
      assert.equal(statSync(descriptor.socket).mode & 0o777, 0o600);
    }
  } finally { await server.stop(); }
  assert.equal(existsSync(channelDescriptorFile(root)), false, 'stop removes the descriptor');
});

test('allow-listed commands run with their argument checks; anything else is refused', async () => {
  const { root, core, server } = await started();
  const client = await HostChannelClient.connect(root, { host });
  try {
    assert.deepEqual(await client.call('getProfile'), { id: 'fake', name: 'Fake' });
    assert.deepEqual(await client.call('sendOwnerMessage', 'home', 'hello'), { id: 'w1' });
    await assert.rejects(client.call('sendOwnerMessage', 'home'), /text must be a non-empty string/u);
    await assert.rejects(client.call('createSchedule', {}), (error: Error) => error instanceof ChannelRemoteError && /Unsupported channel request/u.test(error.message));
    await assert.rejects(client.call('constructor'), ChannelRemoteError);
    assert.deepEqual(core.calls, ['getProfile', 'send home hello']);
  } finally { client.close(); await server.stop(); }
});

test('a wrong token, another protocol or a silent connection is refused', async () => {
  const { root, server } = await started({ helloTimeoutMs: 200 });
  try {
    const descriptor = readChannelDescriptor(root);
    const forged = tempRoot();
    writeFileSync(channelDescriptorFile(forged), JSON.stringify({ ...descriptor, token: 'f'.repeat(64) }));
    await assert.rejects(HostChannelClient.connect(forged, { host }), (error: ChannelError) => error.reason === 'token');
    assert.deepEqual(await rawHello(descriptor.socket, { t: 'hello', protocol: 99, token: descriptor.token, host }),
      { t: 'refused', reason: 'protocol', protocol: CHANNEL_PROTOCOL });
    const silent = await new Promise<Record<string, unknown>>((resolve) => {
      const socket = createConnection(descriptor.socket);
      const reader = new FrameReader();
      socket.on('data', (chunk: Buffer) => { resolve(reader.push(chunk)[0] as Record<string, unknown>); socket.destroy(); });
    });
    assert.equal(silent.reason, 'hello');
    // A descriptor from another protocol version is refused before connecting, not worked around.
    const newer = tempRoot();
    writeFileSync(channelDescriptorFile(newer), JSON.stringify({ ...descriptor, protocol: CHANNEL_PROTOCOL + 1 }));
    assert.throws(() => readChannelDescriptor(newer), (error: ChannelError) => error.reason === 'protocol');
  } finally { await server.stop(); }
});

test('an oversize frame closes the connection', async () => {
  const { root, server } = await started({ maxFrameBytes: 1024 });
  const client = await HostChannelClient.connect(root, { host });
  try {
    const closed = new Promise<void>((resolve) => client.onClose(resolve));
    await assert.rejects(client.call('sendOwnerMessage', 'home', 'x'.repeat(4096)), ChannelError);
    await closed;
  } finally { client.close(); await server.stop(); }
});

test('events arrive numbered, and attach applies only the events above the snapshot (FR-13)', async () => {
  const { root, core, server } = await started();
  const client = await HostChannelClient.connect(root, { host });
  try {
    const seen: number[] = [];
    let gaps = 0;
    client.onGap(() => { gaps += 1; });
    client.onEvent((_event, seq) => seen.push(seq));
    core.emit(event(1));
    core.emit(event(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen, [1, 2]);
    // Event 3 arrives after attach subscribed but before the snapshot request, so the
    // snapshot includes it; listWorkItems emits event 4 while it builds that snapshot.
    const steps: string[] = [];
    const detach = await client.attach({
      snapshot: async () => {
        core.emit(event(3));
        await new Promise((resolve) => setTimeout(resolve, 50));
        return client.callWithSeq('listWorkItems') as Promise<{ value: WorkItem[]; seq: number }>;
      },
      install: (value) => steps.push(`install ${value.length}`),
      apply: (applied, seq) => steps.push(`${(applied as { detail?: string }).detail}@${seq}`),
    });
    assert.deepEqual(steps, ['install 0', 'e99@4'], 'the snapshot first, then only the events it does not include');
    core.emit(event(5));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(steps, ['install 0', 'e99@4', 'e5@5']);
    detach();
    assert.equal(gaps, 0);
  } finally { client.close(); await server.stop(); }
});

test('the core reaches the host\'s cipher, waiting for a host that serves it (FR-20)', async () => {
  const { root, server } = await started({ hostRequestTimeoutMs: 2_000 });
  const cipher = server.cipher('test-cipher');
  try {
    // Asked before any host is attached: the request waits for one.
    const early = cipher.encrypt('before attach');
    const client = await HostChannelClient.connect(root, {
      host,
      services: { cipher: { label: 'test-cipher', encrypt: (plain) => Buffer.from(`enc:${plain}`), decrypt: (data) => data.toString('utf8').slice(4) } },
    });
    try {
      assert.equal((await early).toString('utf8'), 'enc:before attach');
      assert.equal(await cipher.decrypt(Buffer.from('enc:secret')), 'secret');
      assert.deepEqual(server.hosts(), [host]);
    } finally { client.close(); }
    await assert.rejects(server.cipher('other-label').encrypt('x'), (error: ChannelError) => error.reason === 'no_host');
  } finally { await server.stop(); }
});

test('quit is answered before the core stops', async () => {
  const { root, core, server } = await started();
  const client = await HostChannelClient.connect(root, { host });
  try {
    assert.equal(await client.call('quit'), null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(core.quits, 1);
  } finally { client.close(); await server.stop(); }
});

test('stopping the core closes attached hosts', async () => {
  const { root, server } = await started();
  const client = await HostChannelClient.connect(root, { host });
  const closed = new Promise<void>((resolve) => client.onClose(resolve));
  await server.stop();
  await closed;
  assert.equal(client.isClosed, true);
  await assert.rejects(client.call('getProfile'), (error: ChannelError) => error.reason === 'closed');
});

test('the views a host opened close when its connection ends (FR-15)', async () => {
  const { root, core, server } = await started();
  const client = await HostChannelClient.connect(root, { host });
  try {
    await client.call('openView', 'home');
    await client.call('openView', 'c1');
    await client.call('setViewFocused', 'c2', true);
    await client.call('closeView', 'c1');
    core.calls.length = 0;
    client.close();
    const deadline = Date.now() + 2_000;
    while (core.calls.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual([...core.calls].sort(), ['close c2', 'close home'], 'a view the host closed itself is not closed again');
  } finally { await server.stop(); }
});

test('a response reaches its caller before an event the core wrote after it (FR-13)', async () => {
  // A raw core that writes the response and a later event in one chunk.
  const root = tempRoot();
  const socketPath = newLocalSocket('cats-bot-order');
  const raw = createServer((socket) => {
    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of reader.push(chunk) as Array<Record<string, unknown>>) {
        if (frame.t === 'hello') socket.write(`${JSON.stringify({ t: 'welcome', protocol: CHANNEL_PROTOCOL, pid: process.pid, seq: 0 })}\n`);
        if (frame.t === 'req') {
          socket.write(`${JSON.stringify({ t: 'res', id: frame.id, ok: true, v: 'snapshot', seq: 0 })}\n${JSON.stringify({ t: 'ev', seq: 1, ev: event(1) })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => raw.listen(socketPath, resolve));
  writeFileSync(channelDescriptorFile(root), JSON.stringify({
    protocol: CHANNEL_PROTOCOL, socket: socketPath, token: 'a'.repeat(64), pid: process.pid, manager: null, startedAt: new Date().toISOString(),
  }));
  const client = await HostChannelClient.connect(root, { host });
  try {
    const order: string[] = [];
    client.onEvent(() => order.push('event'));
    // Several awaits, like the way from a channel response to a renderer's IPC reply.
    const value = await client.call('getProfile');
    await null;
    await null;
    order.push(`response ${String(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(order, ['response snapshot', 'event']);
  } finally {
    client.close();
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  }
});

test('a late answer to a request that timed out is dropped, and the connection stays (review of 1.1)', async () => {
  const { root, server } = await started({ hostRequestTimeoutMs: 100 });
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const client = await HostChannelClient.connect(root, {
    host,
    services: { cipher: { label: 'slow', encrypt: async (plain) => { await slow; return Buffer.from(plain); }, decrypt: (data) => data.toString('utf8') } },
  });
  try {
    await assert.rejects(server.cipher('slow').encrypt('x'), (error: ChannelError) => error.reason === 'timeout');
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(client.isClosed, false, 'the host is still attached');
    assert.equal(server.hosts().length, 1);
    assert.equal(await server.cipher('slow').decrypt(Buffer.from('still here')), 'still here');
  } finally { client.close(); await server.stop(); }
});

test('a refused connection is cut off and its later frames are ignored', async () => {
  const { root, core, server } = await started();
  try {
    const descriptor = readChannelDescriptor(root);
    const socket = createConnection({ path: descriptor.socket, allowHalfOpen: true });
    const reader = new FrameReader();
    const frames: Array<Record<string, unknown>> = [];
    socket.on('data', (chunk: Buffer) => frames.push(...(reader.push(chunk) as Array<Record<string, unknown>>)));
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    socket.write(`${JSON.stringify({ t: 'hello', protocol: CHANNEL_PROTOCOL, token: 'f'.repeat(64), host })}\n`);
    socket.write(`${JSON.stringify({ t: 'hello', protocol: CHANNEL_PROTOCOL, token: descriptor.token, host })}\n`);
    socket.write(`${JSON.stringify({ t: 'req', id: 1, m: 'getProfile', a: [] })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.deepEqual(frames, [{ t: 'refused', reason: 'token', protocol: CHANNEL_PROTOCOL }], 'no second hello, no answer');
    assert.deepEqual(core.calls, []);
    // The core has cut the connection off although this side kept it open.
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    socket.write('{}\n');
    await closed;
    // Before its hello, a connection never buffers more than a small frame.
    const big = createConnection(descriptor.socket);
    const bigClosed = new Promise<void>((resolve) => big.on('close', () => resolve()));
    big.on('error', () => undefined);
    big.write(`{"t":"hello","pad":"${'x'.repeat(128 * 1024)}`);
    await bigClosed;
  } finally { await server.stop(); }
});

test('a host cipher answer that is not text is refused, not stored', async () => {
  const { root, server } = await started({ hostRequestTimeoutMs: 2_000 });
  const client = await HostChannelClient.connect(root, {
    host,
    services: { cipher: { label: 'odd', encrypt: () => Buffer.from('x'), decrypt: () => 42 as unknown as string } },
  });
  try {
    await assert.rejects(server.cipher('odd').decrypt(Buffer.from('x')), (error: ChannelError) => error.reason === 'frame');
  } finally { client.close(); await server.stop(); }
});

test('a welcome from another process than the descriptor names is refused (FR-15)', async () => {
  const { root, server } = await started();
  try {
    const descriptor = readChannelDescriptor(root);
    const moved = tempRoot();
    writeFileSync(channelDescriptorFile(moved), JSON.stringify({ ...descriptor, pid: descriptor.pid + 1 }));
    await assert.rejects(HostChannelClient.connect(moved, { host }), (error: ChannelError) => error.reason === 'descriptor');
  } finally { await server.stop(); }
});
