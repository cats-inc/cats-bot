/**
 * SPEC-003 FR-9: the result of a region screenshot taken from the note's
 * composer, ported from Cats Desktop (`desktop/host/contracts.ts` at
 * cats-platform 6a2a1b02). Shared by the shell and the note page.
 */

export const DESKTOP_SCREENSHOT_CAPTURE_SOURCES = ['composer'] as const;
export const DESKTOP_SCREENSHOT_CANCEL_REASONS = ['user_cancel', 'too_small', 'unknown_display'] as const;

export type DesktopScreenshotCaptureSource = typeof DESKTOP_SCREENSHOT_CAPTURE_SOURCES[number];
export type DesktopScreenshotCancelReason = typeof DESKTOP_SCREENSHOT_CANCEL_REASONS[number];

export interface DesktopScreenshotCaptureRequest {
  source: DesktopScreenshotCaptureSource;
}

export type DesktopScreenshotCaptureResult =
  | { outcome: 'ok'; png: Uint8Array; mime: 'image/png'; filename: string; width: number; height: number }
  | { outcome: 'cancelled'; reason: DesktopScreenshotCancelReason }
  | { outcome: 'permission_denied' | 'platform_unsupported' | 'error'; message?: string };
