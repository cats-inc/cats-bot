import { createRequire } from 'node:module';

import type { Hwnd } from './shellHosts.ts';
import type { AttachedLayer, DesktopHost } from './win32Desktop.ts';

/**
 * SPEC-002 FR-8 / ADR-016: the macOS desktop and wallpaper layers. A note is
 * not reparented as on Windows; its NSWindow moves to a window level: one
 * above the desktop icons (below every application window) for the desktop
 * layer, one above the desktop picture (below the icons, display only) for
 * the wallpaper layer. It also joins every Space and stays put in Mission
 * Control, as the desktop does. Electron has no API for these levels, so
 * koffi calls AppKit through the Objective-C runtime.
 *
 * A window's handle is the NSView Electron reports. AppKit cannot tell a live
 * view from a freed one, so the host messages a window only in a call the
 * shell makes about a live BrowserWindow; `released` never messages one.
 * The layer a window is on is read back from its level, because Electron's
 * setAlwaysOnTop() resets the level (measured with Electron 41.2.0).
 */

/** NSWindowCollectionBehavior: CanJoinAllSpaces | Stationary | IgnoresCycle. */
export const ATTACHED_BEHAVIOR = (1 << 0) | (1 << 4) | (1 << 6);

/** The AppKit calls the host makes, so its rules are tested without AppKit; koffi binds them on macOS. */
export interface MacWindows {
  /** The window levels of the two layers and of an ordinary window. */
  levels: Record<AttachedLayer | 'normal', number>;
  level(view: Hwnd): number;
  setLevel(view: Hwnd, level: number): void;
  behavior(view: Hwnd): number;
  setBehavior(view: Hwnd, behavior: number): void;
  setIgnoresMouse(view: Hwnd, ignores: boolean): void;
  orderFront(view: Hwnd): void;
}

export function loadMacDesktopHost(log: (line: string, level?: 'info' | 'warn' | 'error') => void): DesktopHost {
  const windows = bindAppKit();
  log(`desktop layers: desktop level ${windows.levels.desktop}, wallpaper level ${windows.levels.wallpaper}`);
  return createMacDesktopHost(windows);
}

function bindAppKit(): MacWindows {
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const graphics = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const selector = objc.func('intptr_t sel_registerName(const char *name)');
  const sendId = objc.func('objc_msgSend', 'intptr_t', ['intptr_t', 'intptr_t']);
  const sendLong = objc.func('objc_msgSend', 'long', ['intptr_t', 'intptr_t']);
  const sendULong = objc.func('objc_msgSend', 'unsigned long', ['intptr_t', 'intptr_t']);
  const sendSetLong = objc.func('objc_msgSend', 'void', ['intptr_t', 'intptr_t', 'long']);
  const sendSetULong = objc.func('objc_msgSend', 'void', ['intptr_t', 'intptr_t', 'unsigned long']);
  const sendSetBool = objc.func('objc_msgSend', 'void', ['intptr_t', 'intptr_t', 'bool']);
  const levelForKey = graphics.func('int32_t CGWindowLevelForKey(int32_t key)');
  const selectors = new Map<string, number>();
  const sel = (name: string): number => {
    let value = selectors.get(name);
    if (value === undefined) {
      value = Number(selector(name));
      selectors.set(name, value);
    }
    return value;
  };
  const windowOf = (view: Hwnd): number => {
    const window = Number(sendId(view, sel('window')));
    if (window === 0) throw new Error('The note has no window');
    return window;
  };
  // CGWindowLevelKey: kCGDesktopWindowLevelKey 2, kCGNormalWindowLevelKey 4, kCGDesktopIconWindowLevelKey 18.
  return {
    levels: { desktop: levelForKey(18) + 1, wallpaper: levelForKey(2) + 1, normal: levelForKey(4) },
    level: (view) => Number(sendLong(windowOf(view), sel('level'))),
    setLevel: (view, level) => sendSetLong(windowOf(view), sel('setLevel:'), level),
    behavior: (view) => Number(sendULong(windowOf(view), sel('collectionBehavior'))),
    setBehavior: (view, behavior) => sendSetULong(windowOf(view), sel('setCollectionBehavior:'), behavior),
    setIgnoresMouse: (view, ignores) => sendSetBool(windowOf(view), sel('setIgnoresMouseEvents:'), ignores),
    orderFront: (view) => {
      sendId(windowOf(view), sel('orderFrontRegardless'));
    },
  };
}

/** The desktop host's rules over any AppKit-like window system. */
export function createMacDesktopHost(windows: MacWindows): DesktopHost {
  /** What each attached window had as an ordinary window. An entry exists while the window is at a layer's level. */
  const ordinary = new Map<Hwnd, { level: number; behavior: number }>();

  const layerOf = (view: Hwnd): AttachedLayer | null => {
    const level = windows.level(view);
    return level === windows.levels.desktop ? 'desktop' : level === windows.levels.wallpaper ? 'wallpaper' : null;
  };

  return {
    attach(view, layer) {
      if (!ordinary.has(view)) ordinary.set(view, { level: windows.level(view), behavior: windows.behavior(view) });
      windows.setLevel(view, windows.levels[layer]);
      windows.setBehavior(view, ATTACHED_BEHAVIOR);
      windows.setIgnoresMouse(view, layer === 'wallpaper');
      return true;
    },
    detach(view) {
      const saved = ordinary.get(view);
      if (!saved) return;
      ordinary.delete(view);
      windows.setIgnoresMouse(view, false);
      windows.setBehavior(view, saved.behavior);
      windows.setLevel(view, saved.level);
    },
    // Nothing to redraw, and a destroyed window cannot be messaged. A hidden note keeps its entry for its next detach.
    released() {},
    /** Whether the host manages the window's level, Spaces behaviour and mouse handling. */
    isAttached: (view) => ordinary.has(view),
    attachedLayer: (view) => (ordinary.has(view) ? layerOf(view) : null),
    // No host window can disappear; what can is the level, so the shell's periodic check attaches again after a reset.
    hostAlive: (view) => ordinary.has(view) && layerOf(view) !== null,
    refresh: () => false,
    bringToFront(view) {
      windows.orderFront(view);
      return true;
    },
  };
}
