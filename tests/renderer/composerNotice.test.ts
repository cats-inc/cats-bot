import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearComposerNotice,
  raiseComposerNotice,
} from '../../src/renderer/note/composerNotice.ts';

/** ADR-024: a failed composer tool is one notice in the composer, not a stack of transcript lines. */

test('each failure is a new notice, so the same failure twice is shown again', () => {
  const first = raiseComposerNotice('voice', 'No microphone was detected.');
  const again = raiseComposerNotice('voice', 'No microphone was detected.');
  assert.notEqual(first.id, again.id);
  assert.deepEqual({ ...again, id: 0 }, { id: 0, source: 'voice', message: 'No microphone was detected.', pane: null });
});

test('a tool working again clears only its own notice', () => {
  const voice = raiseComposerNotice('voice', 'No microphone was detected.');
  assert.equal(clearComposerNotice(voice, 'voice'), null);
  assert.equal(clearComposerNotice(voice, 'screenshot'), voice);
  assert.equal(clearComposerNotice(null, 'voice'), null);
  // A file too large and a refused send are separate: removing the file does not hide why a send failed.
  const tooLarge = raiseComposerNotice('attach', 'big.mov is larger than 10 MB');
  const refused = raiseComposerNotice('send', 'Could not send: offline');
  assert.equal(clearComposerNotice(tooLarge, 'attach'), null);
  assert.equal(clearComposerNotice(refused, 'attach'), refused);
  assert.equal(clearComposerNotice(refused, 'send'), null);
});

test('a permission notice keeps its pane for "Open System Settings" (ADR-020)', () => {
  assert.equal(raiseComposerNotice('voice', 'Microphone access was denied.', 'microphone').pane, 'microphone');
  assert.equal(raiseComposerNotice('voice', 'No microphone was detected.').pane, null);
});
