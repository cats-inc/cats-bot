import type {
  DesktopScreenshotOverlayWindowPlan,
} from './screenshotOverlayWindows.ts';

export interface DesktopScreenshotOverlayWindowHandle {
  loadURL(url: string): Promise<void>;
  setAlwaysOnTop(enabled: true, level: 'screen-saver'): void;
  close(): void;
  isDestroyed(): boolean;
  focus?(): void;
  onBeforeInputEvent?(
    listener: (
      event: { preventDefault(): void },
      input: { key?: string; type?: string },
    ) => void,
  ): () => void;
  onClosed?(listener: () => void): () => void;
}

export interface DesktopScreenshotOverlayWindowFactory {
  createWindow(
    options: DesktopScreenshotOverlayWindowPlan['options'],
  ): DesktopScreenshotOverlayWindowHandle;
}

export interface DesktopScreenshotOverlayWindowsController {
  closeAll(): void;
}

export interface DesktopScreenshotOverlayWindowsControllerOptions {
  onEscape?: () => void;
  onWindowClosed?: () => void;
}

export async function openScreenshotOverlayWindows(
  plans: DesktopScreenshotOverlayWindowPlan[],
  factory: DesktopScreenshotOverlayWindowFactory,
  options: DesktopScreenshotOverlayWindowsControllerOptions = {},
): Promise<DesktopScreenshotOverlayWindowsController> {
  const windows: DesktopScreenshotOverlayWindowHandle[] = [];
  const cleanupListeners: Array<() => void> = [];

  try {
    for (const plan of plans) {
      const window = factory.createWindow(plan.options);
      windows.push(window);
      registerOverlayWindowListeners(window, cleanupListeners, options);
      window.setAlwaysOnTop(plan.alwaysOnTop.enabled, plan.alwaysOnTop.level);
      await window.loadURL(plan.url);
      window.focus?.();
    }
  } catch (error) {
    cleanupScreenshotOverlayWindowListeners(cleanupListeners);
    closeScreenshotOverlayWindows(windows);
    throw error;
  }

  return {
    closeAll() {
      cleanupScreenshotOverlayWindowListeners(cleanupListeners);
      closeScreenshotOverlayWindows(windows);
    },
  };
}

function registerOverlayWindowListeners(
  window: DesktopScreenshotOverlayWindowHandle,
  cleanupListeners: Array<() => void>,
  options: DesktopScreenshotOverlayWindowsControllerOptions,
): void {
  if (options.onEscape && window.onBeforeInputEvent) {
    cleanupListeners.push(window.onBeforeInputEvent((event, input) => {
      if (input.key !== 'Escape' || input.type !== 'keyDown') {
        return;
      }
      event.preventDefault();
      options.onEscape?.();
    }));
  }

  if (options.onWindowClosed && window.onClosed) {
    cleanupListeners.push(window.onClosed(() => {
      options.onWindowClosed?.();
    }));
  }
}

function cleanupScreenshotOverlayWindowListeners(cleanupListeners: Array<() => void>): void {
  while (cleanupListeners.length > 0) {
    cleanupListeners.pop()?.();
  }
}

function closeScreenshotOverlayWindows(
  windows: DesktopScreenshotOverlayWindowHandle[],
): void {
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.close();
    }
  }
}
