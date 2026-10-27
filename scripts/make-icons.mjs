// Renders src/renderer/cat.svg into the PNG icons the app ships:
//   assets/installer/icon.png (256x256, electron-builder makes the .ico from it)
//   assets/icon.png       (256x256, window icon at run time)
//   assets/tray-icon.png  (32x32) and assets/tray-icon@2x.png (64x64)
// Chromium does the rasterizing, so the repository needs no image tooling.
// Run with `npx electron scripts/make-icons.mjs` after changing the drawing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow } from 'electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'src', 'renderer', 'cat.svg'));
const targets = [
  [256, join(root, 'assets', 'installer', 'icon.png')],
  [256, join(root, 'assets', 'icon.png')],
  [32, join(root, 'assets', 'tray-icon.png')],
  [64, join(root, 'assets', 'tray-icon@2x.png')],
];

async function render() {
  // One capture at full size; the smaller icons are downscaled from it.
  const window = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  const page = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">`
    + `<img src="data:image/svg+xml;base64,${svg.toString('base64')}" width="256" height="256" style="display:block"></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const full = (await window.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 })).resize({ width: 256, height: 256, quality: 'best' });
  window.destroy();
  for (const [size, target] of targets) {
    mkdirSync(dirname(target), { recursive: true });
    const image = size === 256 ? full : full.resize({ width: size, height: size, quality: 'best' });
    writeFileSync(target, image.toPNG());
    console.log(`wrote ${target}`);
  }
}

// Electron does not emit ready while an ES module entry is still evaluating, so no top-level await.
app.disableHardwareAcceleration();
app.whenReady().then(render).then(() => app.quit(), (error) => {
  console.error(error);
  app.exit(1);
});
