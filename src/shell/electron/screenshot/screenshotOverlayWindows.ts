import type {
  DesktopScreenshotDisplaySnapshot,
} from './screenshotNativeCapture.ts';

export interface DesktopScreenshotOverlayWindowPlan {
  displayId: number;
  sourceId: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  url: string;
  alwaysOnTop: {
    enabled: true;
    level: 'screen-saver';
  };
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    frame: false;
    transparent: true;
    resizable: false;
    hasShadow: false;
    skipTaskbar: true;
    focusable: true;
    acceptFirstMouse: true;
    fullscreenable: false;
    webPreferences: {
      preload: string;
      contextIsolation: true;
      nodeIntegration: false;
      sandbox: true;
    };
  };
}

function appendDisplayIdToOverlayUrl(rawUrl: string, displayId: number): string {
  const url = new URL(rawUrl);
  url.searchParams.set('displayId', String(displayId));
  return url.toString();
}

export function buildScreenshotOverlayWindowPlans(input: {
  snapshots: DesktopScreenshotDisplaySnapshot[];
  overlayUrl: string;
  preloadPath: string;
}): DesktopScreenshotOverlayWindowPlan[] {
  return input.snapshots.map((snapshot) => {
    const bounds = snapshot.geometry.bounds;
    return {
      displayId: snapshot.displayId,
      sourceId: snapshot.sourceId,
      bounds,
      url: appendDisplayIdToOverlayUrl(input.overlayUrl, snapshot.displayId),
      alwaysOnTop: {
        enabled: true,
        level: 'screen-saver',
      },
      options: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: true,
        resizable: false,
        hasShadow: false,
        skipTaskbar: true,
        focusable: true,
        acceptFirstMouse: true,
        fullscreenable: false,
        webPreferences: {
          preload: input.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  });
}
