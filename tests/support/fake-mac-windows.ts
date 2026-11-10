import type { MacWindows } from '../../src/shell/electron/macDesktop.ts';

export const LEVELS = { desktop: -2147483602, wallpaper: -2147483622, normal: 0 };
/** Electron's own collection behaviour for a note (FullScreenPrimary), as measured with Electron 41.2.0. */
export const NOTE_BEHAVIOR = 1 << 7;

/** AppKit windows by NSView handle; a freed view throws when it is messaged, as AppKit would crash. */
export class FakeMacWindows implements MacWindows {
  levels = LEVELS;
  readonly windows = new Map<number, { level: number; behavior: number; ignores: boolean; fronted: number }>();
  readonly freed = new Set<number>();
  add(view: number): number {
    this.windows.set(view, { level: LEVELS.normal, behavior: NOTE_BEHAVIOR, ignores: false, fronted: 0 });
    return view;
  }
  private window(view: number) {
    if (this.freed.has(view)) throw new Error(`messaged freed view ${view}`);
    return this.windows.get(view) ?? this.windows.set(view, { level: LEVELS.normal, behavior: NOTE_BEHAVIOR, ignores: false, fronted: 0 }).get(view)!;
  }
  level(view: number) { return this.window(view).level; }
  setLevel(view: number, level: number) { this.window(view).level = level; }
  behavior(view: number) { return this.window(view).behavior; }
  setBehavior(view: number, behavior: number) { this.window(view).behavior = behavior; }
  setIgnoresMouse(view: number, ignores: boolean) { this.window(view).ignores = ignores; }
  orderFront(view: number) { this.window(view).fronted++; }
}
