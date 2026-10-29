import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  ChannelError, ChannelRemoteError, CHANNEL_PROTOCOL, channelDescriptorFile, FrameReader, HostChannelClient,
  HostChannelServer, readChannelDescriptor, type ChannelTarget,
} from '../../src/core/host-api/channel.ts';
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
    // listWorkItems emits event 3 while it builds its snapshot; the snapshot reflects sequence 2.
    const applied: string[] = [];
    const { value, detach } = await client.attach(
      async () => client.callWithSeq('listWorkItems') as Promise<{ value: WorkItem[]; seq: number }>,
      (applied_, seq) => applied.push(`${(applied_ as { detail?: string }).detail}@${seq}`),
    );
    assert.deepEqual(value, []);
    assert.deepEqual(applied, ['e99@3'], 'the event during the snapshot is applied, the earlier ones are not');
    core.emit(event(4));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(applied, ['e99@3', 'e4@4']);
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
