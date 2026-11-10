// Ported from Cats Desktop tests/desktop-screenshot-overlay-windows.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildScreenshotOverlayWindowPlans,
} from '../../../src/shell/electron/screenshot/screenshotOverlayWindows.ts';

test('desktop screenshot overlay windows cover every display snapshot', () => {
  const plans = buildScreenshotOverlayWindowPlans({
    overlayUrl: 'file:///app/overlay.html',
    preloadPath: 'C:/app/build/desktop/overlay-preload.cjs',
    snapshots: [
      {
        displayId: 1,
        sourceId: 'screen:1:0',
        sourceName: 'Built-in',
        geometry: {
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          imageSize: { width: 1920, height: 1080 },
          scaleFactor: 1,
        },
        png: new Uint8Array([1]),
      },
      {
        displayId: 2,
        sourceId: 'screen:2:0',
        sourceName: 'Left',
        geometry: {
          bounds: { x: -1280, y: 0, width: 1280, height: 720 },
          imageSize: { width: 2560, height: 1440 },
          scaleFactor: 2,
        },
        png: new Uint8Array([2]),
      },
    ],
  });

  assert.equal(plans.length, 2);
  assert.equal(plans[1]?.url, 'file:///app/overlay.html?displayId=2');
  assert.deepEqual(plans[1]?.bounds, { x: -1280, y: 0, width: 1280, height: 720 });
  assert.deepEqual(plans[1]?.alwaysOnTop, {
    enabled: true,
    level: 'screen-saver',
  });
  assert.deepEqual(plans[1]?.options, {
    x: -1280,
    y: 0,
    width: 1280,
    height: 720,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    acceptFirstMouse: true,
    fullscreenable: false,
    webPreferences: {
      preload: 'C:/app/build/desktop/overlay-preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
});
