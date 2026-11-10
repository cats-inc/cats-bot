import assert from 'node:assert/strict';
import { test } from 'node:test';

import { screenshotOutcome } from '../../src/renderer/note/screenshot.ts';

/** SPEC-003 FR-9: what the composer does with a screenshot result, as Cats Desktop does. */

test('a picture becomes a waiting file, a cancelled one nothing, and anything else a message', async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const file = screenshotOutcome({ outcome: 'ok', png, mime: 'image/png', filename: 'cats-screenshot-1.png', width: 1, height: 1 });
  assert.equal(file.kind, 'file');
  if (file.kind === 'file') {
    assert.equal(file.file.name, 'cats-screenshot-1.png');
    assert.equal(file.file.type, 'image/png');
    assert.deepEqual(new Uint8Array(await file.file.arrayBuffer()), png);
  }
  assert.deepEqual(screenshotOutcome({ outcome: 'cancelled', reason: 'user_cancel' }), { kind: 'none' });
  assert.deepEqual(screenshotOutcome({ outcome: 'cancelled', reason: 'too_small' }), { kind: 'none' });
  assert.equal(screenshotOutcome({ outcome: 'cancelled', reason: 'unknown_display' }).kind, 'error');
  assert.deepEqual(screenshotOutcome({ outcome: 'error', message: 'No displays are available for screenshot capture.' }),
    { kind: 'error', message: 'No displays are available for screenshot capture.' });
  assert.match(screenshotOutcome({ outcome: 'permission_denied' }).kind === 'error' ? (screenshotOutcome({ outcome: 'permission_denied' }) as { message: string }).message : '', /Screen Recording/u);
  assert.match((screenshotOutcome({ outcome: 'platform_unsupported' }) as { message: string }).message, /unavailable/u);
});
