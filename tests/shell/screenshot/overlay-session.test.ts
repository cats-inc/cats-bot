// Ported from Cats Desktop tests/desktop-screenshot-overlay-session.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DesktopScreenshotOverlaySession,
} from '../../../src/shell/electron/screenshot/screenshotOverlaySession.ts';

function createSnapshot() {
  return {
    displayId: 2,
    sourceId: 'screen:2:0',
    sourceName: 'Left display',
    geometry: {
      bounds: { x: -1280, y: 0, width: 1280, height: 720 },
      imageSize: { width: 2560, height: 1440 },
      scaleFactor: 2,
    },
    png: new Uint8Array([1, 2, 3]),
  };
}

test('desktop screenshot overlay session serves payloads by display id', () => {
  const session = new DesktopScreenshotOverlaySession([createSnapshot()], {
    cropPng() {
      throw new Error('crop should not run while reading snapshots');
    },
  } as any);

  assert.deepEqual(session.getSnapshot(2), {
    displayId: 2,
    sourceId: 'screen:2:0',
    sourceName: 'Left display',
    bounds: { x: -1280, y: 0, width: 1280, height: 720 },
    imageSize: { width: 2560, height: 1440 },
    scaleFactor: 2,
    imageDataUrl: 'data:image/png;base64,AQID',
  });
  assert.throws(() => session.getSnapshot(99), /Unknown screenshot overlay display/u);
});

test('desktop screenshot overlay session recomputes crop instead of trusting overlay cropRect', async () => {
  const cropCalls: any[] = [];
  const session = new DesktopScreenshotOverlaySession([createSnapshot()], {
    cropPng(sourcePng, cropRect) {
      cropCalls.push({ sourcePng: Array.from(sourcePng), cropRect });
      return new Uint8Array([9, 8, 7]);
    },
    resizePng() {
      throw new Error('bounded crop should not be resized');
    },
  });

  session.completeSelection({
    displayId: 2,
    cssRect: { x: -1180, y: 20, width: 200, height: 100 },
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
  });

  assert.deepEqual(cropCalls, [
    {
      sourcePng: [1, 2, 3],
      cropRect: { x: 200, y: 40, width: 400, height: 200 },
    },
  ]);
  assert.deepEqual(await session.waitForResult(), {
    outcome: 'selected',
    region: {
      displayId: 2,
      sourceId: 'screen:2:0',
      width: 400,
      height: 200,
      cropRect: { x: 200, y: 40, width: 400, height: 200 },
      png: new Uint8Array([9, 8, 7]),
    },
  });
});

test('desktop screenshot overlay session resolves cancellation once', async () => {
  const session = new DesktopScreenshotOverlaySession([createSnapshot()], {
    cropPng() {
      throw new Error('crop should not run after cancellation');
    },
  } as any);

  session.cancel('escape');
  session.cancel('right_click');

  assert.deepEqual(await session.waitForResult(), {
    outcome: 'cancelled',
    reason: 'escape',
  });
});
