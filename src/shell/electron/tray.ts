import { join } from 'node:path';

import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron';

import type { TrayMenuItem } from './trayMenu.ts';

/**
 * The hub tray owns global settings, avatar recovery, updates and Quit.
 * Cat-specific actions belong to each floating Cat's menu.
 *
 * Tray creation adapted from cats-platform `desktop/host/tray.ts` at revision
 * 595e9ca (MIT), per ADR-001 §1; the macOS template icon follows its later
 * `tray-iconTemplate.png` handling.
 */

export interface BotTrayOptions {
  assetsDir: string;
  /** A click opens Cats Bot Settings on its Bots tab. */
  onClick(): void;
}

/**
 * macOS gets a template image, as Desktop's tray does: a 20pt silhouette (the
 * @2x file loads with it) that the menu bar draws in its own colour for light
 * and dark bars. Windows and Linux get the full-colour tile.
 */
function loadTrayIcon(assetsDir: string): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const template = nativeImage.createFromPath(join(assetsDir, 'tray-iconTemplate.png'));
    if (!template.isEmpty()) {
      template.setTemplateImage(true);
      return template;
    }
  }
  const bundled = nativeImage.createFromPath(join(assetsDir, 'tray-icon.png'));
  if (bundled.isEmpty()) return bundled;
  if (process.platform === 'linux') return bundled.resize({ width: 22, height: 22 });
  // Only a package missing its template reaches this on macOS; keep the 20pt canvas.
  if (process.platform === 'darwin') return bundled.resize({ width: 20, height: 20, quality: 'best' });
  return bundled;
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
