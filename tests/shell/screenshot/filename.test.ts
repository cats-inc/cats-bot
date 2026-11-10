// Ported from Cats Desktop tests/desktop-screenshot-filename.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDesktopScreenshotFilename,
} from '../../../src/shell/electron/screenshot/screenshotFilename.ts';

test('desktop screenshot host filenames remain unique within the same second', () => {
  const now = new Date(2026, 3, 22, 1, 2, 3, 456);

  assert.equal(
    createDesktopScreenshotFilename(now),
    'cats-screenshot-20260422-010203-001.png',
  );
  assert.equal(
    createDesktopScreenshotFilename(now),
    'cats-screenshot-20260422-010203-002.png',
  );
});
