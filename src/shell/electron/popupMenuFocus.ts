import type { BrowserWindow, Menu } from 'electron';

const active = new WeakMap<BrowserWindow, () => void>();

/** Give normally unfocusable menu owners temporary focus on Windows/macOS. */
export function popupMenuWithFocus(menu: Menu, window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  // A late callback from an earlier popup must not undo the next one's focus.
  active.get(window)?.();
  if (window.isFocusable()) {
    menu.popup({ window });
    return;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    active.delete(window);
    menu.removeListener('menu-will-close', release);
    window.removeListener('hide', cancel);
    window.removeListener('closed', release);
    if (window.isDestroyed()) return;
    window.setFocusable(false);
    // On macOS setFocusable(false) alone does not remove existing focus.
    if (window.isFocused()) window.blur();
  };
  const cancel = (): void => {
    try {
      if (!window.isDestroyed()) menu.closePopup(window);
    } finally {
      release();
    }
  };
  active.set(window, cancel);
  menu.once('menu-will-close', release);
  window.once('hide', cancel);
  window.once('closed', release);
  try {
    window.setFocusable(true);
    window.focus();
    menu.popup({ window, callback: release });
  } catch (error) {
    release();
    throw error;
  }
}
