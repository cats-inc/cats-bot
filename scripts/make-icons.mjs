import { renderIconVariants } from './shared/icon-pipeline.mjs';
// Renders the drawings into the PNG icons the app ships:
//   src/renderer/cat.svg ->
//     assets/installer/icon.png (1024x1024, electron-builder makes .ico/.icns)
//     assets/installer/linux/<size>x<size>.png (standard hicolor sizes, 16–512)
//     assets/icon.png       (256x256, window icon at run time)
//   src/shell/electron/tray-icon-template.svg ->
//     assets/tray-iconTemplate.png (20x20) and assets/tray-iconTemplate@2x.png (40x40),
//     the macOS menu-bar template
//   src/shell/electron/tray-icon.svg ->
//     assets/tray-icon.png  (32x32) and assets/tray-icon@2x.png (64x64), Windows and Linux
// Chromium does the rasterizing, so the repository needs no image tooling.
// Run with `npx electron scripts/make-icons.mjs` after changing a drawing.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow } from 'electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const canvasSize = 1024;
mkdirSync(join(root, 'tmp'), { recursive: true });
const profile = mkdtempSync(join(root, 'tmp', 'make-icons-'));
app.setPath('appData', profile);
app.setPath('userData', profile);
const sources = [
  [join('src', 'renderer', 'cat.svg'), [
    [canvasSize, join(root, 'assets', 'installer', 'icon.png')],
    [256, join(root, 'assets', 'icon.png')],
    ...[16, 24, 32, 48, 64, 128, 256, 512].map((size) =>
      [size, join(root, 'assets', 'installer', 'linux', `${size}x${size}.png`)]),
  ]],
  // macOS uses only a template's alpha, so the drawing's colour does not matter.
  [join('src', 'shell', 'electron', 'tray-icon-template.svg'), [
    [20, join(root, 'assets', 'tray-iconTemplate.png')],
    [40, join(root, 'assets', 'tray-iconTemplate@2x.png')],
  ]],
  [join('src', 'shell', 'electron', 'tray-icon.svg'), [
    [32, join(root, 'assets', 'tray-icon.png')],
    [64, join(root, 'assets', 'tray-icon@2x.png')],
  ]],
];

async function renderSource(window, svg, targets) {
  // Chromium draws the vector straight onto a canvas of each icon's size, so a
  // 20px template is rasterized at 20px rather than downscaled, which would
  // leave a halo around it. The page is at most the root <svg>'s own size.
  const sized = svg.toString('utf8').replace('<svg ', `<svg width="${canvasSize}" height="${canvasSize}" `);
  const page = `<!doctype html><html><body>`
    + `<img src="data:image/svg+xml;base64,${Buffer.from(sized).toString('base64')}"></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  return renderIconVariants(svg, targets.map(([size]) => size), {
    render: async (_svg, size) => Buffer.from(await window.webContents.executeJavaScript(`(async () => {
      const image = document.images[0];
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
      return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
    })()`), 'base64'),
  });
}

async function render() {
  const window = new BrowserWindow({
    width: canvasSize,
    height: canvasSize,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  for (const [source, targets] of sources) {
    const variants = await renderSource(window, readFileSync(join(root, source)), targets);
    for (const [size, target] of targets) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, variants.get(size));
      console.log(`wrote ${target}`);
    }
  }
  window.destroy();
}

// Electron does not emit ready while an ES module entry is still evaluating, so no top-level await.
app.disableHardwareAcceleration();
app.whenReady().then(render).then(() => app.quit(), (error) => {
  console.error(error);
  app.exit(1);
});
