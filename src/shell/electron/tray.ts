import { join } from 'node:path';

import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron';

import { buildTrayMenuTemplate, buildTrayTooltip, type TrayMenuActions, type TrayMenuModel } from './trayMenu.ts';

/**
 * SPEC-001 FR-33: the tray opens the home note, lists conversations, makes a
 * new note, pauses the heartbeat and quits. Closing a note, deleting a
 * conversation and quitting the bot stay separate actions.
 *
 * Tray creation adapted from cats-platform `desktop/host/tray.ts` at revision
 * 595e9ca (MIT), per ADR-001 §1.
 */

export interface BotTrayOptions extends TrayMenuActions {
  assetsDir: string;
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
  private readonly options: BotTrayOptions;

  constructor(options: BotTrayOptions) {
    this.options = options;
    this.tray = new Tray(loadTrayIcon(options.assetsDir));
    this.tray.setToolTip(app.getName());
    this.tray.on('click', () => options.onOpenConversation('home'));
    this.tray.on('double-click', () => options.onOpenConversation('home'));
  }

  update(model: TrayMenuModel): void {
    this.tray.setToolTip(buildTrayTooltip(model));
    this.tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(model, this.options) as MenuItemConstructorOptions[]));
  }

  dispose(): void {
    this.tray.destroy();
  }
}
