// A stand-in core that completes the channel handshake and then answers nothing, as a core
// whose event loop is stuck would; it holds the bot's lock and publishes a descriptor.
// Usage: node wedged-core.mjs <bot root> <manager>
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

const [root, manager] = process.argv.slice(2);
const socketPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\cats-bot-wedged-${randomUUID()}`
  : join(tmpdir(), `cats-bot-wedged-${randomUUID().slice(0, 8)}.sock`);
const server = createServer((socket) => {
  let buffer = '';
  socket.on('error', () => undefined);
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
      const frame = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (frame.t === 'hello') socket.write(`${JSON.stringify({ t: 'welcome', protocol: 1, pid: process.pid, seq: 0 })}\n`);
    }
  });
});
server.listen(socketPath, () => {
  const startedAt = new Date().toISOString();
  writeFileSync(join(root, 'instance.lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), startedAt }));
  writeFileSync(join(root, 'host-channel.json'), JSON.stringify({ protocol: 1, socket: socketPath, token: 'b'.repeat(64), pid: process.pid, manager, startedAt }));
  process.stdout.write('ready\n');
});
