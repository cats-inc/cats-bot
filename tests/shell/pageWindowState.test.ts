import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fitPageWindow, readPageWindowPlacement } from '../../src/shell/electron/pageWindowState.ts';
import { BrowserWindow } from '../support/note-windows-electron.ts';

const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'electron' ? { url: new URL('../support/note-windows-electron.ts', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { createPageWindow, SettingsWindow } = await import('../../src/shell/electron/settingsWindow.ts');
hooks.deregister();

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cats-page-placement-'));
  const file = join(root, 'window-state.json');
  BrowserWindow.instances = [];
  t.after(() => { for (const window of BrowserWindow.instances) if (!window.isDestroyed()) window.destroy(); rmSync(root, { recursive: true, force: true }); });
  const options = (key: string) => ({ preloadPath: '', rendererDir: '', iconPath: '', placement: { file, key } });
  const create = (key: string) => createPageWindow(options(key), { width: 860, height: 640, title: key }) as unknown as BrowserWindow;
  return { root, file, options, create };
}

test('setup, hub, new-bot and individual bot settings persist independent positions across recreation', t => {
  const { create } = fixture(t);
  for (const [index, key] of ['setup', 'hub-settings', 'new-bot', 'bot-a', 'bot-b'].entries()) {
    const window = create(key);
    window.setBounds({ x: index * 80, y: 75, width: 900, height: 700 });
    window.emit('move'); window.close();
  }
  for (const [index, key] of ['setup', 'hub-settings', 'new-bot', 'bot-a', 'bot-b'].entries()) {
    assert.deepEqual(create(key).getBounds(), { x: index * 80, y: 75, width: 900, height: 700 });
  }
});

test('maximized/fullscreen windows keep normal bounds and destroy flushes pending moves', t => {
  const { create, file } = fixture(t);
  const window = create('settings');
  window.setBounds({ x: 125, y: 100, width: 900, height: 700 }); window.emit('move');
  window.maximize(); window.destroy();
  assert.deepEqual(readPageWindowPlacement({ file, key: 'settings' }), { x: 125, y: 100, width: 900, height: 700, maximized: true, fullScreen: false });
  const restored = create('settings');
  assert.equal(restored.isMaximized(), true); restored.unmaximize();
  restored.setFullScreen(true); restored.close();
  assert.equal(create('settings').isFullScreen(), true);
});

test('offscreen placement is clamped and small/negative-origin work areas stay usable', t => {
  const { create } = fixture(t);
  const window = create('setup');
  window.setBounds({ x: -4000, y: 2500, width: 2400, height: 1800 }); window.emit('resize'); window.close();
  assert.deepEqual(create('setup').getBounds(), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(fitPageWindow({ x: -3000, y: -1000, width: 900, height: 700 },
    { x: -600, y: -100, width: 600, height: 400 }, { width: 800, height: 600 }), { x: -600, y: -100, width: 600, height: 400 });
});

test('invalid geometry defaults without rewriting; corrupt files survive later window moves', t => {
  const { create, file } = fixture(t);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, windows: { setup: { x: 'bad', y: 0, width: 800, height: 600 } } }));
  assert.equal(create('setup').getBounds().width, 860);
  writeFileSync(file, '{corrupt');
  const window = create('hub-settings'); window.emit('move'); window.close();
  assert.equal(readFileSync(file, 'utf8'), '{corrupt');
});

test('a Settings page closed during load cannot show itself after load finishes', async t => {
  const { options } = fixture(t);
  const settings = new SettingsWindow(options('hub-settings'), { scope: 'hub' });
  const opening = settings.open();
  const window = BrowserWindow.instances.at(-1)!; window.close(); window.loaded();
  await opening; assert.equal(window.isVisible(), false);
});
