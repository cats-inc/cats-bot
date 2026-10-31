import type { DesktopWindows, Rect } from '../../src/shell/electron/win32Desktop.ts';
import type { Hwnd } from '../../src/shell/electron/shellHosts.ts';

export const WS_CHILD = 0x40000000;
export const WS_POPUP = 0x80000000 | 0;
export const WS_VISIBLE = 0x10000000;
export const WS_CLIPSIBLINGS = 0x04000000;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_FRAMECHANGED = 0x0020;
export const SWP_SHOWWINDOW = 0x0040;
/** What GetAncestor(GA_PARENT) returns for a top-level window. */
export const DESKTOP_WINDOW = 0x10010;
export const EXPLORER = 10;
export const PROGMAN = 2;
export const ICONS_HOST = 8;
export const WALLPAPER_HOST = 9;

export interface FakeWindow {
  id: Hwnd;
  className: string;
  parent: Hwnd;
  process: number;
  style: number;
  /** Screen coordinates. */
  rect: Rect;
  awareness?: number;
}

/**
 * A window system with the classic 23H2 Explorer layout (icons in a top-level
 * WorkerW, the wallpaper in a sibling WorkerW behind it) that records what the
 * desktop host does to it. Styles are int32, as the host computes them.
 */
export class FakeDesktopWindows implements DesktopWindows {
  windows: FakeWindow[];
  /** 0x052C requests as [target, wParam, lParam]. */
  requests: Array<[Hwnd, number, number]> = [];
  positions: Array<{ window: Hwnd; x: number; y: number; width: number; height: number; flags: number }> = [];

  /** `origin` is the virtual screen's top-left, where Explorer's hosts start. */
  constructor(origin = { x: 0, y: 0 }) {
    const screen = { left: origin.x, top: origin.y, right: origin.x + 3840, bottom: origin.y + 1080 };
    const shell = (id: Hwnd, className: string, parent: Hwnd): FakeWindow =>
      ({ id, className, parent, process: EXPLORER, style: WS_VISIBLE, rect: { ...screen } });
    this.windows = [
      shell(ICONS_HOST, 'WorkerW', 0),
      shell(3, 'SHELLDLL_DefView', ICONS_HOST),
      shell(WALLPAPER_HOST, 'WorkerW', 0),
      shell(PROGMAN, 'Progman', 0),
    ];
  }

  /** A top-level note window, shown unless `shown` is false. */
  addNote(id: Hwnd, rect: Rect, shown = true): Hwnd {
    this.windows.push({ id, className: 'Chrome_WidgetWin_1', parent: 0, process: 50,
      style: WS_POPUP | WS_CLIPSIBLINGS | (shown ? WS_VISIBLE : 0), rect: { ...rect } });
    return id;
  }

  /** Explorer restarted: its windows and every child of them are gone, and new ones have new handles. */
  restartExplorer(offset: number): void {
    const gone = new Set<Hwnd>();
    const collect = (parent: Hwnd) => {
      for (const window of this.windows.filter((item) => item.parent === parent && !gone.has(item.id))) {
        gone.add(window.id);
        collect(window.id);
      }
    };
    for (const window of this.windows.filter((item) => item.process === EXPLORER && item.parent === 0)) {
      gone.add(window.id);
      collect(window.id);
    }
    const replacements = this.windows.filter((item) => item.process === EXPLORER)
      .map((item) => ({ ...item, id: item.id + offset, parent: item.parent === 0 ? 0 : item.parent + offset }));
    this.windows = [...replacements, ...this.windows.filter((item) => !gone.has(item.id))];
  }

  destroy(id: Hwnd): void {
    this.windows = this.windows.filter((window) => window.id !== id);
  }

  setShown(id: Hwnd, shown: boolean): void {
    const window = this.get(id);
    window.style = shown ? window.style | WS_VISIBLE : window.style & ~WS_VISIBLE;
  }

  get(id: Hwnd): FakeWindow {
    const window = this.windows.find((item) => item.id === id);
    if (!window) throw new Error(`no window ${id}`);
    return window;
  }

  private children(parent: Hwnd): FakeWindow[] {
    return this.windows.filter((window) => window.parent === parent);
  }

  progman(): Hwnd {
    return this.windows.find((window) => window.className === 'Progman' && window.parent === 0)?.id ?? 0;
  }
  topLevel(): Hwnd[] {
    return this.children(0).map((window) => window.id);
  }
  findChild(parent: Hwnd, after: Hwnd, className: string): Hwnd {
    const list = this.children(parent);
    const start = after === 0 ? 0 : list.findIndex((window) => window.id === after) + 1;
    return list.slice(start).find((window) => window.className === className)?.id ?? 0;
  }
  next(window: Hwnd): Hwnd {
    const self = this.windows.find((item) => item.id === window);
    if (!self) return 0;
    const siblings = this.children(self.parent);
    return siblings[siblings.findIndex((item) => item.id === window) + 1]?.id ?? 0;
  }
  processOf(window: Hwnd): number {
    return this.windows.find((item) => item.id === window)?.process ?? 0;
  }
  /** IsWindowVisible: the window and every ancestor have WS_VISIBLE. */
  visible(window: Hwnd): boolean {
    const self = this.windows.find((item) => item.id === window);
    if (!self || (self.style & WS_VISIBLE) === 0) return false;
    return self.parent === 0 || this.visible(self.parent);
  }
  alive(window: Hwnd): boolean {
    return this.windows.some((item) => item.id === window);
  }
  requestWallpaper(shell: Hwnd, wParam: number, lParam: number): void {
    this.requests.push([shell, wParam, lParam]);
  }
  style(window: Hwnd): number {
    return this.windows.find((item) => item.id === window)?.style ?? 0;
  }
  setStyle(window: Hwnd, style: number): void {
    this.get(window).style = style | 0;
  }
  setParent(window: Hwnd, parent: Hwnd): void {
    const self = this.get(window);
    // SetParent keeps the screen rectangle only until SetWindowPos places the window in the new parent.
    self.parent = parent;
  }
  parentOf(window: Hwnd): Hwnd {
    const self = this.windows.find((item) => item.id === window);
    if (!self) return 0;
    return self.parent === 0 ? DESKTOP_WINDOW : self.parent;
  }
  rect(window: Hwnd): Rect {
    return { ...this.get(window).rect };
  }
  toClient(parent: Hwnd, point: { x: number; y: number }): { x: number; y: number } {
    const origin = this.get(parent).rect;
    return { x: point.x - origin.left, y: point.y - origin.top };
  }
  setPosition(window: Hwnd, x: number, y: number, width: number, height: number, flags: number): void {
    this.positions.push({ window, x, y, width, height, flags });
    const self = this.get(window);
    if ((flags & 0x0003) !== 0x0003) {
      const origin = self.parent === 0 ? { left: 0, top: 0 } : this.get(self.parent).rect;
      self.rect = { left: origin.left + x, top: origin.top + y, right: origin.left + x + width, bottom: origin.top + y + height };
    }
    if (flags & SWP_SHOWWINDOW) self.style |= WS_VISIBLE;
  }
  awareness(window: Hwnd): number {
    return this.windows.find((item) => item.id === window)?.awareness ?? 2;
  }
  foreground(): boolean {
    return true;
  }
}
