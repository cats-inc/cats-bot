import assert from 'node:assert/strict';
import { test } from 'node:test';

import { captureScreenshotRegion, parseDesktopScreenshotCaptureRequest } from '../../../src/shell/electron/screenshot/screenshotCapture.ts';

/** SPEC-003 FR-9: the windows that step aside for a capture always come back, in reverse order. */

test('every hidden window is given back after the capture, also when it fails', async () => {
  const calls: string[] = [];
  const hider = (name: string) => () => {
    calls.push(`hide ${name}`);
    return () => calls.push(`show ${name}`);
  };
  const result = await captureScreenshotRegion({
    hiders: [hider('note'), hider('cat')],
    waitForHiddenFrame: async () => { calls.push('wait'); },
    captureNativeRegion: async () => { calls.push('capture'); return { outcome: 'cancelled', reason: 'user_cancel' }; },
  });
  assert.deepEqual(result, { outcome: 'cancelled', reason: 'user_cancel' });
  assert.deepEqual(calls, ['hide note', 'hide cat', 'wait', 'capture', 'show cat', 'show note']);
  calls.length = 0;
  await assert.rejects(captureScreenshotRegion({
    hiders: [hider('note')],
    waitForHiddenFrame: async () => {},
    captureNativeRegion: async () => { throw new Error('boom'); },
  }), /boom/u);
  assert.deepEqual(calls, ['hide note', 'show note']);
});

test('only a composer screenshot request is accepted', () => {
  assert.deepEqual(parseDesktopScreenshotCaptureRequest({ source: 'composer' }), { source: 'composer' });
  assert.throws(() => parseDesktopScreenshotCaptureRequest({ source: 'elsewhere' }), /Invalid/u);
  assert.throws(() => parseDesktopScreenshotCaptureRequest(null), /Invalid/u);
});
