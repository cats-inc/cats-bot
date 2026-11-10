import { BrowserWindow } from 'electron';

import type {
  DesktopScreenshotOverlayWindowFactory,
  DesktopScreenshotOverlayWindowHandle,
} from './screenshotOverlayController.ts';

/** `created` sees each overlay window before it loads, to guard it and to know its webContents. */
export function createElectronScreenshotOverlayWindowFactory(
  created: (window: BrowserWindow) => void = () => {},
): DesktopScreenshotOverlayWindowFactory {
  return {
    createWindow(options): DesktopScreenshotOverlayWindowHandle {
      const window = new BrowserWindow(options);
      created(window);
      return {
        async loadURL(url) {
          await window.loadURL(url);
        },
        setAlwaysOnTop(enabled, level) {
          window.setAlwaysOnTop(enabled, level);
        },
        focus() {
          window.focus();
        },
        onBeforeInputEvent(listener) {
          window.webContents.on('before-input-event', listener);
          return () => {
            window.webContents.off('before-input-event', listener);
          };
        },
        onClosed(listener) {
          window.once('closed', listener);
          return () => {
            window.off('closed', listener);
          };
        },
        close() {
          window.close();
        },
        isDestroyed() {
          return window.isDestroyed();
        },
      };
    },
  };
}
