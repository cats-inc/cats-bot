import type {
  DesktopScreenshotCancelReason,
  DesktopScreenshotCaptureResult,
} from '../../../shared/screenshot/contracts.ts';
import type {
  DesktopScreenshotDisplaySnapshot,
} from './screenshotNativeCapture.ts';
import type {
  DesktopScreenshotOverlaySessionResult,
} from './screenshotOverlaySession.ts';

export interface DesktopScreenshotOverlayController {
  waitForResult(): Promise<DesktopScreenshotOverlaySessionResult>;
  closeAll(): void;
}

export interface DesktopScreenshotRegionCaptureDependencies {
  captureDisplaySnapshots(): Promise<DesktopScreenshotDisplaySnapshot[]>;
  openOverlay(
    snapshots: DesktopScreenshotDisplaySnapshot[],
  ): Promise<DesktopScreenshotOverlayController>;
  createFilename(): string;
}

export function toDesktopScreenshotCancelReason(
  reason: string,
): DesktopScreenshotCancelReason {
  if (reason === 'too_small') {
    return 'too_small';
  }
  if (reason === 'unknown_display' || reason.startsWith('unknown_display:')) {
    return 'unknown_display';
  }
  return 'user_cancel';
}

export async function runDesktopScreenshotRegionCapture(
  dependencies: DesktopScreenshotRegionCaptureDependencies,
): Promise<DesktopScreenshotCaptureResult> {
  const snapshots = await dependencies.captureDisplaySnapshots();
  if (snapshots.length === 0) {
    return {
      outcome: 'platform_unsupported',
      message: 'No displays are available for screenshot capture.',
    };
  }

  const overlay = await dependencies.openOverlay(snapshots);
  try {
    const result = await overlay.waitForResult();
    if (result.outcome === 'cancelled') {
      return {
        outcome: 'cancelled',
        reason: toDesktopScreenshotCancelReason(result.reason),
      };
    }

    return {
      outcome: 'ok',
      png: result.region.png,
      mime: 'image/png',
      filename: dependencies.createFilename(),
      width: result.region.width,
      height: result.region.height,
    };
  } finally {
    overlay.closeAll();
  }
}
