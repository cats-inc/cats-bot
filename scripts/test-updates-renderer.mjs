// Isolated Electron/CDP acceptance. Build first, then run:
// electron scripts/test-updates-renderer.mjs
// No provider, real profile, network feed or installer is used.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, ipcMain } from 'electron';
import { SettingsWindow } from '../dist/shell/electron/settingsWindow.js';
import { BotUpdateController } from '../dist/shell/electron/update/controller.js';
import { isUpdateSender, updateAction } from '../dist/shell/electron/update/ipc.js';

const root = resolve(import.meta.dirname, '..');
mkdirSync(join(root, 'tmp'), { recursive: true });
const evidence = mkdtempSync(join(root, 'tmp', 'updates-renderer-'));
app.setPath('appData', evidence); app.setPath('userData', evidence);
async function main() {
await app.whenReady();
const settings = new SettingsWindow({ preloadPath: join(root, 'assets/preload.cjs'), rendererDir: join(root, 'dist/renderer'), iconPath: join(root, 'assets/icon.png') });
const calls = []; let failCheck = true, finishDownload, allowed = false;
const controller = new BotUpdateController({ phase: 'idle', currentVersion: '0.2.0', version: null,
  distribution: 'standard-preview', canCheck: true, canInstall: true, reason: null, error: null, percent: null }, {
  check: async () => { calls.push('check'); if (failCheck) { failCheck = false; throw new Error('Fixture network failure'); } return '0.3.0'; },
  download: async progress => { calls.push('download'); progress(42); await new Promise(resolve => { finishDownload = resolve; }); },
  prepareInstall: async () => { calls.push('verify'); }, install: async () => { calls.push('install-fixture'); },
}, {
  acquireInstall: () => ({ handoff: () => { calls.push('handoff'); }, release: () => {} }),
  drain: async () => { calls.push('drain'); }, recover: async () => { throw new Error('Unexpected recovery'); },
  openRelease: async url => { calls.push(url); }, changed: state => settings.browserWindow?.webContents.send('shell:update', state),
});
ipcMain.handle('bot:invoke', (_event, command) => command === 'getProfile' ? {
  name: 'Update fixture', executionTarget: { provider: 'codex', model: null },
} : { id: 'update-fixture', name: 'Update fixture', root: evidence, runtime: { state: 'stopped', pid: null } });
ipcMain.handle('shell:state', () => ({ botId: 'update-fixture', version: '0.2.0', floatingVisible: false, openAtLogin: false, openAtLoginAvailable: false }));
ipcMain.handle('shell:updateState', event => {
  assert.ok(isUpdateSender(event, id => settings.owns(id))); return controller.snapshot();
});
ipcMain.handle('shell:updateAction', (event, action) => {
  assert.ok(isUpdateSender(event, id => settings.owns(id))); return updateAction(controller, action, async () => allowed);
});
try {
  await settings.open('app');
  const contents = settings.browserWindow.webContents;
  contents.debugger.attach('1.3');
  const evaluate = async expression => {
    const result = await contents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    const deadline = Date.now() + 5000;
    while (!await evaluate(expression)) {
      if (Date.now() > deadline) throw new Error(`Renderer timeout: ${expression}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const click = label => evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`);
  await wait("document.querySelector('.update-panel')?.innerText.includes('Standard Preview')");
  assert.deepEqual(calls, [], 'mounting does not check automatically');
  await click('Check for Updates'); await wait("document.querySelector('[role=alert]')?.textContent.includes('Fixture network failure')");
  await click('Check for Updates'); await wait("document.querySelector('.update-panel').innerText.includes('A new version is available')");
  assert.deepEqual(calls, ['check', 'check'], 'check does not download');
  await click('Download update'); await wait("document.querySelector('progress')?.value === 42");
  finishDownload(); await wait("document.querySelector('.update-panel').innerText.includes('ready to install')");
  contents.reload(); await new Promise(resolve => contents.once('did-finish-load', resolve));
  await wait("document.querySelector('.update-panel')?.innerText.includes('ready to install')");
  await click('Restart and install'); await wait("Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Restart and install' && !button.disabled)");
  assert.equal(calls.includes('drain'), false, 'cancelled confirmation leaves Bot running');
  const screenshot = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(evidence, 'downloaded.png'), Buffer.from(screenshot.data, 'base64'));
  allowed = true; await click('Restart and install');
  await wait("document.querySelector('.update-panel').innerText.includes('opening the installer')");
  assert.deepEqual(calls.slice(-4), ['verify', 'drain', 'handoff', 'install-fixture']);
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ passed: true, calls, realInstallerLaunched: false }, null, 2));
  console.log(`Renderer acceptance passed: ${evidence}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally { settings.destroy(); app.exit(process.exitCode ?? 0); }
}
void main().catch(error => { console.error(error); app.exit(1); });
