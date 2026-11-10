import assert from 'node:assert/strict';
import { test } from 'node:test';

import { insertTranscript, voiceErrorMessage, voiceErrorSystemSettingsPane, voicePrivacyMessage } from '../../src/shared/voice.ts';

/** SPEC-003 FR-10: where a dictated phrase goes, and what the note says, as in Cats Desktop. */

test('a phrase goes in at the owner\'s selection, with spaces only where words would touch', () => {
  assert.deepEqual(insertTranscript('hello world', ' there ', { start: 5, end: 5 }), { text: 'hello there world', cursor: 11 });
  assert.deepEqual(insertTranscript('hello world', 'big', { start: 6, end: 11 }), { text: 'hello big', cursor: 9 });
  assert.deepEqual(insertTranscript('', '你好', { start: 0, end: 0 }), { text: '你好', cursor: 2 });
  assert.deepEqual(insertTranscript('draft', 'more', null), { text: 'draft more', cursor: 10 }, 'appended when the selection is not the owner\'s');
  assert.deepEqual(insertTranscript('draft ', 'more', null), { text: 'draft more', cursor: 10 });
  assert.equal(insertTranscript('draft', '   ', null), null);
});

test('cancellation is silent, other errors and online recognizers are explained', () => {
  assert.equal(voiceErrorMessage('cancelled'), null);
  assert.equal(voiceErrorMessage('aborted'), null);
  assert.match(voiceErrorMessage('permission_denied') ?? '', /Microphone access was denied/u);
  assert.match(voiceErrorMessage('speech_permission_denied') ?? '', /Privacy & Security > Speech Recognition/u);
  assert.match(voiceErrorMessage('engine_unavailable') ?? '', /not available on this device/u);
  assert.equal(voicePrivacyMessage('on-device'), null);
  assert.match(voicePrivacyMessage('unknown') ?? '', /Microsoft online speech/u);
  assert.match(voicePrivacyMessage('cloud') ?? '', /online speech service/u);
});

test('a denied microphone and a denied Speech Recognition point at their own macOS panes (ADR-020)', () => {
  assert.equal(voiceErrorSystemSettingsPane('permission_denied'), 'microphone');
  assert.equal(voiceErrorSystemSettingsPane('speech_permission_denied'), 'speech_recognition');
  for (const reason of ['permission_not_determined', 'mic_unavailable', 'engine_unavailable', 'cancelled'] as const) {
    assert.equal(voiceErrorSystemSettingsPane(reason), null, reason);
  }
});
