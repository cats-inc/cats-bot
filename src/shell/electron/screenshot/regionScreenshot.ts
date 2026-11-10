import { app, ipcMain, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { pathToFileURL } from 'node:url';

import type { DesktopScreenshotCaptureResult } from '../../../shared/screenshot/contracts.ts';
import {
  DESKTOP_SCREENSHOT_OVERLAY_CANCEL_CHANNEL,
  DESKTOP_SCREENSHOT_OVERLAY_COMPLETE_CHANNEL,
  DESKTOP_SCREENSHOT_OVERLAY_GET_SNAPSHOT_CHANNEL,
  parseDesktopScreenshotOverlayCancelReason,
  parseDesktopScreenshotOverlayDisplayId,
  parseDesktopScreenshotOverlaySelectionResult,
} from '../../../shared/screenshot/screenshotOverlayIpc.ts';
import { guardNavigation } from '../navigation.ts';
import {
  createElectronScreenshotCaptureDependencies,
  createElectronScreenshotCropDependencies,
  resolveElectronScreenshotWorkAreas,
} from './screenshotElectronAdapter.ts';
import { createElectronScreenshotOverlayWindowFactory } from './screenshotElectronOverlay.ts';
import { createDesktopScreenshotFilename } from './screenshotFilename.ts';
import { captureDesktopDisplaySnapshots, type DesktopScreenshotDisplaySnapshot } from './screenshotNativeCapture.ts';
import { openScreenshotOverlayWindows } from './screenshotOverlayController.ts';
import { DesktopScreenshotOverlaySession } from './screenshotOverlaySession.ts';
import { buildScreenshotOverlayWindowPlans } from './screenshotOverlayWindows.ts';
import { resolveDesktopScreenshotPermissionResult, type DesktopScreenshotMediaAccessStatus } from './screenshotPermission.ts';
import { runDesktopScreenshotRegionCapture, type DesktopScreenshotOverlayController } from './screenshotRegionCapture.ts';
import { captureWlrootsNativeScreenshotRegion, isLikelyWlrootsScreenshotSession } from './screenshotWlrootsCapture.ts';

/**
 * SPEC-003 FR-9: the region screenshot behind the composer's "Take
 * screenshot", ported from Cats Desktop's host (`captureNativeScreenshotRegion`
 * and the overlay handlers in `desktop/host/main.ts` at cats-platform
 * 6a2a1b02). macOS needs Screen Recording for Cats Bot; wlroots desktops use
 * grim and slurp; elsewhere every display is captured and frozen under an
 * overlay window where the owner drags out the region. Only the overlay
 * windows of the running capture may answer.
 */

export interface RegionScreenshotOptions {
  /** `dist/renderer/screenshotOverlay.html`. */
  overlayPage: string;
  /** `assets/screenshotOverlayPreload.cjs`. */
  overlayPreload: string;
}

export class RegionScreenshots {
  private readonly options: RegionScreenshotOptions;
  private session: DesktopScreenshotOverlaySession | null = null;
  /** The webContents of the running session's overlay windows. */
  private readonly overlays = new Set<number>();
  private capturing = false;

  constructor(options: RegionScreenshotOptions) {
    this.options = options;
    const fromOverlay = (event: IpcMainInvokeEvent): DesktopScreenshotOverlaySession => {
      if (!this.session || !this.overlays.has(event.sender.id)) throw new Error('No screenshot overlay session is active.');
      return this.session;
    };
    ipcMain.handle(DESKTOP_SCREENSHOT_OVERLAY_GET_SNAPSHOT_CHANNEL, (event, displayId: unknown) =>
      fromOverlay(event).getSnapshot(parseDesktopScreenshotOverlayDisplayId(displayId)));
    ipcMain.handle(DESKTOP_SCREENSHOT_OVERLAY_COMPLETE_CHANNEL, (event, payload: unknown) => {
      fromOverlay(event).completeSelection(parseDesktopScreenshotOverlaySelectionResult(payload));
    });
    ipcMain.handle(DESKTOP_SCREENSHOT_OVERLAY_CANCEL_CHANNEL, (event, reason: unknown) => {
      if (this.session && this.overlays.has(event.sender.id)) {
        this.session.cancel(parseDesktopScreenshotOverlayCancelReason(reason));
      }
    });
  }

  /** Whether a capture is running; a second request waits for none and is refused. */
  get busy(): boolean {
    return this.capturing;
  }

  async capture(): Promise<DesktopScreenshotCaptureResult> {
    if (this.capturing) return { outcome: 'error', message: 'A screenshot is already being taken.' };
    this.capturing = true;
    try {
      const permission = process.platform === 'darwin'
        ? resolveDesktopScreenshotPermissionResult({
          platform: process.platform,
          mediaAccessStatus: systemPreferences.getMediaAccessStatus('screen') as DesktopScreenshotMediaAccessStatus,
        })
        : null;
      if (permission) return permission;
      if (isLikelyWlrootsScreenshotSession({ platform: process.platform, env: process.env })) {
        const wlroots = await captureWlrootsNativeScreenshotRegion({
          platform: process.platform,
          env: process.env,
          workAreas: resolveElectronScreenshotWorkAreas(),
          createFilename: createDesktopScreenshotFilename,
        });
        if (wlroots.outcome !== 'platform_unsupported') return wlroots;
      }
      return await runDesktopScreenshotRegionCapture({
        captureDisplaySnapshots: () => captureDesktopDisplaySnapshots(createElectronScreenshotCaptureDependencies()),
        openOverlay: (snapshots) => this.openOverlay(snapshots),
        createFilename: createDesktopScreenshotFilename,
      });
    } catch (error) {
      return { outcome: 'error', message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.capturing = false;
    }
  }

  private async openOverlay(snapshots: DesktopScreenshotDisplaySnapshot[]): Promise<DesktopScreenshotOverlayController> {
    if (this.session) throw new Error('A screenshot overlay session is already active.');
    const session = new DesktopScreenshotOverlaySession(snapshots, createElectronScreenshotCropDependencies());
    this.session = session;
    const end = () => {
      if (this.session === session) this.session = null;
      this.overlays.clear();
    };
    try {
      const factory = createElectronScreenshotOverlayWindowFactory((window) => {
        guardNavigation(window.webContents);
        this.overlays.add(window.webContents.id);
      });
      const windows = await openScreenshotOverlayWindows(
        buildScreenshotOverlayWindowPlans({
          snapshots,
          overlayUrl: pathToFileURL(this.options.overlayPage).href,
          preloadPath: this.options.overlayPreload,
        }),
        factory,
        { onEscape: () => session.cancel('escape'), onWindowClosed: () => session.cancel('window_closed') },
      );
      app.focus({ steal: true });
      return {
        waitForResult: () => session.waitForResult(),
        closeAll() {
          windows.closeAll();
          end();
        },
      };
    } catch (error) {
      end();
      throw error;
    }
  }
}
