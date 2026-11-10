import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ATTACHED_BEHAVIOR, createMacDesktopHost } from '../../src/shell/electron/macDesktop.ts';
import { FakeMacWindows, LEVELS, NOTE_BEHAVIOR } from '../support/fake-mac-windows.ts';

/** SPEC-002 FR-8 / ADR-016: the macOS desktop and wallpaper layers, over fake AppKit windows. */

test('a note on the desktop layer sits above the icons on every Space and takes the mouse', () => {
  const windows = new FakeMacWindows();
  const host = createMacDesktopHost(windows);
  const view = windows.add(1);
  assert.equal(host.attach(view, 'desktop'), true);
  assert.deepEqual(windows.windows.get(view), { level: LEVELS.desktop, behavior: ATTACHED_BEHAVIOR, ignores: false, fronted: 0 });
  assert.equal(host.isAttached(view), true);
  assert.equal(host.attachedLayer(view), 'desktop');
  assert.equal(host.hostAlive(view), true);
});

test('a note on the wallpaper layer sits below the icons and takes no input', () => {
  const windows = new FakeMacWindows();
  const host = createMacDesktopHost(windows);
  const view = windows.add(1);
  host.attach(view, 'wallpaper');
  assert.deepEqual(windows.windows.get(view), { level: LEVELS.wallpaper, behavior: ATTACHED_BEHAVIOR, ignores: true, fronted: 0 });
  assert.equal(host.attachedLayer(view), 'wallpaper');
});

test('detaching gives the note back the level and Spaces behaviour it had, also after moving between layers', () => {
  const windows = new FakeMacWindows();
  const host = createMacDesktopHost(windows);
  const view = windows.add(1);
  host.attach(view, 'wallpaper');
  host.attach(view, 'desktop');
  assert.equal(windows.windows.get(view)!.ignores, false, 'the desktop layer takes the mouse again');
  host.detach(view);
  assert.deepEqual(windows.windows.get(view), { level: LEVELS.normal, behavior: NOTE_BEHAVIOR, ignores: false, fronted: 0 });
  assert.equal(host.isAttached(view), false);
  assert.equal(host.attachedLayer(view), null);
  host.detach(view);
  assert.deepEqual(windows.windows.get(view), { level: LEVELS.normal, behavior: NOTE_BEHAVIOR, ignores: false, fronted: 0 }, 'a second detach does nothing');
});

test('a level Electron resets is found, and attaching again keeps what the note had as an ordinary window', () => {
  const windows = new FakeMacWindows();
  const host = createMacDesktopHost(windows);
  const view = windows.add(1);
  host.attach(view, 'desktop');
  // Electron's setAlwaysOnTop(false): the normal level, and a managed behaviour.
  Object.assign(windows.windows.get(view)!, { level: LEVELS.normal, behavior: ATTACHED_BEHAVIOR | (1 << 2) });
  assert.equal(host.isAttached(view), true, 'the host still manages the window');
  assert.equal(host.attachedLayer(view), null);
  assert.equal(host.hostAlive(view), false, "so the shell's periodic check attaches it again");
  host.attach(view, 'desktop');
  assert.equal(host.attachedLayer(view), 'desktop');
  host.detach(view);
  assert.deepEqual(windows.windows.get(view), { level: LEVELS.normal, behavior: NOTE_BEHAVIOR, ignores: false, fronted: 0 });
});

test('released windows are never messaged: a destroyed note may be freed already', () => {
  const windows = new FakeMacWindows();
  const host = createMacDesktopHost(windows);
  const view = windows.add(1);
  host.attach(view, 'wallpaper');
  windows.freed.add(view);
  host.released([{ window: view, shown: true }]);
  assert.equal(host.refresh(), false);
});

test('a hidden note keeps what it had as an ordinary window until it is lifted', () => {
  const windows = new FakeMacWindows();
  const host = createMacDesktopHost(windows);
  const view = windows.add(1);
  host.attach(view, 'desktop');
  host.released([{ window: view, shown: true }]);
  host.detach(view);
  assert.deepEqual(windows.windows.get(view), { level: LEVELS.normal, behavior: NOTE_BEHAVIOR, ignores: false, fronted: 0 });
});

test('bringing a lifted note to the front orders its window front', () => {
  const windows = new FakeMacWindows();
  const host = createMacDesktopHost(windows);
  const view = windows.add(1);
  assert.equal(host.bringToFront(view), true);
  assert.equal(windows.windows.get(view)!.fronted, 1);
});

test('the macOS package keeps only koffi\'s two macOS binaries, allowed in both halves of the universal app', async () => {
  const { readFileSync } = await import('node:fs');
  const { matchesGlob } = await import('node:path');
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const excluded = (path: string) => (pkg.build.mac.files as string[]).some((pattern) => pattern.startsWith('!') && matchesGlob(path, pattern.slice(1)));
  for (const arch of ['darwin_arm64', 'darwin_x64']) {
    const binary = `node_modules/koffi/build/koffi/${arch}/koffi.node`;
    assert.equal(excluded(binary), false, arch);
    assert.equal(matchesGlob(`Contents/Resources/app/${binary}`, pkg.build.mac.x64ArchFiles), true, arch);
  }
  for (const arch of ['win32_x64', 'linux_x64', 'musl_arm64', 'freebsd_x64', 'openbsd_ia32'])
    assert.equal(excluded(`node_modules/koffi/build/koffi/${arch}/koffi.node`), true, arch);
  assert.equal(pkg.build.linux.files.at(-1), '!node_modules/koffi/**', 'Linux has no desktop layers yet');
});

test('a platform files list repeats the shared one, which electron-builder replaces rather than extends', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  // A list of only exclusions makes electron-builder package the whole checkout (sources, docs, tests, native builds).
  for (const platform of ['win', 'mac', 'linux']) {
    const files = pkg.build[platform].files as string[] | undefined;
    if (files) assert.deepEqual(files.slice(0, pkg.build.files.length), pkg.build.files, platform);
  }
});
