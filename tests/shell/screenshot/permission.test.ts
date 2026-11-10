// Ported from Cats Desktop tests/desktop-screenshot-permission.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDesktopScreenshotPermissionResult,
} from '../../../src/shell/electron/screenshot/screenshotPermission.ts';

test('desktop screenshot permission allows non-mac platforms', () => {
  assert.equal(
    resolveDesktopScreenshotPermissionResult({
      platform: 'win32',
      mediaAccessStatus: 'denied',
    }),
    null,
  );
});

test('desktop screenshot permission allows granted macOS screen access', () => {
  assert.equal(
    resolveDesktopScreenshotPermissionResult({
      platform: 'darwin',
      mediaAccessStatus: 'granted',
    }),
    null,
  );
});

test('desktop screenshot permission maps not-determined macOS screen access to contract outcome', () => {
  assert.deepEqual(
    resolveDesktopScreenshotPermissionResult({
      platform: 'darwin',
      mediaAccessStatus: 'not-determined',
    }),
    {
      outcome: 'permission_denied',
      message: 'Screen Recording permission is required to capture a screenshot. Turn on Cats Bot in System Settings > Privacy & Security > Screen & System Audio Recording (add it with + if it is not listed), then restart Cats Bot.',
    },
  );
});

test('desktop screenshot permission maps denied macOS screen access to contract outcome', () => {
  assert.deepEqual(
    resolveDesktopScreenshotPermissionResult({
      platform: 'darwin',
      mediaAccessStatus: 'denied',
    }),
    {
      outcome: 'permission_denied',
      message: 'Screen Recording permission is required to capture a screenshot. Turn on Cats Bot in System Settings > Privacy & Security > Screen & System Audio Recording (add it with + if it is not listed), then restart Cats Bot.',
    },
  );
});

test('desktop screenshot permission maps unknown macOS status to explicit error', () => {
  assert.deepEqual(
    resolveDesktopScreenshotPermissionResult({
      platform: 'darwin',
      mediaAccessStatus: 'unknown',
    }),
    {
      outcome: 'error',
      message: 'Screen Recording permission status is unknown: unknown',
    },
  );
});
