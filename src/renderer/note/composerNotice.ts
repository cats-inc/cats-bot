import type { SystemSettingsPane } from '../../shared/systemSettings.ts';

/**
 * ADR-024: what the composer says when one of its actions fails: dictation, the
 * region screenshot, a file too large to attach, or a send or retry the core
 * refused. It is one notice in the composer, not a line in the transcript: a
 * new failure replaces it, the owner can dismiss it, and the action working
 * again clears it. Cats Desktop shows dictation and screenshot failures as toasts.
 */

export type ComposerNoticeSource = 'voice' | 'screenshot' | 'attach' | 'send';

export interface ComposerNotice {
  /** New for every failure, so a repeated one is shown again rather than left as it was. */
  id: number;
  source: ComposerNoticeSource;
  /** Already translated. */
  message: string;
  /** ADR-020: the macOS pane that fixes it; the notice then has "Open System Settings". */
  pane: SystemSettingsPane | null;
}

/** How long a notice with nothing to do stays; one that opens System Settings stays until it is dismissed. */
export const COMPOSER_NOTICE_LIFETIME_MS = 8000;

let lastId = 0;

/** The notice for a failure; it replaces whatever notice was showing. */
export function raiseComposerNotice(source: ComposerNoticeSource, message: string, pane: SystemSettingsPane | null = null): ComposerNotice {
  lastId += 1;
  return { id: lastId, source, message, pane };
}

/** The notice left once `source` has worked again: one from that action goes, another action's stays. */
export function clearComposerNotice(current: ComposerNotice | null, source: ComposerNoticeSource): ComposerNotice | null {
  return current?.source === source ? null : current;
}

/** Milliseconds before the notice clears itself, or null when it waits for the owner. */
export function composerNoticeLifetime(notice: ComposerNotice): number | null {
  return notice.pane ? null : COMPOSER_NOTICE_LIFETIME_MS;
}
