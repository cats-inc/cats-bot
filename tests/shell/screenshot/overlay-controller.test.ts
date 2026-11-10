// Ported from Cats Desktop tests/desktop-screenshot-overlay-controller.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  openScreenshotOverlayWindows,
} from '../../../src/shell/electron/screenshot/screenshotOverlayController.ts';

function createPlan(id: number): any {
  return {
    displayId: id,
    sourceId: `screen:${id}:0`,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    url: `file:///overlay.html?displayId=${id}`,
    alwaysOnTop: { enabled: true, level: 'screen-saver' },
    options: {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      frame: false,
      transparent: true,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      focusable: true,
      acceptFirstMouse: true,
      fullscreenable: false,
      webPreferences: {
        preload: 'overlay-preload.cjs',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
  };
}

test('desktop screenshot overlay controller opens and closes planned windows', async () => {
  const events: any[] = [];
  const controller = await openScreenshotOverlayWindows(
    [createPlan(1), createPlan(2)],
    {
      createWindow(options) {
        const id = events.filter((event) => event.startsWith('create')).length + 1;
        events.push(`create:${id}:${options.width}x${options.height}`);
        let destroyed = false;
        return {
          setAlwaysOnTop(enabled, level) {
            events.push(`top:${id}:${enabled}:${level}`);
          },
          async loadURL(url) {
            events.push(`url:${id}:${url}`);
          },
          focus() {
            events.push(`focus:${id}`);
          },
          close() {
            destroyed = true;
            events.push(`close:${id}`);
          },
          isDestroyed() {
            return destroyed;
          },
        };
      },
    },
  );

  controller.closeAll();
  controller.closeAll();

  assert.deepEqual(events, [
    'create:1:100x100',
    'top:1:true:screen-saver',
    'url:1:file:///overlay.html?displayId=1',
    'focus:1',
    'create:2:100x100',
    'top:2:true:screen-saver',
    'url:2:file:///overlay.html?displayId=2',
    'focus:2',
    'close:1',
    'close:2',
  ]);
});

test('desktop screenshot overlay controller closes already-opened windows on load failure', async () => {
  const events: any[] = [];

  await assert.rejects(
    () => openScreenshotOverlayWindows(
      [createPlan(1), createPlan(2)],
      {
        createWindow() {
          const id = events.filter((event) => event.startsWith('create')).length + 1;
          events.push(`create:${id}`);
          return {
            setAlwaysOnTop() {
              events.push(`top:${id}`);
            },
            async loadURL() {
              events.push(`url:${id}`);
              if (id === 2) {
                throw new Error('load failed');
              }
            },
            close() {
              events.push(`close:${id}`);
            },
            isDestroyed() {
              return false;
            },
          };
        },
      },
    ),
    /load failed/u,
  );

  assert.deepEqual(events, [
    'create:1',
    'top:1',
    'url:1',
    'create:2',
    'top:2',
    'url:2',
    'close:1',
    'close:2',
  ]);
});

test('desktop screenshot overlay controller routes escape before renderer IPC', async () => {
  const events: any[] = [];
  let beforeInputListener: any = null;

  const controller = await openScreenshotOverlayWindows(
    [createPlan(1)],
    {
      createWindow() {
        return {
          setAlwaysOnTop() {},
          async loadURL() {},
          onBeforeInputEvent(listener) {
            beforeInputListener = listener;
            events.push('listen');
            return () => {
              events.push('unlisten');
              beforeInputListener = null;
            };
          },
          close() {
            events.push('close');
          },
          isDestroyed() {
            return false;
          },
        };
      },
    },
    {
      onEscape() {
        events.push('escape');
      },
    },
  );

  beforeInputListener(
    {
      preventDefault() {
        events.push('prevent');
      },
    },
    { key: 'Escape', type: 'keyDown' },
  );
  beforeInputListener(
    {
      preventDefault() {
        events.push('prevent-other');
      },
    },
    { key: 'A', type: 'keyDown' },
  );
  controller.closeAll();

  assert.deepEqual(events, [
    'listen',
    'prevent',
    'escape',
    'unlisten',
    'close',
  ]);
  assert.equal(beforeInputListener, null);
});

test('desktop screenshot overlay controller reports unexpected window closure', async () => {
  const events: any[] = [];
  let closeListener: any = null;

  await openScreenshotOverlayWindows(
    [createPlan(1)],
    {
      createWindow() {
        return {
          setAlwaysOnTop() {},
          async loadURL() {},
          onClosed(listener) {
            closeListener = listener;
            events.push('listen-close');
            return () => {
              events.push('unlisten-close');
              closeListener = null;
            };
          },
          close() {
            events.push('close');
          },
          isDestroyed() {
            return false;
          },
        };
      },
    },
    {
      onWindowClosed() {
        events.push('window-closed');
      },
    },
  );

  closeListener();

  assert.deepEqual(events, [
    'listen-close',
    'window-closed',
  ]);
});
