import { desktopCapturer, nativeImage, screen } from 'electron';

import type {
  DesktopScreenshotCaptureDependencies,
  DesktopScreenshotCropDependencies,
} from './screenshotNativeCapture.ts';
import type {
  DesktopScreenshotPhysicalRect,
} from '../../../shared/screenshot/screenshotGeometry.ts';

function cropNativePng(
  sourcePng: Uint8Array,
  cropRect: DesktopScreenshotPhysicalRect,
): Uint8Array {
  return nativeImage
    .createFromBuffer(Buffer.from(sourcePng))
    .crop(cropRect)
    .toPNG();
}

// Windows reliably covers the taskbar with a `screen-saver` level
// always-on-top BrowserWindow, so capture the full display and let the
// overlay match. macOS cannot cover the system menu bar/dock, and Linux
// coverage depends on the window manager — on those platforms we crop
// captured snapshots to workArea so the overlay sits inside the chrome
// instead of stacking a fake chrome strip on top of the real one.
const SHOULD_RESTRICT_CAPTURE_TO_WORK_AREA = process.platform !== 'win32';

export function createElectronScreenshotCaptureDependencies():
  DesktopScreenshotCaptureDependencies {
  return {
    getAllDisplays() {
      return screen.getAllDisplays().map((display) => ({
        id: display.id,
        bounds: display.bounds,
        workArea: SHOULD_RESTRICT_CAPTURE_TO_WORK_AREA ? display.workArea : undefined,
        scaleFactor: display.scaleFactor,
      }));
    },
    cropPng: cropNativePng,
    async getScreenSources(options) {
      return await desktopCapturer.getSources(options);
    },
  };
}

export function resolveElectronScreenshotWorkAreas(): DesktopScreenshotPhysicalRect[] {
  return screen.getAllDisplays().map((display) => display.workArea ?? display.bounds);
}

export function createElectronScreenshotCropDependencies(): DesktopScreenshotCropDependencies {
  return {
    cropPng: cropNativePng,
    resizePng(sourcePng, size) {
      return nativeImage
        .createFromBuffer(Buffer.from(sourcePng))
        .resize(size)
        .toPNG();
    },
  };
}
