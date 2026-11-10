// Ported from Cats Desktop tests/desktop-screenshot-overlay-payload.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildScreenshotOverlaySnapshotPayload,
  buildScreenshotOverlaySnapshotPayloads,
  encodePngDataUrl,
} from '../../../src/shell/electron/screenshot/screenshotOverlayPayload.ts';

test('desktop screenshot overlay payload encodes PNG data URLs', () => {
  assert.equal(encodePngDataUrl(new Uint8Array([1, 2, 3])), 'data:image/png;base64,AQID');
});

test('desktop screenshot overlay payload preserves display geometry metadata', () => {
  const snapshot = {
    displayId: 2,
    sourceId: 'screen:2:0',
    sourceName: 'Left display',
    geometry: {
      bounds: { x: -1280, y: 0, width: 1280, height: 720 },
      imageSize: { width: 2560, height: 1440 },
      scaleFactor: 2,
    },
    png: new Uint8Array([4, 5, 6]),
  };

  assert.deepEqual(buildScreenshotOverlaySnapshotPayload(snapshot), {
    displayId: 2,
    sourceId: 'screen:2:0',
    sourceName: 'Left display',
    bounds: { x: -1280, y: 0, width: 1280, height: 720 },
    imageSize: { width: 2560, height: 1440 },
    scaleFactor: 2,
    imageDataUrl: 'data:image/png;base64,BAUG',
  });
  assert.equal(buildScreenshotOverlaySnapshotPayloads([snapshot]).length, 1);
});
