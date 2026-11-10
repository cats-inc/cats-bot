import type { DesktopScreenshotOverlaySnapshotPayload } from '../../../shared/screenshot/screenshotOverlayTypes.ts';
import type { DesktopScreenshotDisplaySnapshot } from './screenshotNativeCapture.ts';

export type { DesktopScreenshotOverlaySnapshotPayload };

export function encodePngDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

export function buildScreenshotOverlaySnapshotPayload(
  snapshot: DesktopScreenshotDisplaySnapshot,
): DesktopScreenshotOverlaySnapshotPayload {
  return {
    displayId: snapshot.displayId,
    sourceId: snapshot.sourceId,
    sourceName: snapshot.sourceName,
    bounds: snapshot.geometry.bounds,
    imageSize: snapshot.geometry.imageSize,
    scaleFactor: snapshot.geometry.scaleFactor,
    imageDataUrl: encodePngDataUrl(snapshot.png),
  };
}

export function buildScreenshotOverlaySnapshotPayloads(
  snapshots: DesktopScreenshotDisplaySnapshot[],
): DesktopScreenshotOverlaySnapshotPayload[] {
  return snapshots.map((snapshot) => buildScreenshotOverlaySnapshotPayload(snapshot));
}
