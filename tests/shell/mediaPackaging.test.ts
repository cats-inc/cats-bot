import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

interface Matcher {
  createFilter(): (file: string, stats: Stats) => boolean;
}
const { getNodeModuleFileMatcher } = createRequire(import.meta.url)(
  'app-builder-lib/out/fileMatcher.js',
) as {
  getNodeModuleFileMatcher(
    root: string,
    target: string,
    expand: (value: string) => string,
    platform: unknown,
    packager: unknown,
  ): Matcher;
};
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  build: { files: string[]; win: unknown; mac: unknown; linux: unknown };
};

test('production dependency filters omit optional media binaries at every depth and retain Runtime/updater modules', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cats-media-filter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const omitted = [
    'node_modules/ffmpeg-static/ffmpeg',
    'node_modules/ffmpeg-static/index.js',
    'node_modules/ffprobe-static/bin/darwin/x64/ffprobe',
    'node_modules/ffprobe-static/index.js',
    'node_modules/@cats-inc/cats-runtime/node_modules/ffmpeg-static/ffmpeg',
    'node_modules/@cats-inc/cats-runtime/node_modules/ffprobe-static/index.js',
  ];
  const retained = [
    'node_modules/@cats-inc/cats-runtime/build/runtime/index.js',
    'node_modules/@cats-inc/cats-runtime/build/core/media/sources.js',
    'node_modules/electron-updater/out/main.js',
  ];
  for (const file of [...omitted, ...retained]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'fixture');
  }
  for (const platform of ['win', 'mac', 'linux'] as const) {
    // This is the production-dependency matcher electron-builder actually uses,
    // which combines global and platform exclusions independently of source globs.
    const filter = getNodeModuleFileMatcher(
      root,
      join(root, 'out'),
      (value) => value,
      pkg.build[platform],
      { config: pkg.build, debugLogger: { isEnabled: false } },
    ).createFilter();
    for (const file of omitted)
      assert.equal(
        filter(join(root, file), lstatSync(join(root, file))),
        false,
        `${platform}: ${file}`,
      );
    for (const file of retained)
      assert.equal(
        filter(join(root, file), lstatSync(join(root, file))),
        true,
        `${platform}: ${file}`,
      );
  }
});
