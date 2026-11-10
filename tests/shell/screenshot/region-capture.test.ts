// Ported from Cats Desktop tests/desktop-screenshot-region-capture.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runDesktopScreenshotRegionCapture,
  toDesktopScreenshotCancelReason,
} from '../../../src/shell/electron/screenshot/screenshotRegionCapture.ts';

function createSnapshot() {
  return {
    displayId: 1,
    sourceId: 'screen:1:0',
    sourceName: 'Built-in',
    geometry: {
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
      imageSize: { width: 2000, height: 1600 },
      scaleFactor: 2,
    },
    png: new Uint8Array([1]),
  };
}

test('desktop screenshot region capture returns cropped PNG bridge result', async () => {
  const events: any[] = [];
  const result = await runDesktopScreenshotRegionCapture({
    async captureDisplaySnapshots() {
      events.push('capture');
      return [createSnapshot()];
    },
    async openOverlay(snapshots) {
      events.push(`overlay:${snapshots.length}`);
      return {
        async waitForResult() {
          events.push('wait');
          return {
            outcome: 'selected',
            region: {
              displayId: 1,
              sourceId: 'screen:1:0',
              width: 320,
              height: 180,
              cropRect: { x: 10, y: 20, width: 320, height: 180 },
              png: new Uint8Array([7, 8, 9]),
            },
          };
        },
        closeAll() {
          events.push('close');
        },
      };
    },
    createFilename() {
      return 'cats-screenshot-20260422-010203-001.png';
    },
  });

  assert.deepEqual(result, {
    outcome: 'ok',
    png: new Uint8Array([7, 8, 9]),
    mime: 'image/png',
    filename: 'cats-screenshot-20260422-010203-001.png',
    width: 320,
    height: 180,
  });
  assert.deepEqual(events, ['capture', 'overlay:1', 'wait', 'close']);
});

test('desktop screenshot region capture closes overlays after cancellation', async () => {
  const events: any[] = [];
  const result = await runDesktopScreenshotRegionCapture({
    async captureDisplaySnapshots() {
      return [createSnapshot()];
    },
    async openOverlay() {
      return {
        async waitForResult() {
          events.push('wait');
          return {
            outcome: 'cancelled',
            reason: 'escape',
          };
        },
        closeAll() {
          events.push('close');
        },
      };
    },
    createFilename() {
      throw new Error('filename should not be needed for cancellation');
    },
  });

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'user_cancel',
  });
  assert.deepEqual(events, ['wait', 'close']);
});

test('desktop screenshot region capture normalizes overlay cancel reasons', () => {
  assert.equal(toDesktopScreenshotCancelReason('too_small'), 'too_small');
  assert.equal(toDesktopScreenshotCancelReason('unknown_display'), 'unknown_display');
  assert.equal(toDesktopScreenshotCancelReason('unknown_display:42'), 'unknown_display');
  assert.equal(toDesktopScreenshotCancelReason('escape'), 'user_cancel');
  assert.equal(toDesktopScreenshotCancelReason('right_click'), 'user_cancel');
  assert.equal(toDesktopScreenshotCancelReason('no_drag'), 'user_cancel');
  assert.equal(toDesktopScreenshotCancelReason('something_new'), 'user_cancel');
});

test('desktop screenshot region capture returns unsupported when no displays exist', async () => {
  const result = await runDesktopScreenshotRegionCapture({
    async captureDisplaySnapshots() {
      return [];
    },
    async openOverlay() {
      throw new Error('overlay should not open without snapshots');
    },
    createFilename() {
      throw new Error('filename should not be needed without snapshots');
    },
  });

  assert.deepEqual(result, {
    outcome: 'platform_unsupported',
    message: 'No displays are available for screenshot capture.',
  });
});
