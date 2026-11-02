import { app, BrowserWindow, screen, type Menu } from 'electron';

import { displaysBounds } from './floatingPlacement.ts';
import { linuxWindowsUnderWayland } from './linuxWindowing.ts';

/**
 * A menu learns of a click elsewhere through its X grab, but under XWayland a
 * click on a native Wayland window never reaches the X server, whichever window
 * owns the menu. While one is open, a transparent window over every display
 * takes that click, which closes the menu like any other outside click (ADR-014).
 * It appears a moment after the menu: mapped with it or just before it, the menu
 * often never paints. It takes every click on the desktop, so nothing may leave
 * it there: it goes with the menu, with the menu's owner or after a time limit,
 * which also closes a menu left open that long.
 */
const CATCHER_DELAY_MS = 150;
const CATCHER_MAX_MS = 30_000;

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
  const release = (): void => {
    clearTimeout(showing);
    clearTimeout(expiring);
    if (!window.isDestroyed()) window.removeListener('closed', release);
    if (!catcher.isDestroyed()) catcher.destroy();
  };
  const expiring = setTimeout(() => {
    release();
    if (!window.isDestroyed()) menu.closePopup(window);
  }, CATCHER_MAX_MS);
  window.once('closed', release);
  menu.popup({ window, callback: release });
}
