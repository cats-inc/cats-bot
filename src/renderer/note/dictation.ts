import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import {
  insertTranscript,
  voiceErrorMessage,
  voiceErrorSystemSettingsPane,
  type VoiceCaptureErrorReason,
  type VoiceCaptureMode,
} from '../../shared/voice.ts';

/**
 * SPEC-003 FR-10: dictation in the note's composer, ported from Cats Desktop's
 * `useNativeVoiceInput` and `useVoiceInputComposer` (cats-platform 6a2a1b02).
 * Only final phrases are inserted, at the owner's selection when it is theirs.
 * Escape and the composer becoming busy cancel it; the shell ends it when the
 * note is closed or another note starts dictating. Like Desktop, no language
 * is passed: the helper uses the system's.
 * Desktop falls back to Web Speech where it has no helper; Electron's Web
 * Speech has no recognition service, so the note offers no dictation there.
 */

type Status = 'idle' | 'starting' | 'ready';

export interface Dictation {
  supported: boolean;
  /** Started and not ended yet, including while the helper starts. */
  active: boolean;
  /** The helper is listening. */
  listening: boolean;
  privacyMode: VoiceCaptureMode | null;
  toggle(): void;
  cancel(): void;
}

function sessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useDictation(options: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (next: string) => void;
  disabled: boolean;
  /** An English message for the note to show, and the macOS pane that fixes it (ADR-020). */
  onError: (message: string, pane: 'microphone' | 'speech_recognition' | null) => void;
}): Dictation {
  const voice = window.catsBot.voice;
  const [status, setStatus] = useState<Status>('idle');
  const [privacyMode, setPrivacyMode] = useState<VoiceCaptureMode | null>(null);
  const active = useRef<string | null>(null);
  const draft = useRef(options.draft);
  draft.current = options.draft;
  const latest = useRef(options);
  latest.current = options;
  // Whether the selection in the input is the owner's (they clicked or typed there since the text last changed).
  const ownSelection = useRef<string | null>(null);

  const reset = useCallback((id: string) => {
    if (active.current !== id) return;
    active.current = null;
    setStatus('idle');
    setPrivacyMode(null);
  }, []);

  const insert = useCallback((phrase: string) => {
    const input = latest.current.inputRef.current;
    const current = draft.current;
    const trusted = !!input && (document.activeElement === input || ownSelection.current === current);
    const next = insertTranscript(current, phrase,
      trusted && input ? { start: input.selectionStart ?? current.length, end: input.selectionEnd ?? current.length } : null);
    if (!next) return;
    ownSelection.current = next.text;
    // Before the re-render, so a second phrase arriving at once goes after this one.
    draft.current = next.text;
    latest.current.setDraft(next.text);
    requestAnimationFrame(() => {
      try {
        latest.current.inputRef.current?.setSelectionRange(next.cursor, next.cursor);
      } catch {
        // A disabled or detached textarea has no selection.
      }
    });
  }, []);

  useEffect(() => {
    if (!voice) return;
    return voice.onEvent((event) => {
      if (event.sessionId !== active.current) return;
      switch (event.type) {
        case 'ready':
          setStatus('ready');
          setPrivacyMode(event.mode);
          break;
        case 'final':
          insert(event.text);
          break;
        case 'error': {
          const message = voiceErrorMessage(event.reason);
          if (message) latest.current.onError(message, voiceErrorSystemSettingsPane(event.reason));
          reset(event.sessionId);
          break;
        }
        case 'end':
          reset(event.sessionId);
          break;
        default:
          break;
      }
    });
  }, [voice, insert, reset]);

  const fail = useCallback((id: string, reason: VoiceCaptureErrorReason) => {
    if (active.current !== id) return;
    reset(id);
    const message = voiceErrorMessage(reason);
    if (message) latest.current.onError(message, voiceErrorSystemSettingsPane(reason));
  }, [reset]);

  const start = useCallback(() => {
    if (!voice || active.current) return;
    const id = sessionId();
    active.current = id;
    setStatus('starting');
    setPrivacyMode(null);
    void voice.start({ sessionId: id }).catch(() => fail(id, 'engine_unavailable'));
  }, [voice, fail]);

  const stop = useCallback(() => {
    const id = active.current;
    if (!voice || !id) return;
    void voice.stop(id).catch(() => fail(id, 'engine_unavailable'));
  }, [voice, fail]);

  const cancel = useCallback(() => {
    const id = active.current;
    if (!voice || !id) return;
    reset(id);
    void voice.cancel(id).catch(() => undefined);
  }, [voice, reset]);

  const isActive = status !== 'idle';
  const toggle = useCallback(() => (isActive ? stop() : start()), [isActive, start, stop]);

  useEffect(() => {
    if (options.disabled && isActive) cancel();
  }, [options.disabled, isActive, cancel]);

  useEffect(() => {
    const input = options.inputRef.current;
    if (!input) return;
    const mark = () => { ownSelection.current = input.value; };
    input.addEventListener('focus', mark);
    input.addEventListener('pointerdown', mark);
    input.addEventListener('keydown', mark);
    input.addEventListener('input', mark);
    return () => {
      input.removeEventListener('focus', mark);
      input.removeEventListener('pointerdown', mark);
      input.removeEventListener('keydown', mark);
      input.removeEventListener('input', mark);
    };
  }, [options.inputRef]);

  // Escape anywhere in the note (focus is on the button after a click). A closed note is only hidden;
  // the shell ends its session then, not on visibility, which also changes when another window covers it.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && active.current) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [cancel]);

  // The page going away ends the helper too (the shell also cancels when the note is destroyed).
  useEffect(() => () => {
    const id = active.current;
    if (voice && id) void voice.cancel(id).catch(() => undefined);
  }, [voice]);

  return { supported: voice !== null, active: isActive, listening: status === 'ready', privacyMode, toggle, cancel };
}
