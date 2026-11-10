import type {
  DesktopScreenshotOverlaySnapshotPayload,
} from './screenshotOverlayTypes.ts';

export const DESKTOP_SCREENSHOT_OVERLAY_GET_SNAPSHOT_CHANNEL =
  'cats-host:screenshot-overlay:get-snapshot';
export const DESKTOP_SCREENSHOT_OVERLAY_COMPLETE_CHANNEL =
  'cats-host:screenshot-overlay:complete-selection';
export const DESKTOP_SCREENSHOT_OVERLAY_CANCEL_CHANNEL =
  'cats-host:screenshot-overlay:cancel';

export interface DesktopScreenshotOverlaySelectionResult {
  displayId: number;
  cssRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  cropRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface DesktopScreenshotOverlayBridge {
  getSnapshot(displayId: number): Promise<DesktopScreenshotOverlaySnapshotPayload>;
  completeSelection(result: DesktopScreenshotOverlaySelectionResult): Promise<void>;
  cancel(reason: string): Promise<void>;
}

function parseFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid screenshot overlay ${label}: ${String(value)}`);
  }
  return value;
}

function parseRect(
  value: unknown,
  label: string,
): DesktopScreenshotOverlaySelectionResult['cssRect'] {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid screenshot overlay ${label} rect.`);
  }
  const rect = value as Record<string, unknown>;
  return {
    x: parseFiniteNumber(rect.x, `${label}.x`),
    y: parseFiniteNumber(rect.y, `${label}.y`),
    width: parseFiniteNumber(rect.width, `${label}.width`),
    height: parseFiniteNumber(rect.height, `${label}.height`),
  };
}

export function parseDesktopScreenshotOverlayDisplayId(value: unknown): number {
  return parseFiniteNumber(value, 'displayId');
}

export function parseDesktopScreenshotOverlaySelectionResult(
  value: unknown,
): DesktopScreenshotOverlaySelectionResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid screenshot overlay selection result.');
  }
  const result = value as Record<string, unknown>;
  return {
    displayId: parseDesktopScreenshotOverlayDisplayId(result.displayId),
    cssRect: parseRect(result.cssRect, 'cssRect'),
    cropRect: parseRect(result.cropRect, 'cropRect'),
  };
}

export function parseDesktopScreenshotOverlayCancelReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Invalid screenshot overlay cancellation reason.');
  }
  return value;
}
