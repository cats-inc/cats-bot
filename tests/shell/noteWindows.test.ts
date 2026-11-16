import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { BotCore } from '../../src/core/bot.ts';
import type { ConversationRecord } from '../../src/core/types.ts';
import type { DesktopHost } from '../../src/shell/electron/win32Desktop.ts';
import { createMacDesktopHost } from '../../src/shell/electron/macDesktop.ts';
import { FakeMacWindows, LEVELS, NOTE_BEHAVIOR } from '../support/fake-mac-windows.ts';
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

async function shownNote(windows: InstanceType<typeof NoteWindows>, id: string) {
  const opening = windows.open(id);
  const window = BrowserWindow.instances.at(-1)!;
  window.loaded();
  await opening;
  window.setBounds({ x: 100, y: 120, width: 400, height: 500 });
  window.emit('resize');
  return window;
}

test('a maximized note keeps the size it restores to, also through macOS zoom frames that are not maximized yet', async t => {
  const { windows } = fixture(t);
  const window = await shownNote(windows, 'home');
  window.maximize({ zoomFrames: true });
  assert.deepEqual(pick(windows.shellState.views.home!), { x: 100, y: 120, width: 400, height: 500 });
  windows.flush();
  assert.deepEqual(pick(windows.shellState.views.home!), { x: 100, y: 120, width: 400, height: 500 }, 'quitting while maximized');
  window.unmaximize();
  assert.deepEqual(pick(windows.shellState.views.home!), { x: 100, y: 120, width: 400, height: 500 });
});

function pick({ x, y, width, height }: { x?: number; y?: number; width: number; height: number }) {
  return { x, y, width, height };
}

test('ADR-016: applying the layer again keeps a macOS note at its level, and the check puts back a level reset', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const mac = new FakeMacWindows();
  // Electron's setAlwaysOnTop() on macOS sets the window's level.
  const onTop = t.mock.method(BrowserWindow.prototype, 'setAlwaysOnTop', function (this: BrowserWindow, flag: boolean) {
    mac.setLevel(this.webContents.id, flag ? 3 : LEVELS.normal);
  });
  const { windows } = fixture(t, createMacDesktopHost(mac));
  windows.setLayer('home', 'desktop');
  const opening = windows.open('home', { restore: true });
  const window = BrowserWindow.instances[0]!;
  window.loaded();
  await opening;
  const view = window.webContents.id;
  assert.equal(mac.level(view), LEVELS.desktop);
  const calls = onTop.mock.callCount();
  windows.setLayer('home', 'desktop');
  assert.equal(onTop.mock.callCount(), calls, 'an attached note is not taken off its level');
  assert.equal(mac.level(view), LEVELS.desktop);
  mac.setLevel(view, LEVELS.normal);
  t.mock.timers.tick(5_000);
  assert.equal(mac.level(view), LEVELS.desktop);
  windows.setLayer('home', 'normal');
  assert.deepEqual(mac.windows.get(view), { level: LEVELS.normal, behavior: NOTE_BEHAVIOR, ignores: false, fronted: 0 });
});

test('ADR-016: a full-screen note stays an ordinary window until it leaves full screen and loses focus', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const mac = new FakeMacWindows();
  const { windows } = fixture(t, createMacDesktopHost(mac));
  windows.setLayer('home', 'desktop');
  const opening = windows.open('home');
  const window = BrowserWindow.instances[0]!;
  window.loaded();
  await opening;
  const view = window.webContents.id;
  assert.equal(mac.level(view), LEVELS.normal, 'an owner open lifts the note');
  window.setFullScreen(true);
  window.emit('blur');
  t.mock.timers.tick(400);
  assert.equal(mac.level(view), LEVELS.normal, 'not taken out of its full-screen Space');
  t.mock.timers.tick(5_000);
  assert.equal(mac.level(view), LEVELS.normal, 'nor by the periodic check');
  window.setFullScreen(false);
  window.emit('blur');
  t.mock.timers.tick(400);
  assert.equal(mac.level(view), LEVELS.desktop);
});

/** A conversation as the core lists it; only the role and the last message matter for arranging. */
function listed(id: string, role: 'home' | 'note', at: string) {
  return { id, role, title: id, createdAt: at, lastOwnerMessageAt: at, lastBotMessageAt: null } as unknown as ConversationRecord;
}

const CAT = { x: 1796, y: 920, width: 96, height: 96 };

async function arrangeFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { windows } = fixture(t, {
    isAttached: () => true, attachedLayer: () => 'wallpaper', attach: () => true, detach() {}, released() {},
    bringToFront: () => true, hostAlive: () => true, refresh: () => false,
  });
  const home = await shownNote(windows, 'home');
  windows.setLayer('pinned', 'top');
  const pinned = await shownNote(windows, 'pinned');
  pinned.setBounds({ x: 700, y: 50, width: 360, height: 480 });
  const wallpaper = await restoredNote(windows, 'wall', 'wallpaper');
  const closed = await shownNote(windows, 'closed');
  windows.hide('closed');
  const conversations = [listed('home', 'home', '2026-11-01T00:00:00.000Z'), listed('pinned', 'note', '2026-11-02T00:00:00.000Z'),
    listed('wall', 'note', '2026-11-03T00:00:00.000Z'), listed('closed', 'note', '2026-11-04T00:00:00.000Z')];
  return { windows, home, pinned, wallpaper, closed, conversations };
}

test('SPEC-002 FR-7b: only open ordinary and top-layer notes are arranged, without the focus', async t => {
  const { windows, home, pinned, wallpaper, closed, conversations } = await arrangeFixture(t);
  const wallpaperBounds = { ...wallpaper.getBounds() };
  assert.deepEqual(windows.arrangeable().map((note) => note.id).sort(), ['home', 'pinned']);
  const focus = BrowserWindow.instances.map((window) => window.focusCalls);
  BrowserWindow.raised = [];
  assert.equal(windows.arrange('stack', CAT, conversations), 2);
  assert.deepEqual(BrowserWindow.instances.map((window) => window.focusCalls), focus, 'arranging focuses nothing');
  assert.deepEqual(BrowserWindow.raised, [home.webContents.id, pinned.webContents.id], 'the top-layer note is raised last');
  // Kept inside the 1080-pixel test display: the front note ends 8 pixels above its bottom, one title bar lower.
  assert.deepEqual(home.getBounds(), { x: 1796 - 14 - 400, y: 1080 - 8 - 480 - 36, width: 400, height: 500 }, 'beside the cat, same size');
  assert.deepEqual(pinned.getBounds(), { x: 1796 - 14 - 360, y: 1080 - 8 - 480, width: 360, height: 480 });
  assert.deepEqual(wallpaper.getBounds(), wallpaperBounds, 'a wallpaper note stays where the owner put it');
  assert.equal(closed.isVisible(), false, 'a closed note is not opened');
  assert.deepEqual(pick(windows.shellState.views.home!), home.getBounds(), 'the new place is remembered');
});

test('SPEC-002 FR-7b: a maximized or minimized note is left as it is', async t => {
  const { windows, home, pinned } = await arrangeFixture(t);
  home.maximize();
  pinned.minimize();
  assert.deepEqual(windows.arrangeable(), []);
});

test('SPEC-002 FR-7b: Undo arrangement puts the notes back, a closed one included, once', async t => {
  const { windows, home, pinned, conversations } = await arrangeFixture(t);
  assert.equal(windows.canUndoArrangement(), false, 'nothing arranged yet');
  windows.arrange('spread', CAT, conversations);
  // Placed on a display with another scaling, the system may still nudge a window.
  home.setBounds({ ...home.getBounds(), y: home.getBounds().y + 1 });
  t.mock.timers.tick(400);
  assert.equal(windows.canUndoArrangement(), true, 'the system adjusting a note just placed is not the owner moving it');
  windows.hide('pinned');
  // Hub tray refreshes read the menu state; reading it changes nothing.
  assert.equal(windows.canUndoArrangement(), true);
  assert.equal(windows.undoArrangement(), true);
  assert.deepEqual(home.getBounds(), { x: 100, y: 120, width: 400, height: 500 });
  assert.equal(pinned.isVisible(), false);
  assert.equal(windows.canUndoArrangement(), false, 'one level only');
  await windows.open('pinned');
  assert.deepEqual(pinned.getBounds(), { x: 700, y: 50, width: 360, height: 480 }, 'a note closed since opens where it was');
});

test('SPEC-002 FR-7b: moving, resizing, maximizing, minimizing or attaching an arranged note ends Undo', async t => {
  const { windows, home, pinned, conversations } = await arrangeFixture(t);
  const changes: Array<[string, () => void, () => void]> = [
    ['moved', () => home.setBounds({ ...home.getBounds(), x: 10 }), () => {}],
    ['resized', () => pinned.setBounds({ ...pinned.getBounds(), width: 500 }), () => {}],
    ['maximized', () => home.maximize(), () => home.unmaximize()],
    ['minimized', () => pinned.minimize(), () => pinned.restore()],
    ['put on the wallpaper', () => windows.setLayer('home', 'wallpaper'), () => {}],
  ];
  for (const [what, change, back] of changes) {
    assert.equal(windows.arrange('stack', CAT, conversations), 2, what);
    t.mock.timers.tick(400);
    assert.equal(windows.canUndoArrangement(), true, what);
    change();
    const bounds = { ...home.getBounds() };
    assert.equal(windows.canUndoArrangement(), false, `${what}: the arrangement is the owner's now`);
    assert.equal(windows.undoArrangement(), false, what);
    assert.deepEqual(home.getBounds(), bounds, `${what}: nothing is put back`);
    back();
  }
  assert.equal(windows.arrange('stack', CAT, conversations), 1, 'the wallpaper note is left out now');
  windows.setLayer('pinned', 'desktop');
  assert.equal(windows.canUndoArrangement(), false, 'attaching ends Undo even right after placing');
});

test('SPEC-003 FR-9: a lifted desktop note hidden for a screenshot stays lifted, and settles once it is back without the focus', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const mac = new FakeMacWindows();
  const { windows } = fixture(t, createMacDesktopHost(mac));
  windows.setLayer('home', 'desktop');
  const opening = windows.open('home');
  const window = BrowserWindow.instances[0]!;
  window.loaded();
  await opening;
  const view = window.webContents.id;
  assert.equal(mac.level(view), LEVELS.normal, 'an owner open lifts the note');
  const restore = windows.hideForScreenshot('home');
  assert.equal(window.isVisible(), false);
  assert.equal(windows.shellState.views.home!.open, true, 'hidden, not closed');
  window.emit('blur');
  t.mock.timers.tick(5_400);
  assert.equal(mac.level(view), LEVELS.normal, 'not returned to its layer while hidden');
  restore();
  assert.equal(window.isVisible(), true);
  t.mock.timers.tick(400);
  assert.equal(mac.level(view), LEVELS.desktop, 'the focus did not come back, so it settles');
});
