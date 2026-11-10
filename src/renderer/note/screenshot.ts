import type { DesktopScreenshotCaptureResult } from '../../shared/screenshot/contracts.ts';

/**
 * SPEC-003 FR-9: what the composer does with a region screenshot, as Cats
 * Desktop's composer does (`src/products/shared/renderer/screenshotCapture.ts`
 * at cats-platform 6a2a1b02): a picture becomes a file waiting to be sent; an
 * owner who cancels or drags too small a region sees nothing; anything else is
 * a message in the note. The shell's messages are English text the note
 * translates.
 */

export type ScreenshotOutcome =
  | { kind: 'file'; file: File }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

export function screenshotOutcome(result: DesktopScreenshotCaptureResult): ScreenshotOutcome {
  if (result.outcome === 'ok') {
    const bytes = new Uint8Array(result.png.byteLength);
    bytes.set(result.png);
    return { kind: 'file', file: new File([bytes], result.filename, { type: result.mime }) };
  }
  if (result.outcome === 'cancelled') {
    return result.reason === 'unknown_display'
      ? { kind: 'error', message: 'Screenshot failed: the selected display is no longer available.' }
      : { kind: 'none' };
  }
  if (result.message) return { kind: 'error', message: result.message };
  if (result.outcome === 'permission_denied') {
    return { kind: 'error', message: 'Screen Recording permission is required to capture a screenshot. Grant Cats Bot screen access in macOS System Settings, then restart Cats Bot.' };
  }
  if (result.outcome === 'platform_unsupported') {
    return { kind: 'error', message: 'Region screenshot capture is unavailable on this desktop environment.' };
  }
  return { kind: 'error', message: 'Failed to capture screenshot.' };
}
