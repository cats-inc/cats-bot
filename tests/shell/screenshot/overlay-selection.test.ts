// Ported from Cats Desktop tests/desktop-screenshot-overlay-selection.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginScreenshotOverlayDrag,
  cancelScreenshotOverlaySelection,
  completeScreenshotOverlaySelection,
  createIdleScreenshotOverlaySelection,
  updateScreenshotOverlayDrag,
} from '../../../src/shared/screenshot/screenshotOverlaySelection.ts';

const DISPLAY = {
  bounds: { x: -1280, y: 0, width: 1280, height: 720 },
  imageSize: { width: 2560, height: 1440 },
  scaleFactor: 2,
};

test('desktop screenshot overlay selection starts and updates drag state', () => {
  const idle = createIdleScreenshotOverlaySelection();
  const dragging = beginScreenshotOverlayDrag({ x: -1000, y: 20 });
  const updated = updateScreenshotOverlayDrag(dragging, { x: -900, y: 70 });

  assert.deepEqual(idle, { phase: 'idle' });
  assert.deepEqual(updated, {
    phase: 'dragging',
    anchor: { x: -1000, y: 20 },
    current: { x: -900, y: 70 },
  });
});

test('desktop screenshot overlay selection returns physical crop on mouse-up', () => {
  const result = completeScreenshotOverlaySelection(
    beginScreenshotOverlayDrag({ x: -1180, y: 20 }),
    { x: -980, y: 120 },
    DISPLAY,
  );

  assert.deepEqual(result, {
    phase: 'selected',
    cssRect: { x: -1180, y: 20, width: 200, height: 100 },
    cropRect: { x: 200, y: 40, width: 400, height: 200 },
  });
});

test('desktop screenshot overlay selection cancels tiny clicks and explicit cancel actions', () => {
  assert.deepEqual(
    completeScreenshotOverlaySelection(
      beginScreenshotOverlayDrag({ x: -100, y: 10 }),
      { x: -97, y: 14 },
      DISPLAY,
    ),
    {
      phase: 'cancelled',
      reason: 'too_small',
    },
  );
  assert.deepEqual(cancelScreenshotOverlaySelection('escape'), {
    phase: 'cancelled',
    reason: 'escape',
  });
  assert.deepEqual(cancelScreenshotOverlaySelection('right_click'), {
    phase: 'cancelled',
    reason: 'right_click',
  });
});

test('desktop screenshot overlay selection ignores updates after terminal state', () => {
  const cancelled = cancelScreenshotOverlaySelection('escape');

  assert.equal(
    updateScreenshotOverlayDrag(cancelled, { x: 1, y: 1 }),
    cancelled,
  );
});
