import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { AppInfo } from 'app-builder-lib/out/appInfo.js';
import { LinuxTargetHelper } from 'app-builder-lib/out/targets/LinuxTargetHelper.js';
import { convertIcon, getPngSize } from 'app-builder-lib/out/util/iconConverter.js';

const root = resolve(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('Linux packaging supplies icons in standard hicolor sizes', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'cats-bot-linux-icons-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  // A single 1024px PNG is passed through unchanged by electron-builder, but
  // 1024x1024 is absent from standard hicolor themes and GTK cannot find it.
  const result = await convertIcon({
    sources: [pkg.build.linux.icon], fallbackSources: [], roots: [root], format: 'set', outDir,
  });
  assert.equal(result.isFallback, false);
  assert.deepEqual(result.icons.map((icon) => icon.size), [16, 24, 32, 48, 64, 128, 256, 512]);
  for (const icon of result.icons) {
    assert.deepEqual(await getPngSize(icon.file), { width: icon.size, height: icon.size });
  }
});

test('the Linux launcher filename, icon and window class share the Electron desktop identity', async () => {
  const metadata = { ...pkg, ...pkg.build.extraMetadata };
  const info = { metadata, config: pkg.build };
  const helper = new LinuxTargetHelper({
    info, config: pkg.build, appInfo: new AppInfo(info as never, null),
    executableName: pkg.build.linux.executableName, platformSpecificBuildOptions: pkg.build.linux,
    fileAssociations: [],
  } as never);
  assert.equal(metadata.desktopName, 'cats-bot.desktop');
  assert.equal(`${helper.getDesktopFileName()}.desktop`, metadata.desktopName);
  const entry = await helper.computeDesktopEntry(pkg.build.linux);
  assert.match(entry, /^Icon=cats-bot$/mu);
  assert.match(entry, /^StartupWMClass=cats-bot$/mu);
});
