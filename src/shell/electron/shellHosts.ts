/**
 * SPEC-002 FR-8 / ADR-002 §1, §5: which Explorer windows host the desktop and
 * wallpaper layers on Windows. A port of desktop-work-fleet
 * `src/native/windows/app/NativeShellLayers.cs` at revision fcaa942 (MIT):
 * Explorer hosts only, never an arbitrary bottom window; the wallpaper host is
 * requested with Explorer's private 0x052C message in bounded attempts. The
 * window system is behind an interface so the rules are tested without one.
 */

export type Hwnd = number;

export interface ShellWindows {
  progman(): Hwnd;
  topLevel(): Hwnd[];
  findChild(parent: Hwnd, after: Hwnd, className: string): Hwnd;
  /** GW_HWNDNEXT: the window below in Z order. */
  next(window: Hwnd): Hwnd;
  processOf(window: Hwnd): number;
  visible(window: Hwnd): boolean;
  alive(window: Hwnd): boolean;
  requestWallpaper(shell: Hwnd, wParam: number, lParam: number): void;
}

export interface ShellHosts {
  /** The top-level Explorer window that holds the icons (`SHELLDLL_DefView`); 0 when none. */
  desktop: Hwnd;
  /** The Explorer `WorkerW` that draws the wallpaper below the icons; 0 when none. */
  wallpaper: Hwnd;
  /** Progman when the hosts were found; a different Progman means Explorer restarted. */
  shell: Hwnd;
}

export function shellHostsChanged(hosts: ShellHosts, windows: ShellWindows): boolean {
  return windows.progman() !== hosts.shell
    || (hosts.desktop !== 0 && !windows.alive(hosts.desktop))
    || (hosts.wallpaper !== 0 && !windows.alive(hosts.wallpaper));
}

export function discoverShellHosts(windows: ShellWindows): ShellHosts {
  const shell = windows.progman();
  if (shell === 0) return { desktop: 0, wallpaper: 0, shell };
  const explorer = windows.processOf(shell);
  let hosts = findHosts(shell, explorer, windows);
  if (hosts.wallpaper !== 0) return hosts;
  // New Explorer uses a WorkerW child; older Explorer a sibling behind the icon host.
  for (const [wParam, lParam] of [[13, 0], [13, 1], [0, 0]] as const) {
    windows.requestWallpaper(shell, wParam, lParam);
    hosts = findHosts(shell, explorer, windows);
    if (hosts.wallpaper !== 0) break;
  }
  return hosts;
}

function findHosts(shell: Hwnd, explorer: number, windows: ShellWindows): ShellHosts {
  let desktop: Hwnd = 0;
  for (const window of windows.topLevel()) {
    if (windows.processOf(window) !== explorer || windows.findChild(window, 0, 'SHELLDLL_DefView') === 0) continue;
    desktop = window;
    break;
  }
  if (desktop === 0) return { desktop, wallpaper: 0, shell };
  const icons = windows.findChild(desktop, 0, 'SHELLDLL_DefView');
  const belowIcons = (window: Hwnd) => {
    for (let sibling = windows.next(icons); sibling !== 0; sibling = windows.next(sibling)) {
      if (sibling === window) return true;
    }
    return false;
  };
  const suitable = (window: Hwnd) => window !== 0 && windows.visible(window)
    && windows.processOf(window) === explorer && windows.findChild(window, 0, 'SHELLDLL_DefView') === 0;
  // Modern shell: the wallpaper surface is below DefView inside the same desktop host.
  for (let child = windows.findChild(desktop, 0, 'WorkerW'); child !== 0; child = windows.findChild(desktop, child, 'WorkerW')) {
    if (suitable(child) && belowIcons(child)) return { desktop, wallpaper: child, shell };
  }
  // Classic shell: only WorkerW siblings after the icon host in native Z order.
  for (let sibling = windows.findChild(0, desktop, 'WorkerW'); sibling !== 0; sibling = windows.findChild(0, sibling, 'WorkerW')) {
    if (suitable(sibling)) return { desktop, wallpaper: sibling, shell };
  }
  return { desktop, wallpaper: 0, shell };
}
