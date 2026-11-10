import type { DesktopScreenshotDisplayGeometry } from './screenshotGeometry.ts';

/** One display's frozen picture, as the shell hands it to that display's overlay page. */
export interface DesktopScreenshotOverlaySnapshotPayload {
  displayId: number;
  sourceId: string;
  sourceName: string;
  bounds: DesktopScreenshotDisplayGeometry['bounds'];
  imageSize: DesktopScreenshotDisplayGeometry['imageSize'];
  scaleFactor: number;
  imageDataUrl: string;
}
