import { createRequire } from 'node:module';
import { diagnosticError } from '../../shared/diagnosticLog.ts';

import {
  discoverShellHosts,
  repaintWallpaper,
  shellHostsStale,
  type Hwnd,
  type ShellHosts,
  type ShellWindows,
} from './shellHosts.ts';

/**
 * SPEC-002 FR-8 / ADR-002 §1, §5: the Windows desktop and wallpaper layers.
 * A note window becomes a child of the Explorer window that holds the icons
 * (desktop layer, above the icons and below every application window, kept
 * by Show Desktop) or of the WorkerW that draws the wallpaper (below the
 * icons, display only). Calls go through koffi to user32; the attach rules
 * follow desktop-work-fleet `DesktopSurface.Attach` at revision fcaa942 (MIT):
 * child style, the same DPI awareness level, physical bounds mapped into the
 * parent's client coordinates, no activation.
 *
 * ADR-011: where a shown window leaves Explorer's wallpaper host, the host
 * keeps what was left in its surface there (white for a note) and does not
 * draw the wallpaper there again by itself, so every way a shown note leaves
 * the wallpaper layer (another host, top-level, hidden, destroyed) ends with a
 * request for Explorer to draw the wallpaper again. A note that was hidden
 * already uncovers nothing and sends none.
 */

export type AttachedLayer = 'desktop' | 'wallpaper';

/** A window the shell has just hidden or destroyed, and whether it was shown until then. */
export interface ReleasedWindow {
  window: Hwnd;
  shown: boolean;
}

export interface DesktopHost {
  /** Puts the window under the layer's host at its current screen rectangle; false when there is no host. */
  attach(window: Hwnd, layer: AttachedLayer): boolean;
  /** Makes an attached window top-level again at the same screen rectangle; also forgets a destroyed one. */
  detach(window: Hwnd): void;
  /**
   * Attached windows the shell has just hidden or destroyed. If any of them was
   * shown on the wallpaper, Explorer is asked once to draw the wallpaper again;
   * destroyed windows are forgotten.
   */
  released(windows: readonly ReleasedWindow[]): void;
  isAttached(window: Hwnd): boolean;
  /** The layer a window is attached to, or null when it is top-level. */
  attachedLayer(window: Hwnd): AttachedLayer | null;
  /** True while the host a window is attached to still exists. */
  hostAlive(window: Hwnd): boolean;
  /**
   * Forgets attached windows that are gone or whose host is gone, then re-reads
   * the hosts when Explorer restarted, or when the given layer had no host yet
   * (rate-limited); returns whether the hosts changed.
   */
  refresh(layer?: AttachedLayer): boolean;
  bringToFront(window: Hwnd): boolean;
}

const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const GWL_STYLE = -16;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOP = 0;

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The user32 calls the desktop host makes besides discovering the hosts, so
 * its rules are tested against fake windows; koffi binds them on Windows.
 */
export interface DesktopWindows extends ShellWindows {
  /** GetWindowLongPtrW(GWL_STYLE). */
  style(window: Hwnd): number;
  /** SetWindowLongPtrW(GWL_STYLE). */
  setStyle(window: Hwnd, style: number): void;
  setParent(window: Hwnd, parent: Hwnd): void;
  /** GetAncestor(GA_PARENT). */
  parentOf(window: Hwnd): Hwnd;
  /** GetWindowRect: screen coordinates. */
  rect(window: Hwnd): Rect;
  /** ScreenToClient. */
  toClient(parent: Hwnd, point: { x: number; y: number }): { x: number; y: number };
  /** SetWindowPos with HWND_TOP. */
  setPosition(window: Hwnd, x: number, y: number, width: number, height: number, flags: number): void;
  /** The DPI awareness level of the window's context. */
  awareness(window: Hwnd): number;
  /** SetForegroundWindow. */
  foreground(window: Hwnd): boolean;
}

/** Loads the binding on Windows; null elsewhere or when koffi cannot load, so the shell offers normal and top only. */
export function loadDesktopHost(log: (line: string, level?: 'info' | 'warn' | 'error') => void): DesktopHost | null {
  if (process.platform !== 'win32') return null;
  try {
    return createWin32DesktopHost(log);
  } catch (error) {
    log(`desktop layers unavailable: ${diagnosticError(error)}`, 'error');
    return null;
  }
}

function createWin32DesktopHost(log: (line: string, level?: 'info' | 'warn' | 'error') => void): DesktopHost {
  return createDesktopHost(bindUser32(), log);
}

function bindUser32(): DesktopWindows {
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
  const user32 = koffi.load('user32.dll');
  const enumProc = koffi.proto('bool __stdcall CatsBotEnumProc(intptr_t hwnd, intptr_t lParam)');
  koffi.struct('CatsBotPoint', { x: 'long', y: 'long' });
  koffi.struct('CatsBotRect', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  const FindWindowW = user32.func('intptr_t __stdcall FindWindowW(str16 cls, str16 title)');
  const FindWindowExW = user32.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, str16 cls, str16 title)');
  const EnumWindows = user32.func('bool __stdcall EnumWindows(CatsBotEnumProc *callback, intptr_t lParam)');
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)');
  const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
  const GetWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t command)');
  const SendMessageTimeoutW = user32.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *result)');
  const SetParent = user32.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)');
  const GetAncestor = user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32_t flags)');
  const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)');
  const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)');
  const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ CatsBotRect *rect)');
  const ScreenToClient = user32.func('bool __stdcall ScreenToClient(intptr_t hwnd, _Inout_ CatsBotPoint *point)');
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)');
  const GetWindowDpiAwarenessContext = user32.func('intptr_t __stdcall GetWindowDpiAwarenessContext(intptr_t hwnd)');
  const GetAwarenessFromDpiAwarenessContext = user32.func('int __stdcall GetAwarenessFromDpiAwarenessContext(intptr_t context)');

  return {
    progman: () => Number(FindWindowW('Progman', null)),
    topLevel: () => {
      const list: Hwnd[] = [];
      const callback = koffi.register((hwnd: number) => {
        list.push(Number(hwnd));
        return true;
      }, koffi.pointer(enumProc));
      try {
        EnumWindows(callback, 0);
      } finally {
        koffi.unregister(callback);
      }
      return list;
    },
    findChild: (parent, after, className) => Number(FindWindowExW(parent, after, className, null)),
    next: (window) => Number(GetWindow(window, 2)),
    processOf: (window) => {
      const pid = [0];
      GetWindowThreadProcessId(window, pid);
      return pid[0]!;
    },
    visible: (window) => IsWindowVisible(window) as boolean,
    alive: (window) => IsWindow(window) as boolean,
    requestWallpaper: (shell, wParam, lParam) => {
      SendMessageTimeoutW(shell, 0x052c, wParam, lParam, 3, 250, [0]);
    },
    style: (window) => Number(GetWindowLongPtrW(window, GWL_STYLE)),
    setStyle: (window, style) => {
      SetWindowLongPtrW(window, GWL_STYLE, style);
    },
    setParent: (window, parent) => {
      SetParent(window, parent);
    },
    parentOf: (window) => Number(GetAncestor(window, 1)),
    rect: (window) => {
      const rect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
      GetWindowRect(window, rect);
      return rect;
    },
    toClient: (parent, point) => {
      const mapped = { ...point };
      ScreenToClient(parent, mapped);
      return mapped;
    },
    setPosition: (window, x, y, width, height, flags) => {
      SetWindowPos(window, HWND_TOP, x, y, width, height, flags);
    },
    awareness: (window) => Number(GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(window))),
    foreground: (window) => SetForegroundWindow(window) as boolean,
  };
}

/** The desktop host's rules over any window system; `now` is the clock for the missing-host retry. */
export function createDesktopHost(windows: DesktopWindows, log: (line: string, level?: 'info' | 'warn' | 'error') => void, now: () => number = Date.now): DesktopHost {

  let hosts: ShellHosts = discoverShellHosts(windows);
  let discoveredAt = now();
  log(`desktop hosts: icons ${hosts.desktop || 'none'}, wallpaper ${hosts.wallpaper || 'none'}`);
  /** Attached windows and the style each had as a top-level window. */
  const attached = new Map<Hwnd, { layer: AttachedLayer; parent: Hwnd; style: number }>();

  /** ADR-011: what a shown window left on the wallpaper host stays until Explorer draws the wallpaper again. */
  const restoreWallpaper = () => {
    repaintWallpaper(hosts, windows);
  };

  /**
   * A child dies with its parent, so an entry whose window or host is gone is stale; Explorer
   * restarting takes attached notes down this way, unreported. Kept, a later window given the same
   * handle would inherit the old style and layer. The new hosts draw a fresh wallpaper.
   */
  const forgetStale = () => {
    for (const [window, entry] of attached) {
      if (!windows.alive(window) || !windows.alive(entry.parent)) attached.delete(window);
    }
  };

  /** Shown as the shell means it: the window's own WS_VISIBLE, whatever its host's. */
  const shown = (window: Hwnd): boolean => (windows.style(window) & WS_VISIBLE) !== 0;

  /**
   * A saved style with the window's visibility now: the style saved at the first attach
   * carries WS_VISIBLE from then, and writing it back would show a hidden note.
   */
  const withCurrentVisibility = (window: Hwnd, style: number): number =>
    (style & ~WS_VISIBLE) | (windows.style(window) & WS_VISIBLE);

  const refresh = (layer?: AttachedLayer): boolean => {
    forgetStale();
    if (!shellHostsStale(hosts, windows, layer ?? null, now() - discoveredAt)) return false;
    const before = hosts;
    hosts = discoverShellHosts(windows);
    discoveredAt = now();
    if (hosts.desktop === before.desktop && hosts.wallpaper === before.wallpaper && hosts.shell === before.shell) return false;
    log(`desktop hosts changed: icons ${hosts.desktop || 'none'}, wallpaper ${hosts.wallpaper || 'none'}`);
    return true;
  };

  return {
    attach(window, layer) {
      refresh(layer);
      const parent = layer === 'desktop' ? hosts.desktop : hosts.wallpaper;
      if (parent === 0 || !windows.alive(parent)) return false;
      // Fleet requires equal contexts; Electron 41 windows are per-monitor v1 (0x12) and Explorer's are v2 (0x22),
      // so only the awareness level is compared: both per-monitor, measured correct at 150% (PLAN-002 slice 4).
      const childAwareness = windows.awareness(window);
      const hostAwareness = windows.awareness(parent);
      if (childAwareness !== hostAwareness) {
        log(`desktop ${layer} layer refused: DPI awareness ${childAwareness} differs from the host's ${hostAwareness}`, 'warn');
        return false;
      }
      const current = attached.get(window);
      const uncovers = current?.layer === 'wallpaper' && current.parent !== parent && shown(window);
      const style = current?.style ?? windows.style(window);
      const rect = windows.rect(window);
      windows.setStyle(window, withCurrentVisibility(window, (style & ~WS_POPUP) | WS_CHILD));
      windows.setParent(window, parent);
      const origin = windows.toClient(parent, { x: rect.left, y: rect.top });
      // No SWP_SHOWWINDOW (fleet's Attach has none either) and the current WS_VISIBLE: a hidden note whose
      // layer is changed in settings stays hidden.
      windows.setPosition(window, origin.x, origin.y, rect.right - rect.left, rect.bottom - rect.top,
        SWP_FRAMECHANGED | SWP_NOACTIVATE);
      attached.set(window, { layer, parent, style });
      if (uncovers) restoreWallpaper();
      return true;
    },
    detach(window) {
      const current = attached.get(window);
      if (!current) return;
      attached.delete(window);
      // A child dies with its host, so with the host gone the entry is stale and a window with its handle is another
      // one (a lift can come before anything looks at the hosts again): left alone, and nothing to uncover.
      if (!windows.alive(current.parent)) return;
      // A destroyed window may have been shown until then.
      const uncovers = current.layer === 'wallpaper' && (!windows.alive(window) || shown(window));
      if (windows.alive(window)) {
        const rect = windows.rect(window);
        windows.setParent(window, 0);
        windows.setStyle(window, withCurrentVisibility(window, current.style));
        windows.setPosition(window, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, SWP_FRAMECHANGED | SWP_NOACTIVATE);
      }
      if (uncovers) restoreWallpaper();
    },
    released(list) {
      let uncovered = false;
      for (const { window, shown } of list) {
        const current = attached.get(window);
        if (!current) continue;
        if (shown && current.layer === 'wallpaper') uncovered = true;
        if (!windows.alive(window)) attached.delete(window);
      }
      if (uncovered) restoreWallpaper();
    },
    isAttached(window) {
      const current = attached.get(window);
      return current !== undefined && windows.parentOf(window) === current.parent;
    },
    attachedLayer(window) {
      const current = attached.get(window);
      return current !== undefined && windows.parentOf(window) === current.parent ? current.layer : null;
    },
    hostAlive(window) {
      const current = attached.get(window);
      return current !== undefined && windows.alive(current.parent);
    },
    refresh,
    bringToFront(window) {
      windows.setPosition(window, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
      return windows.foreground(window);
    },
  };
}
