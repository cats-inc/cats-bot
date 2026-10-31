import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { BotCore } from '../../src/core/bot.ts';
import type { DesktopHost } from '../../src/shell/electron/win32Desktop.ts';
import { BrowserWindow } from '../support/note-windows-electron.ts';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'electron'
      ? { url: new URL('../support/note-windows-electron.ts', import.meta.url).href, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { NoteWindows } = await import('../../src/shell/electron/windows.ts');
hooks.deregister();

function fixture(t: TestContext, desktop?: DesktopHost) {
  const root = mkdtempSync(join(tmpdir(), 'cats-note-windows-'));
  const openViews = new Set<string>();
  let quitting = false;
  BrowserWindow.instances = [];
  const windows = new NoteWindows({
    botRoot: root, preloadPath: '', rendererDir: root, iconPath: '',
    isQuitting: () => quitting,
    desktop,
    core: {
      openView: async (id: string) => { openViews.add(id); },
      closeView: async (id: string) => { openViews.delete(id); },
      setViewFocused: async () => {},
    } as unknown as BotCore,
  });
  t.after(() => { quitting = true; windows.destroyAll(); rmSync(root, { recursive: true, force: true }); });
  return { windows, openViews, quit: () => { quitting = true; } };
}

test('a stale startup restore cannot reopen a note closed after startup selected it', async t => {
  const { windows, openViews } = fixture(t);
  const opening = windows.open('home');
  BrowserWindow.instances[0]!.loaded();
  const window = await opening;
  const restore = windows.previouslyOpen();
  windows.hide('home');
  for (const id of restore) await windows.open(id, { restore: true });
  assert.equal(window.isVisible(), false);
  assert.equal(windows.shellState.views.home!.open, false);
  assert.deepEqual([...openViews], []);
  assert.equal(await windows.open('home'), window, 'an explicit owner open still works');
  assert.equal(window.isVisible(), true);
  assert.deepEqual([...openViews], ['home']);
});

test('overlapping opens wait for page load and a later close cancels their display', async t => {
  const { windows, openViews } = fixture(t);
  const restored = windows.open('home', { restore: true });
  const ownerOpen = windows.open('home');
  const window = BrowserWindow.instances[0]!;
  assert.equal(window.isVisible(), false, 'a second launch must not show a half-loaded note');
  windows.hide('home');
  window.loaded();
  await Promise.all([restored, ownerOpen]);
  assert.equal(BrowserWindow.instances.length, 1);
  assert.equal(window.isVisible(), false, 'load completion must respect the last close');
  assert.equal(windows.shellState.views.home!.open, false);
  assert.deepEqual([...openViews], []);
});

test('an explicit open after a pending close can still show the loaded note', async t => {
  const { windows, openViews } = fixture(t);
  const first = windows.open('home', { restore: true });
  windows.hide('home');
  const reopened = windows.open('home');
  BrowserWindow.instances[0]!.loaded();
  assert.equal(await first, await reopened);
  assert.equal((await reopened).isVisible(), true);
  assert.equal(windows.shellState.views.home!.open, true);
  assert.deepEqual([...openViews], ['home']);
});

test('a pending startup restore cannot display a forgotten note or a quitting bot', async t => {
  for (const action of ['forget', 'quit'] as const) {
    const { windows, openViews, quit } = fixture(t);
    const opening = windows.open('home', { restore: true });
    const window = BrowserWindow.instances[0]!;
    if (action === 'forget') windows.forget('home');
    else quit();
    window.loaded();
    await opening;
    assert.equal(window.isVisible(), false, action);
    assert.deepEqual([...openViews], []);
  }
});

test('a delayed desktop focus event cannot lift a hidden note', async t => {
  let raised = 0;
  const { windows } = fixture(t, {
    isAttached: () => true,
    attachedLayer: () => 'desktop',
    attach: () => true,
    detach() {},
    released() {},
    bringToFront: () => { raised++; return true; },
    hostAlive: () => true,
    refresh: () => false,
  });
  windows.setLayer('home', 'desktop');
  const opening = windows.open('home', { restore: true });
  const window = BrowserWindow.instances[0]!;
  window.loaded();
  await opening;
  windows.hide('home');
  window.webContents.emit('focus');
  assert.equal(raised, 0);
  assert.equal(window.isVisible(), false);
});

/**
 * A desktop host that records which windows the shell reported hidden or destroyed, whether the
 * shell said each was shown until then, and their state when reported.
 */
function recordingHost(layer: 'desktop' | 'wallpaper') {
  const released: Array<{ handles: number[]; shown: boolean[]; visible: boolean[]; destroyed: boolean[] }> = [];
  const host: DesktopHost = {
    isAttached: () => true,
    attachedLayer: () => layer,
    attach: () => true,
    detach() {},
    released(list) {
      const windows = list.map(({ window: handle }) => BrowserWindow.instances.find((window) => window.webContents.id === handle)!);
      released.push({
        handles: list.map(({ window }) => window),
        shown: list.map(({ shown }) => shown),
        visible: windows.map((window) => window.isVisible()),
        destroyed: windows.map((window) => window.isDestroyed()),
      });
    },
    bringToFront: () => true,
    hostAlive: () => true,
    refresh: () => false,
  };
  return { host, released };
}

async function restoredNote(windows: InstanceType<typeof NoteWindows>, id: string, layer: 'desktop' | 'wallpaper') {
  windows.setLayer(id, layer);
  const opening = windows.open(id, { restore: true });
  const window = BrowserWindow.instances.at(-1)!;
  window.loaded();
  await opening;
  return window;
}

test('ADR-011: hiding an attached note reports it after it is hidden, so the wallpaper is drawn again', async t => {
  const { host, released } = recordingHost('wallpaper');
  const { windows } = fixture(t, host);
  const window = await restoredNote(windows, 'home', 'wallpaper');
  windows.hide('home');
  assert.deepEqual(released, [{ handles: [window.webContents.id], shown: [true], visible: [false], destroyed: [false] }]);
});

test('ADR-011: a forgotten note is reported once it is hidden and destroyed', async t => {
  const { host, released } = recordingHost('wallpaper');
  const { windows } = fixture(t, host);
  const window = await restoredNote(windows, 'home', 'wallpaper');
  windows.forget('home');
  assert.deepEqual(released, [{ handles: [window.webContents.id], shown: [true], visible: [false], destroyed: [true] }]);
});

test('ADR-011: a note hidden before it is forgotten is reported as not shown, so nothing is redrawn for it', async t => {
  const { host, released } = recordingHost('wallpaper');
  const { windows } = fixture(t, host);
  const window = await restoredNote(windows, 'home', 'wallpaper');
  windows.hide('home');
  windows.forget('home');
  assert.deepEqual(released.at(-1), { handles: [window.webContents.id], shown: [false], visible: [false], destroyed: [true] });
});

test('ADR-011: a note Electron closes while the app quits is hidden and reported, and opens again next time', async t => {
  const { host, released } = recordingHost('wallpaper');
  const { windows, quit } = fixture(t, host);
  const window = await restoredNote(windows, 'home', 'wallpaper');
  quit();
  window.close();
  assert.deepEqual(released, [{ handles: [window.webContents.id], shown: [true], visible: [false], destroyed: [false] }]);
  assert.equal(window.isDestroyed(), true, 'not kept open as an owner close would be');
  assert.equal(windows.shellState.views.home!.open, true);
});

test('ADR-011: quitting reports every note in one call after all of them are gone', async t => {
  const { host, released } = recordingHost('wallpaper');
  const { windows } = fixture(t, host);
  const first = await restoredNote(windows, 'home', 'wallpaper');
  const second = await restoredNote(windows, 'second', 'wallpaper');
  windows.destroyAll();
  assert.deepEqual(released, [{
    handles: [first.webContents.id, second.webContents.id],
    shown: [true, true],
    visible: [false, false],
    destroyed: [true, true],
  }]);
  windows.destroyAll();
  assert.equal(released.length, 1, 'nothing left to report');
});
