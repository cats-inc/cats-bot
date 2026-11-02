import { app, BrowserWindow, screen, type Menu } from 'electron';

import { displaysBounds } from './floatingPlacement.ts';
import { linuxWindowsUnderWayland } from './linuxWindowing.ts';

/**
 * A menu learns of a click elsewhere through its X grab, but under XWayland a
 * click on a native Wayland window never reaches the X server, whichever window
 * owns the menu. While one is open, a transparent window over every display
 * takes that click, which closes the menu like any other outside click (ADR-014).
 * It appears a moment after the menu: mapped with it or just before it, the menu
 * often never paints. If it fails, the menu only stays open as it would without it.
 */
const CATCHER_DELAY_MS = 150;

export function popupMenu(menu: Menu, window: BrowserWindow): void {
  if (!linuxWindowsUnderWayland(app.commandLine)) {
    menu.popup({ window });
    return;
  }
  const catcher = new BrowserWindow({
    ...displaysBounds(screen.getAllDisplays()),
    transparent: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    title: 'Cats Bot',
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  catcher.setAlwaysOnTop(true, 'screen-saver');
  const showing = setTimeout(() => {
    if (!catcher.isDestroyed()) catcher.showInactive();
  }, CATCHER_DELAY_MS);
  menu.popup({
    window,
    callback: () => {
      clearTimeout(showing);
      if (!catcher.isDestroyed()) catcher.destroy();
    },
  });
}
