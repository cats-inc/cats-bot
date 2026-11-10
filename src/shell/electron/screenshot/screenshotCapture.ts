import {
  DESKTOP_SCREENSHOT_CAPTURE_SOURCES,
  type DesktopScreenshotCaptureRequest,
  type DesktopScreenshotCaptureResult,
} from '../../../shared/screenshot/contracts.ts';

/**
 * SPEC-003 FR-9: a region screenshot from a note's composer, ported from Cats
 * Desktop (`desktop/host/screenshotCapture.ts` at cats-platform 6a2a1b02).
 * Desktop hides its main window while the screen is captured; the shell hides
 * the note that asked and every floating Cat (always on top), and gives them
 * back afterwards. Hiding is never a close: the note stays open.
 */

export const NOTE_SCREENSHOT_IPC_CHANNEL = 'note:captureScreenshot';
const DEFAULT_COMPOSITOR_WAIT_MS = 120;

/** Hides a window for the capture and returns how to give it back. */
export type HideForScreenshot = () => () => void;

const SOURCES = new Set<string>(DESKTOP_SCREENSHOT_CAPTURE_SOURCES);

export function parseDesktopScreenshotCaptureRequest(value: unknown): DesktopScreenshotCaptureRequest {
  if (typeof value !== 'object' || value === null || !SOURCES.has((value as { source?: unknown }).source as string)) {
    throw new Error('Invalid desktop screenshot capture request payload.');
  }
  return { source: (value as { source: DesktopScreenshotCaptureRequest['source'] }).source };
}

export async function waitForDesktopScreenshotCompositorFrame(waitMs = DEFAULT_COMPOSITOR_WAIT_MS): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, waitMs);
  });
}

/** Runs `action` with the windows hidden, then gives every one back, in reverse order, whatever happens. */
export async function runWithWindowsHiddenForScreenshot<T>(
  hiders: readonly HideForScreenshot[],
  action: () => Promise<T>,
  waitForHiddenFrame: () => Promise<void> = waitForDesktopScreenshotCompositorFrame,
): Promise<T> {
  const restores: Array<() => void> = [];
  try {
    for (const hide of hiders) restores.push(hide());
    await waitForHiddenFrame();
    return await action();
  } finally {
    for (const restore of restores.reverse()) {
      try {
        restore();
      } catch {
        // A window destroyed meanwhile has nothing to give back.
      }
    }
  }
}

export async function captureScreenshotRegion(options: {
  hiders: readonly HideForScreenshot[];
  captureNativeRegion: () => Promise<DesktopScreenshotCaptureResult>;
  waitForHiddenFrame?: () => Promise<void>;
}): Promise<DesktopScreenshotCaptureResult> {
  return await runWithWindowsHiddenForScreenshot(options.hiders, options.captureNativeRegion, options.waitForHiddenFrame);
}
