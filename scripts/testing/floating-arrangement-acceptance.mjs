// Build first. Usage: electron scripts/testing/floating-arrangement-acceptance.mjs
// Real FloatingBot/native windows, temporary Electron data, no Bot/core/provider.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import { FloatingBot } from '../../dist/shell/electron/floatingBot.js';
import { arrangeFloating, FLOATING_CAT } from '../../dist/shell/electron/floatingPlacement.js';

const evidence = mkdtempSync(join(tmpdir(), 'cats-floating-arrangement-'));
app.setPath('userData', evidence);
app.on('window-all-closed', () => {});
writeFileSync(join(evidence, 'preload.cjs'), '');
writeFileSync(join(evidence, 'floating.html'), '<!doctype html><title>Arrangement fixture</title><body>Cat fixture</body>');
const cats = [];
let note;
const deadline = setTimeout(() => {
  console.error('Timed out waiting for avatar arrangement acceptance.');
  finish(1);
}, 30_000);

async function main() {
  await app.whenReady();
  const positions = arrangeFloating(3, screen.getPrimaryDisplay().workArea);
  note = new BrowserWindow({ show: false });
  const noteId = note.id;
  for (let index = 0; index < 3; index++) {
    const state = { visible: index !== 1, x: -100_000, y: -100_000 };
    let saved;
    const cat = new FloatingBot({
      preloadPath: join(evidence, 'preload.cjs'), rendererDir: evidence, iconPath: '',
      avatar: () => 'white-tabby', state: () => state, persist: () => { saved = { ...state }; },
    });
    cats.push(cat);
    if (state.visible) await cat.show();
    if (index === 0) cat.moveTo(-100_000, -100_000);
    const old = cat.browserWindow;
    await cat.reset(positions[index]);
    const window = cat.browserWindow;
    assert.ok(window && window.isVisible());
    assert.equal(window.isFocusable(), false);
    if (old) {
      assert.ok(old.isDestroyed());
      assert.notEqual(window.id, old.id);
    }
    assert.equal(saved.visible, true);
    assert.deepEqual({ x: saved.x, y: saved.y }, positions[index]);
    const bounds = await window.webContents.executeJavaScript(`({x:screenX,y:screenY})`);
    assert.deepEqual(bounds, positions[index]);
    // Repeated arrange clicks while a replacement is loading must leave only the latest window.
    const first = cat.reset(positions[index]);
    const superseded = cat.browserWindow;
    const second = cat.reset(positions[index]);
    await Promise.all([first, second]);
    assert.ok(superseded.isDestroyed());
    assert.ok(cat.browserWindow.isVisible());
    assert.equal(cat.browserWindow.isFocusable(), false);
    const hiding = cat.reset(positions[index]);
    cat.hide();
    await hiding;
    assert.equal(cat.browserWindow.isVisible(), false, 'hiding during reset is respected');
    await cat.reset(positions[index]);
    console.log(`PASS: avatar ${index + 1} recreation, repeated resets, hide and saved position`);
  }
  assert.equal(note.id, noteId);
  assert.equal(note.isDestroyed(), false, 'arrangement leaves note windows intact');
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    assert.equal(screen.listenerCount(event), cats.length, 'each cat retains one display watcher');
  }
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ passed: true, positions, catSize: FLOATING_CAT }));
  console.log('PASS: hidden/offscreen avatars are recreated, placed and persisted; repeated reset/hide is safe; notes remain intact.');
}

app.whenReady().then(main).then(() => finish(0), error => {
  console.error(error);
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ passed: false, error: String(error) }));
  finish(1);
});
function finish(code) {
  clearTimeout(deadline);
  for (const cat of cats) cat.destroy();
  note?.destroy();
  console.log(`Evidence: ${evidence}`);
  app.exit(code);
}
