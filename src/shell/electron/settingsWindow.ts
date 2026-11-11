import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserWindow, screen } from 'electron';

import type { BotHostEvent } from '../../core/types.ts';
import { guardNavigation } from './navigation.ts';
import { applyWindowIdentity, type WindowIdentity } from './windowIdentity.ts';
import { fitPageWindow, readPageWindowPlacement, rememberPageWindow, type PageWindowPlacement } from './pageWindowState.ts';

/**
 * SPEC-002 FR-4: one settings window per bot, with tabs for the bot's
 * target and personality, its notes, its life rhythm, Telegram and the app.
 * The same page runs the first-run setup with `mode=setup`.
 */

export interface PageWindowOptions {
  preloadPath: string;
  /** The built pages (`dist/renderer`, ADR-003). */
  rendererDir: string;
  iconPath: string;
  /** SPEC-008 FR-17: the bot a window belongs to; hub windows have none. */
  identity?: WindowIdentity;
  placement?: PageWindowPlacement;
}

export function pageUrl(rendererDir: string, page: string, query: Record<string, string> = {}): string {
  const url = pathToFileURL(join(rendererDir, page));
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}

/** SPEC-010 FR-2: the setup wizard's window: Settings' size, and small enough for its first page to fit. */
export const SETUP_WINDOW_SIZE = { width: 860, height: 640, minWidth: 800, minHeight: 600 } as const;

export function createPageWindow(options: PageWindowOptions, init: { width: number; height: number; title: string; minWidth?: number; minHeight?: number }): BrowserWindow {
  const saved = options.placement ? readPageWindowPlacement(options.placement) : null;
  const minimum = { width: init.minWidth ?? 600, height: init.minHeight ?? 460 };
  const area = saved ? screen.getDisplayMatching(saved).workArea : null;
  const bounds = saved && area ? fitPageWindow(saved, area, minimum) : null;
  const window = new BrowserWindow({
    width: init.width,
    height: init.height,
    ...bounds,
    minWidth: area ? Math.min(minimum.width, area.width) : minimum.width,
    minHeight: area ? Math.min(minimum.height, area.height) : minimum.height,
    show: false,
    autoHideMenuBar: true,
    title: init.title,
    icon: options.iconPath,
    backgroundColor: '#fffaf0',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  window.removeMenu();
  applyWindowIdentity(window, options.identity);
  guardNavigation(window.webContents);
  if (saved?.maximized) window.maximize();
  if (saved?.fullScreen) window.setFullScreen(true);
  if (options.placement) rememberPageWindow(window, options.placement);
  return window;
}

export class SettingsWindow {
  private readonly options: PageWindowOptions;
  private readonly query: Record<string, string>;
  private window: BrowserWindow | null = null;

  /** `query` selects the page's scope: Cats Bot Settings (SPEC-008 FR-5, PLAN-010) opens with `scope=hub`. */
  constructor(options: PageWindowOptions, query: Record<string, string> = {}) {
    this.options = options;
    this.query = query;
  }

  async open(tab?: string): Promise<void> {
    const existing = this.window;
    if (existing && !existing.isDestroyed()) {
      if (tab) existing.webContents.send('settings:navigate', tab);
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    const window = createPageWindow(this.options, { width: 860, height: 640, title: 'Cats Bot Settings' });
    this.window = window;
    window.on('closed', () => {
      if (this.window === window) this.window = null;
    });
    await window.loadURL(pageUrl(this.options.rendererDir, 'settings.html', { ...this.query, ...(tab ? { tab } : {}) }));
    if (!window.isDestroyed() && this.window === window) window.show();
  }

  get browserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  owns(webContentsId: number): boolean {
    const window = this.browserWindow;
    return window !== null && window.webContents.id === webContentsId;
  }

  broadcast(event: BotHostEvent): void {
    this.browserWindow?.webContents.send('bot:event', event);
  }

  destroy(): void {
    this.browserWindow?.destroy();
    this.window = null;
  }
}
