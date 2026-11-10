// Ported from Cats Desktop tests/desktop-screenshot-overlay-ipc.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_SCREENSHOT_OVERLAY_CANCEL_CHANNEL,
  DESKTOP_SCREENSHOT_OVERLAY_COMPLETE_CHANNEL,
  DESKTOP_SCREENSHOT_OVERLAY_GET_SNAPSHOT_CHANNEL,
  parseDesktopScreenshotOverlayCancelReason,
  parseDesktopScreenshotOverlayDisplayId,
  parseDesktopScreenshotOverlaySelectionResult,
} from '../../../src/shared/screenshot/screenshotOverlayIpc.ts';

test('desktop screenshot overlay IPC uses dedicated channels', () => {
  assert.equal(
    DESKTOP_SCREENSHOT_OVERLAY_GET_SNAPSHOT_CHANNEL,
    'cats-host:screenshot-overlay:get-snapshot',
  );
  assert.equal(
    DESKTOP_SCREENSHOT_OVERLAY_COMPLETE_CHANNEL,
    'cats-host:screenshot-overlay:complete-selection',
  );
  assert.equal(
    DESKTOP_SCREENSHOT_OVERLAY_CANCEL_CHANNEL,
    'cats-host:screenshot-overlay:cancel',
  );
});

test('desktop screenshot overlay IPC parses untrusted overlay payloads', () => {
  assert.equal(parseDesktopScreenshotOverlayDisplayId(2), 2);
  assert.equal(parseDesktopScreenshotOverlayCancelReason('escape'), 'escape');
  assert.deepEqual(
    parseDesktopScreenshotOverlaySelectionResult({
      displayId: 2,
      cssRect: { x: -1180, y: 20, width: 200, height: 100 },
      cropRect: { x: 200, y: 40, width: 400, height: 200 },
    }),
    {
      displayId: 2,
      cssRect: { x: -1180, y: 20, width: 200, height: 100 },
      cropRect: { x: 200, y: 40, width: 400, height: 200 },
    },
  );
  assert.throws(
    () => parseDesktopScreenshotOverlayDisplayId(Number.NaN),
    /Invalid screenshot overlay displayId/u,
  );
  assert.throws(
    () => parseDesktopScreenshotOverlaySelectionResult({ displayId: 2 }),
    /Invalid screenshot overlay cssRect rect/u,
  );
  assert.throws(
    () => parseDesktopScreenshotOverlayCancelReason(''),
    /Invalid screenshot overlay cancellation reason/u,
  );
});
