import { join } from 'node:path';

import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron';

import type { TrayMenuItem } from './trayMenu.ts';

/**
 * SPEC-001 FR-33: the tray opens the home note, lists conversations, makes a
 * new note, pauses the heartbeat and quits. Closing a note, deleting a
 * conversation and quitting the bot stay separate actions.
 *
 * Tray creation adapted from cats-platform `desktop/host/tray.ts` at revision
 * 595e9ca (MIT), per ADR-001 §1.
 */

export interface BotTrayOptions {
  assetsDir: string;
  /** A click opens the direct message of the first bot (SPEC-008 FR-16). */
  onClick(): void;
}

function loadTrayIcon(assetsDir: string): Electron.NativeImage {
  const bundled = nativeImage.createFromPath(join(assetsDir, 'tray-icon.png'));
  if (!bundled.isEmpty()) {
    return process.platform === 'linux' ? bundled.resize({ width: 22, height: 22 }) : bundled;
  }
  return nativeImage.createEmpty();
}

export class BotTray {
  private readonly tray: Tray;

  constructor(options: BotTrayOptions) {
    this.tray = new Tray(loadTrayIcon(options.assetsDir));
    this.tray.setToolTip(app.getName());
    this.tray.on('click', () => options.onClick());
    this.tray.on('double-click', () => options.onClick());
  }

  update(template: TrayMenuItem[], tooltip: string): void {
    this.tray.setToolTip(tooltip);
    this.tray.setContextMenu(Menu.buildFromTemplate(template as MenuItemConstructorOptions[]));
  }

  dispose(): void {
    this.tray.destroy();
  }
}
