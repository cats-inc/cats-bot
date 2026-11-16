import { app, BrowserWindow, screen } from 'electron';

import type { Locale } from '../../shared/language.ts';
import type { QuickMenuView } from '../../shared/quickMenu.ts';
import { guardNavigation } from './navigation.ts';
import { FLOATING_HEAD, quickMenuLayout, type QuickMenuItem } from './quickMenu.ts';
import { pageUrl, type PageWindowOptions } from './settingsWindow.ts';
import { applyWindowIdentity } from './windowIdentity.ts';

/**
 * SPEC-002 FR-7a / ADR-027: the floating Cat's quick menu on Windows and macOS.
 * Its own transparent, topmost window beside the cat, made when it opens and
 * destroyed when it closes. Unlike the cat, it takes focus, so focus moving
 * anywhere else closes it; the cat's own window never changes focusability.
 * Linux shows the same items as a native menu instead (ADR-014's input and
 * focus limits apply to any window of ours there).
 */

/** A menu nobody answered goes away on its own, like popupMenu's catcher. */
const QUICK_MENU_MAX_MS = 60_000;

export interface QuickMenuWindowOptions extends PageWindowOptions {
  log?(line: string): void;
  /** Told whenever the menu opens or closes. */
  changed(open: boolean): void;
}

export class QuickMenuWindow {
  private readonly options: QuickMenuWindowOptions;
  private window: BrowserWindow | null = null;
  private items: QuickMenuItem[] = [];
  private view: QuickMenuView | null = null;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  /** When focus leaving last closed the menu (ms since the epoch). */
  private blurredAt = 0;

  constructor(options: QuickMenuWindowOptions) {
    this.options = options;
  }

  get open(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  owns(webContentsId: number): boolean {
    return this.open && this.window!.webContents.id === webContentsId;
  }

  /** For the menu page only. */
  state(): QuickMenuView | null {
    return this.open ? this.view : null;
  }

  /**
   * Opens beside the cat whose floating window is `floating`. `pressedAt` is
   * when the click that asked for it began: a press that itself took focus from
   * an open menu, and so closed it, does not open it again.
   */
  async show(floating: BrowserWindow, items: QuickMenuItem[], pressedAt: number, labels: { locale: Locale; title: string }): Promise<void> {
    if (this.open || items.length === 0 || this.blurredAt >= pressedAt) return;
    const [x = 0, y = 0] = floating.getPosition();
    const display = screen.getDisplayNearestPoint({ x: x + FLOATING_HEAD.x, y: y + FLOATING_HEAD.y });
    const layout = quickMenuLayout({ x, y }, display.workArea, items.length);
    const window = new BrowserWindow({
      ...layout.bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      alwaysOnTop: true,
      show: false,
      title: labels.title,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.window = window;
    this.items = items;
    this.view = {
      ...labels,
      side: layout.side,
      head: layout.head,
      item: layout.item,
      items: items.map((item, index) => ({
        kind: item.kind, label: item.label, unread: item.unread, waiting: item.waiting, ...layout.items[index]!,
      })),
    };
    applyWindowIdentity(window, this.options.identity);
    guardNavigation(window.webContents);
    // Above the cat, which is on the screen-saver level too.
    window.setAlwaysOnTop(true, 'screen-saver');
    window.on('blur', () => {
      if (this.window !== window) return;
      this.blurredAt = Date.now();
      this.close();
    });
    window.on('closed', () => {
      if (this.window === window) this.forget();
    });
    this.options.changed(true);
    try {
      await window.loadURL(pageUrl(this.options.rendererDir, 'quickMenu.html'));
    } catch (error) {
      // Closed while it loaded (a second click, a drag): that load was meant to stop.
      if (this.window !== window) return;
      this.close();
      throw error;
    }
    if (this.window !== window || window.isDestroyed()) return;
    window.show();
    // The click on the cat was this app's input, so Windows lets it take the foreground.
    // A Mac app is made active first; the native acceptance of that is still open (ADR-027).
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.focus();
    this.expiry = setTimeout(() => this.close(), QUICK_MENU_MAX_MS);
  }

  /** The item the page chose, which closes the menu; null for anything not on it. */
  choose(index: unknown): QuickMenuItem | null {
    if (!this.open || typeof index !== 'number' || !Number.isInteger(index)) return null;
    const item = this.items[index] ?? null;
    if (item) this.close();
    return item;
  }

  close(): void {
    const window = this.window;
    if (!window) return;
    this.forget();
    if (!window.isDestroyed()) window.destroy();
  }

  private forget(): void {
    clearTimeout(this.expiry);
    this.expiry = undefined;
    this.window = null;
    this.items = [];
    this.view = null;
    this.options.changed(false);
  }
}
