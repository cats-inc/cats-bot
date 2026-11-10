import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { getPngSize } from 'app-builder-lib/out/util/iconConverter.js';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const drawing = (svg: string) => svg.replace(/<!--[\s\S]*?-->/gu, '').replace(/\s+/gu, ' ').trim();

test('the tray icons ship at the sizes each platform loads', async () => {
  // tray.ts loads the 20pt macOS template and the Windows/Linux tile; Electron
  // picks up each @2x file beside its 1x one.
  const expected: Record<string, number> = {
    'tray-iconTemplate.png': 20,
    'tray-iconTemplate@2x.png': 40,
    'tray-icon.png': 32,
    'tray-icon@2x.png': 64,
  };
  for (const [file, size] of Object.entries(expected)) {
    assert.deepEqual(await getPngSize(join(root, 'assets', file)), { width: size, height: size }, file);
  }
  const tray = read('src/shell/electron/tray.ts');
  assert.ok(tray.includes("'tray-iconTemplate.png'") && tray.includes('setTemplateImage(true)'));
  assert.ok(tray.includes("'tray-icon.png'"));
});

test('the Windows/Linux tray tile nests the macOS template drawing unchanged', () => {
  const template = drawing(read('src/shell/electron/tray-icon-template.svg'));
  const tile = drawing(read('src/shell/electron/tray-icon.svg'));
  const templateRoot = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" (viewBox="[^"]+") color="#000">(.*)<\/svg>$/u.exec(template);
  const nested = /<svg x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" (viewBox="[^"]+") color="#fff">(.*)<\/svg> ?<\/svg>$/u.exec(tile);
  assert.ok(templateRoot, 'template root');
  assert.ok(nested, 'nested drawing');
  assert.equal(nested[1], templateRoot[1]);
  assert.equal(nested[2], templateRoot[2]);
  // Only currentColor paints the silhouette, so the root colour alone decides it.
  assert.doesNotMatch(templateRoot[2]!.replace(/<mask\b[\s\S]*?<\/mask>/u, ''), /(?:fill|stroke)="#/u);
});
