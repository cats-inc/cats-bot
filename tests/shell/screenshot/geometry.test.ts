// Ported from Cats Desktop tests/desktop-screenshot-geometry.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPhysicalCropRectLargeEnough,
  mapCssSelectionToPhysicalCropRect,
  MIN_SCREENSHOT_SELECTION_PHYSICAL_PIXELS,
  normalizeDesktopScreenshotCssRect,
} from '../../../src/shared/screenshot/screenshotGeometry.ts';

test('desktop screenshot geometry normalizes reversed drag rectangles', () => {
  assert.deepEqual(
    normalizeDesktopScreenshotCssRect(
      { x: 420, y: 260 },
      { x: 120, y: 80 },
    ),
    {
      x: 120,
      y: 80,
      width: 300,
      height: 180,
    },
  );
});

test('desktop screenshot geometry maps HiDPI CSS selection to physical crop pixels', () => {
  assert.deepEqual(
    mapCssSelectionToPhysicalCropRect(
      { x: 10, y: 20, width: 300, height: 200 },
      {
        bounds: { x: 0, y: 0, width: 1000, height: 800 },
        imageSize: { width: 2000, height: 1600 },
        scaleFactor: 2,
      },
    ),
    {
      x: 20,
      y: 40,
      width: 600,
      height: 400,
    },
  );
});

test('desktop screenshot geometry handles displays with negative coordinates', () => {
  assert.deepEqual(
    mapCssSelectionToPhysicalCropRect(
      { x: -1180, y: 50, width: 200, height: 100 },
      {
        bounds: { x: -1280, y: 0, width: 1280, height: 720 },
        imageSize: { width: 1280, height: 720 },
        scaleFactor: 1,
      },
    ),
    {
      x: 100,
      y: 50,
      width: 200,
      height: 100,
    },
  );
});

test('desktop screenshot geometry rejects accidental tiny selections', () => {
  assert.equal(MIN_SCREENSHOT_SELECTION_PHYSICAL_PIXELS, 8);
  assert.equal(
    isPhysicalCropRectLargeEnough({ x: 0, y: 0, width: 7, height: 8 }),
    false,
  );
  assert.equal(
    isPhysicalCropRectLargeEnough({ x: 0, y: 0, width: 8, height: 8 }),
    true,
  );
});
