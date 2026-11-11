/** Build first, then: node scripts/testing/page-window-reset-acceptance.mjs
 * Three real Electron processes, disposable storage, no core/provider or login-item changes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const script = import.meta.filename;
const repo = resolve(import.meta.dirname, '../..');
if (!process.versions.electron) {
  const root = mkdtempSync(join(tmpdir(), 'cats-window-reset-'));
  const executable = createRequire(import.meta.url)('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  for (const phase of ['save', 'restore', 'runtime']) {
    const child = spawnSync(executable, [script, `--phase=${phase}`, `--evidence=${root}`], {
      env, windowsHide: true, timeout: 45_000, encoding: 'utf8',
    });
    writeFileSync(join(root, `${phase}.log`), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
    assert.equal(child.status, 0, `${phase} failed: ${child.error ?? child.stderr}; evidence: ${root}`);
    assert.equal(JSON.parse(readFileSync(join(root, `${phase}.json`), 'utf8')).passed, true);
  }
  console.log(`Window/reset acceptance passed (3 Electron processes): ${root}`);
} else { void (async () => {
  const { app, ipcMain, screen } = await import('electron');
  const { createPageWindow, SettingsWindow } = await import('../../dist/shell/electron/settingsWindow.js');
  const { completePendingBotDataReset, prepareBotDataReset, DATA_RESET_JOURNAL } = await import('../../dist/shell/electron/hub/dataReset.js');
  const { createDataResetHandler } = await import('../../dist/shell/electron/dataResetHandler.js');
  const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8);
  const root = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11);
  assert.ok(root && resolve(root).startsWith(resolve(tmpdir())), 'Use only disposable evidence storage');
  const home = join(root, 'reset-home');
  app.setPath('userData', join(root, 'electron'));
  app.on('window-all-closed', () => {});
  const timer = setTimeout(() => {
    writeFileSync(join(root, `${phase}.json`), JSON.stringify({ passed: false, error: 'Acceptance timed out' }));
    app.exit(1);
  }, 35_000);
  const wait = async (predicate, label) => {
    for (const deadline = Date.now() + 8_000; Date.now() < deadline;) {
      if (await predicate()) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const writeResult = extra => writeFileSync(join(root, `${phase}.json`), JSON.stringify({ passed: true,
    platform: process.platform, electron: process.versions.electron, ...extra }, null, 2));
  const put = (relative, content) => { const file = join(home, relative); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
  try {
    await app.whenReady();
    if (phase === 'runtime') {
      assert.equal(completePendingBotDataReset(home), true);
      assert.equal(existsSync(join(home, 'retained-runtime')), false);
      assert.equal(existsSync(join(home, DATA_RESET_JOURNAL)), false);
      writeResult({ runtimeErased: true }); clearTimeout(timer); app.quit();
    } else {
      const page = { preloadPath: join(repo, 'assets/preload.cjs'), rendererDir: join(repo, 'dist/renderer'), iconPath: join(repo, 'assets/icon.png') };
      const placementFile = join(root, 'window-state.json');
      const keys = ['setup', 'hub-settings', 'new-bot', 'bot-a-settings', 'bot-b-settings'];
      const expected = phase === 'restore' ? JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8')) : {};
      const area = screen.getPrimaryDisplay().workArea;
      for (const [index, key] of keys.entries()) {
        const window = createPageWindow({ ...page, placement: { file: placementFile, key } }, { title: `Fixture ${key}`, width: 860, height: 640 });
        if (phase === 'save') {
          window.showInactive();
          window.setBounds({ x: area.x + 20 + index * 16, y: area.y + 20 + index * 12, width: 860, height: 640 });
          await new Promise(done => setTimeout(done, 250));
          expected[key] = window.getBounds();
        } else { assert.deepEqual(window.getBounds(), expected[key], key); }
        window.close();
      }
      if (phase === 'save') {
        writeFileSync(join(root, 'expected.json'), JSON.stringify(expected));
        put('bots/fixture/profile.json', 'fixture bot data');
        put('bots/fixture/workspace/erase.txt', 'fixture product workspace');
        put('bots/fixture/runtime/config/keep.txt', 'fixture runtime');
        put('hub-state.json', '{"schemaVersion":1,"openAtLogin":false}');
      } else {
        assert.equal(completePendingBotDataReset(home), true);
        assert.equal(existsSync(join(home, 'bots')), false);
        assert.equal(existsSync(join(home, 'hub-state.json')), false);
        const retained = join(home, 'retained-runtime', readdirSync(join(home, 'retained-runtime'))[0], 'bots/fixture/config/keep.txt');
        assert.equal(readFileSync(retained, 'utf8'), 'fixture runtime');
      }
      ipcMain.handle('ui:language', () => ({ preference: 'zh-TW', locale: 'zh-TW' }));
      const settings = new SettingsWindow(page, { scope: 'hub' });
      const handler = createDataResetHandler({
        owns: event => settings.owns(event.sender.id) && event.senderFrame === event.sender.mainFrame,
        busy: () => false, drain: async () => {}, prepare: request => prepareBotDataReset(home, request),
        recover: () => {}, restart: () => {
          writeResult({ windowPositions: expected, runtimeRequested: phase === 'restore' });
          clearTimeout(timer); settings.destroy(); app.quit();
        },
      });
      ipcMain.handle('shell:resetData', handler);
      await settings.open('data');
      const window = settings.browserWindow;
      const evaluate = expression => window.webContents.executeJavaScript(expression);
      await wait(() => evaluate(`!!document.getElementById('data-reset-open')`), 'Data tab');
      await evaluate(`document.getElementById('data-reset-open').click()`);
      assert.equal(await evaluate(`document.getElementById('data-reset-runtime').checked`), false);
      assert.equal(await evaluate(`document.getElementById('data-reset-confirm').disabled`), true);
      assert.equal(await evaluate(`document.querySelector('dialog').open`), true);
      await evaluate(`document.querySelector('dialog button[type=button]').click()`);
      assert.equal(existsSync(join(home, DATA_RESET_JOURNAL)), false, 'Cancel does not reset');
      await evaluate(`document.getElementById('data-reset-open').click()`);
      if (phase === 'restore') await evaluate(`document.getElementById('data-reset-runtime').click()`);
      await evaluate(`const input=document.getElementById('data-reset-confirmation');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'RESET');
        input.dispatchEvent(new Event('input',{bubbles:true}));`);
      await wait(() => evaluate(`!document.getElementById('data-reset-confirm').disabled`), 'confirmation enabled');
      writeFileSync(join(root, `${phase}.png`), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.getElementById('data-reset-confirm').click()`);
    }
  } catch (error) {
    writeFileSync(join(root, `${phase}.json`), JSON.stringify({ passed: false, error: String(error), stack: error.stack }));
    console.error(error); clearTimeout(timer); app.exit(1);
  }
})().catch(error => { console.error(error); process.exitCode = 1; }); }
