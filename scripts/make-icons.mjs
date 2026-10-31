// Renders src/renderer/cat.svg into the PNG icons the app ships:
//   assets/installer/icon.png (1024x1024, electron-builder makes .ico/.icns)
//   assets/installer/linux/<size>x<size>.png (standard hicolor sizes, 16–512)
//   assets/icon.png       (256x256, window icon at run time)
//   assets/tray-icon.png  (32x32) and assets/tray-icon@2x.png (64x64)
// Chromium does the rasterizing, so the repository needs no image tooling.
// Run with `npx electron scripts/make-icons.mjs` after changing the drawing.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow } from 'electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'src', 'renderer', 'cat.svg'));
const canvasSize = 1024;
mkdirSync(join(root, 'tmp'), { recursive: true });
const profile = mkdtempSync(join(root, 'tmp', 'make-icons-'));
app.setPath('appData', profile);
app.setPath('userData', profile);
const targets = [
  [canvasSize, join(root, 'assets', 'installer', 'icon.png')],
  [256, join(root, 'assets', 'icon.png')],
  [32, join(root, 'assets', 'tray-icon.png')],
  [64, join(root, 'assets', 'tray-icon@2x.png')],
  ...[16, 24, 32, 48, 64, 128, 256, 512].map((size) =>
    [size, join(root, 'assets', 'installer', 'linux', `${size}x${size}.png`)]),
];

async function render() {
  // One capture at full size; the smaller icons are downscaled from it.
  const window = new BrowserWindow({
    width: canvasSize,
    height: canvasSize,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  const page = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">`
    + `<img src="data:image/svg+xml;base64,${svg.toString('base64')}" width="${canvasSize}" height="${canvasSize}" style="display:block"></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const full = (await window.webContents.capturePage({ x: 0, y: 0, width: canvasSize, height: canvasSize })).resize({ width: canvasSize, height: canvasSize, quality: 'best' });
  window.destroy();
  for (const [size, target] of targets) {
    mkdirSync(dirname(target), { recursive: true });
    const image = size === canvasSize ? full : full.resize({ width: size, height: size, quality: 'best' });
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
