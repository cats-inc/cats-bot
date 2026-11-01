/** Private development-candidate host. Launched only by the Bot candidate command, never by an installed product. */
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.CATS_BOT_CANDIDATE_ROOT;
const token = process.env.CATS_BOT_CANDIDATE_TOKEN;
if (!root || !path.isAbsolute(root) || !/^[a-f0-9]{64}$/u.test(token ?? '')) throw new Error('Missing private candidate launch identity.');
const launchId = createHash('sha256').update(token).digest('hex');
const instanceId = randomBytes(16).toString('hex');
const identity = { schemaVersion: 1, root, launchId, instanceId, pid: process.pid };
mkdirSync(path.join(root, 'app-data'), { recursive: true });
mkdirSync(path.join(root, 'user-data'), { recursive: true });
app.setPath('appData', path.join(root, 'app-data'));
app.setPath('userData', path.join(root, 'user-data'));
const write = (filename, value) => { writeFileSync(filename + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(filename + '.tmp', filename); };
const windows = () => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && !window.webContents.isDestroyed());
const windowForCapture = () => windows().find(window => window.isVisible() && /(?:note|settings)\.html/u.test(window.webContents.getURL()));
const server = createServer(async (request, response) => {
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403).end(); return; }
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  try {
    if (request.method === 'GET' && request.url === '/status') {
      const window = windowForCapture();
      json({ ...identity, window: window ? { url: window.webContents.getURL(), loading: window.webContents.isLoading(), visible: true } : null });
    } else if (request.method === 'POST' && request.url === '/screenshot') {
      const window = windowForCapture();
      if (!window) { response.writeHead(409).end(); return; }
      const image = await window.webContents.capturePage();
      response.setHeader('Content-Type', 'image/png');
      response.setHeader('x-cats-frame-id', randomBytes(16).toString('hex'));
      response.setHeader('x-cats-instance-id', instanceId);
      response.setHeader('x-cats-image-width', image.getSize().width);
      response.setHeader('x-cats-image-height', image.getSize().height);
      response.end(image.toPNG());
    } else if (request.method === 'POST' && request.url === '/stop') {
      json({ ...identity, stopping: true });
      setImmediate(() => app.quit());
    } else response.writeHead(404).end();
  } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
});
process.on('exit', exitCode => write(path.join(root, `exit-${instanceId}.json`), { ...identity, exitCode }));
app.on('will-quit', () => server.close());
// Electron waits for the entry module to finish before emitting ready.
// Do not await readiness-dependent module work at top level.
app.whenReady().then(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  write(path.join(root, 'control.json'), { ...identity, token, url: `http://127.0.0.1:${server.address().port}` });
  await import(pathToFileURL(path.join(root, 'source', 'cats-bot', 'dist', 'shell', 'electron', 'main.js')).href);
}).catch(error => { console.error(error.message); app.exit(1); });
