import type { QuickMenuState } from '../shared/quickMenu.ts';

/**
 * SPEC-002 FR-7 / ADR-027: what a click on the floating Cat does. With the hub's
 * quick menu off, every click opens the direct message, as before. With it on,
 * a single click waits to see whether a second follows: a double click opens the
 * direct message, a single one opens the quick menu, and a click while the menu
 * is open closes it. Plain logic with its timer passed in, so it can be tested
 * without a page.
 */

/**
 * How long a single click waits for a second. Shorter than the usual system
 * double-click time (500 ms on Windows): a slower second click still counts as
 * a double click by its click count, and then closes the menu it opened.
 */
export const QUICK_MENU_CLICK_WAIT_MS = 300;

export interface CatClickActions {
  /** Opens the direct message; the shell closes the quick menu first. */
  activate(): void;
  /** `pressedAt` is when the press began (ms since the epoch). */
  openMenu(pressedAt: number): void;
  closeMenu(): void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class CatClicks {
  private readonly actions: CatClickActions;
  private enabled = false;
  private menuOpen = false;
  private pending: unknown = null;
  private pressedAt = 0;

  constructor(actions: CatClickActions) {
    this.actions = actions;
  }

  /** The shell's word on the menu; until it speaks, the menu is off. */
  update(state: QuickMenuState): void {
    this.enabled = state.enabled;
    this.menuOpen = state.open;
    if (!state.enabled) this.cancel();
  }

  press(at: number): void {
    this.pressedAt = at;
  }

  /** A click that was not a drag; `count` is the event's click count. */
  click(count: number): void {
    if (!this.enabled) {
      this.actions.activate();
      return;
    }
    if (this.pending !== null || count >= 2) {
      this.cancel();
      this.menuOpen = false;
      this.actions.activate();
      return;
    }
    if (this.menuOpen) {
      this.menuOpen = false;
      this.actions.closeMenu();
      return;
    }
    const pressedAt = this.pressedAt;
    this.pending = this.actions.setTimer(() => {
      this.pending = null;
      this.menuOpen = true;
      this.actions.openMenu(pressedAt);
    }, QUICK_MENU_CLICK_WAIT_MS);
  }

  /** A drag moves the cat away from its menu. */
  dragStarted(): void {
    this.cancel();
    if (this.menuOpen) {
      this.menuOpen = false;
      this.actions.closeMenu();
    }
  }

  private cancel(): void {
    if (this.pending === null) return;
    this.actions.clearTimer(this.pending);
    this.pending = null;
  }
}
