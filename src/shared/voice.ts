/**
 * SPEC-003 FR-10: dictation in the note's composer, ported from Cats Desktop
 * (`src/shared/voiceCaptureBridge.ts` and `desktop/host/contracts.ts` at
 * cats-platform 6a2a1b02). A native helper turns speech into text, which goes
 * into the composer; no audio is kept or sent. Shared by the shell and the note.
 */

export const VOICE_CAPTURE_MODES = ['on-device', 'cloud', 'unknown'] as const;
export const VOICE_CAPTURE_ERROR_REASONS = [
  'permission_denied',
  'permission_not_determined',
  'mic_unavailable',
  'language_not_supported',
  'engine_unavailable',
  'helper_crashed',
  'cancelled',
  // Reserved for helper/OS aborts where the user did not request cancellation.
  'aborted',
] as const;

export type VoiceCaptureSessionId = string;
export type VoiceCaptureMode = typeof VOICE_CAPTURE_MODES[number];
export type VoiceCaptureErrorReason = typeof VOICE_CAPTURE_ERROR_REASONS[number];

export interface VoiceCaptureStartOptions {
  sessionId: VoiceCaptureSessionId;
  locale?: string;
}

export type VoiceCaptureEvent =
  | { type: 'ready'; sessionId: VoiceCaptureSessionId; locale: string; mode: VoiceCaptureMode }
  | { type: 'partial'; sessionId: VoiceCaptureSessionId; text: string }
  | { type: 'final'; sessionId: VoiceCaptureSessionId; text: string }
  | { type: 'error'; sessionId: VoiceCaptureSessionId; reason: VoiceCaptureErrorReason }
  | { type: 'end'; sessionId: VoiceCaptureSessionId };

/** The note's message for a helper's error, as Cats Desktop words it; silent reasons have none. */
export function voiceErrorMessage(reason: VoiceCaptureErrorReason): string | null {
  switch (reason) {
    case 'permission_denied': return 'Microphone access was denied. Check your system voice permissions.';
    case 'permission_not_determined': return 'Voice input needs system microphone and speech permissions.';
    case 'mic_unavailable': return 'No microphone was detected.';
    case 'language_not_supported': return 'Voice input does not support the current language.';
    case 'engine_unavailable': return 'Voice input is not available on this device.';
    case 'helper_crashed': return 'Voice input stopped unexpectedly.';
    case 'cancelled':
    case 'aborted':
      return null;
  }
}

/** A warning for a recognizer that may send speech online, as Cats Desktop shows it. */
export function voicePrivacyMessage(mode: VoiceCaptureMode | null): string | null {
  if (mode === 'unknown') return 'Voice input may use Microsoft online speech depending on Windows privacy settings.';
  if (mode === 'cloud') return 'Voice input is using an online speech service.';
  return null;
}

/**
 * The composer text with a recognized phrase inserted at the selection, or appended when the
 * selection is not the owner's, with spaces only where words would otherwise touch (Cats Desktop
 * `useVoiceInputComposer`). Returns the new text and where the cursor goes.
 */
export function insertTranscript(current: string, phrase: string, selection: { start: number; end: number } | null): { text: string; cursor: number } | null {
  const trimmed = phrase.trim();
  if (!trimmed) return null;
  if (selection) {
    const before = current.slice(0, selection.start);
    const after = current.slice(selection.end);
    const leading = before.length > 0 && !/\s$/u.test(before);
    const trailing = after.length > 0 && !/^\s/u.test(after);
    const fragment = `${leading ? ' ' : ''}${trimmed}${trailing ? ' ' : ''}`;
    return { text: `${before}${fragment}${after}`, cursor: before.length + fragment.length - (trailing ? 1 : 0) };
  }
  const separator = current && !/\s$/u.test(current) ? ' ' : '';
  const text = `${current}${separator}${trimmed}`;
  return { text, cursor: text.length };
}
