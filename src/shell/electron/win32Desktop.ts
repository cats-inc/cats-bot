import { createRequire } from 'node:module';

import { discoverShellHosts, shellHostsStale, type Hwnd, type ShellHosts, type ShellWindows } from './shellHosts.ts';

/**
 * SPEC-002 FR-8 / ADR-002 §1, §5: the Windows desktop and wallpaper layers.
 * A note window becomes a child of the Explorer window that holds the icons
 * (desktop layer, above the icons and below every application window, kept
 * by Show Desktop) or of the WorkerW that draws the wallpaper (below the
 * icons, display only). Calls go through koffi to user32; the attach rules
 * follow desktop-work-fleet `DesktopSurface.Attach` at revision fcaa942 (MIT):
 * child style, the same DPI awareness level, physical bounds mapped into the
 * parent's client coordinates, no activation.
 */

export type AttachedLayer = 'desktop' | 'wallpaper';

export interface DesktopHost {
  /** Puts the window under the layer's host at its current screen rectangle; false when there is no host. */
  attach(window: Hwnd, layer: AttachedLayer): boolean;
  /** Makes an attached window top-level again at the same screen rectangle. */
  detach(window: Hwnd): void;
  isAttached(window: Hwnd): boolean;
  /** The layer a window is attached to, or null when it is top-level. */
  attachedLayer(window: Hwnd): AttachedLayer | null;
  /** True while the host a window is attached to still exists. */
  hostAlive(window: Hwnd): boolean;
  /**
   * Re-reads the hosts when Explorer restarted, or when the given layer had no
   * host yet (rate-limited); returns whether they changed.
   */
  refresh(layer?: AttachedLayer): boolean;
  bringToFront(window: Hwnd): boolean;
}

const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const GWL_STYLE = -16;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOP = 0;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Loads the binding on Windows; null elsewhere or when koffi cannot load, so the shell offers normal and top only. */
export function loadDesktopHost(log: (line: string) => void): DesktopHost | null {
  if (process.platform !== 'win32') return null;
  try {
    return createWin32DesktopHost(log);
  } catch (error) {
    log(`desktop layers unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function createWin32DesktopHost(log: (line: string) => void): DesktopHost {
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
  const awarenessOf = (window: Hwnd) => Number(GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(window)));

  const windows: ShellWindows = {
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
  };

  let hosts: ShellHosts = discoverShellHosts(windows);
  let discoveredAt = Date.now();
  log(`desktop hosts: icons ${hosts.desktop || 'none'}, wallpaper ${hosts.wallpaper || 'none'}`);
  /** Attached windows and the style each had as a top-level window. */
  const attached = new Map<Hwnd, { layer: AttachedLayer; parent: Hwnd; style: number }>();

  const rectOf = (window: Hwnd): Rect => {
    const rect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
    GetWindowRect(window, rect);
    return rect;
  };

  const refresh = (layer?: AttachedLayer): boolean => {
    if (!shellHostsStale(hosts, windows, layer ?? null, Date.now() - discoveredAt)) return false;
    const before = hosts;
    hosts = discoverShellHosts(windows);
    discoveredAt = Date.now();
    if (hosts.desktop === before.desktop && hosts.wallpaper === before.wallpaper && hosts.shell === before.shell) return false;
    log(`desktop hosts changed: icons ${hosts.desktop || 'none'}, wallpaper ${hosts.wallpaper || 'none'}`);
    return true;
  };

  return {
    attach(window, layer) {
      refresh(layer);
      const parent = layer === 'desktop' ? hosts.desktop : hosts.wallpaper;
      if (parent === 0 || !IsWindow(parent)) return false;
      // Fleet requires equal contexts; Electron 41 windows are per-monitor v1 (0x12) and Explorer's are v2 (0x22),
      // so only the awareness level is compared: both per-monitor, measured correct at 150% (PLAN-002 slice 4).
      const childAwareness = awarenessOf(window);
      const hostAwareness = awarenessOf(parent);
      if (childAwareness !== hostAwareness) {
        log(`desktop ${layer} layer refused: DPI awareness ${childAwareness} differs from the host's ${hostAwareness}`);
        return false;
      }
      const current = attached.get(window);
      const style = current?.style ?? Number(GetWindowLongPtrW(window, GWL_STYLE));
      const rect = rectOf(window);
      SetWindowLongPtrW(window, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD);
      SetParent(window, parent);
      const origin = { x: rect.left, y: rect.top };
      ScreenToClient(parent, origin);
      SetWindowPos(window, HWND_TOP, origin.x, origin.y, rect.right - rect.left, rect.bottom - rect.top,
        SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW);
      attached.set(window, { layer, parent, style });
      return true;
    },
    detach(window) {
      const current = attached.get(window);
      if (!current) return;
      attached.delete(window);
      if (!IsWindow(window)) return;
      const rect = rectOf(window);
      SetParent(window, 0);
      SetWindowLongPtrW(window, GWL_STYLE, current.style);
      SetWindowPos(window, HWND_TOP, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, SWP_FRAMECHANGED | SWP_NOACTIVATE);
    },
    isAttached(window) {
      const current = attached.get(window);
      return current !== undefined && Number(GetAncestor(window, 1)) === current.parent;
    },
    attachedLayer(window) {
      const current = attached.get(window);
      return current !== undefined && Number(GetAncestor(window, 1)) === current.parent ? current.layer : null;
    },
    hostAlive(window) {
      const current = attached.get(window);
      return current !== undefined && (IsWindow(current.parent) as boolean);
    },
    refresh,
    bringToFront(window) {
      SetWindowPos(window, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
      return SetForegroundWindow(window) as boolean;
    },
  };
}
