import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserWindow } from 'electron';

import type { BotHostEvent } from '../../core/types.ts';
import { guardNavigation } from './navigation.ts';
import { applyWindowIdentity, type WindowIdentity } from './windowIdentity.ts';

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
}

export function pageUrl(rendererDir: string, page: string, query: Record<string, string> = {}): string {
  const url = pathToFileURL(join(rendererDir, page));
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}

export function createPageWindow(options: PageWindowOptions, init: { width: number; height: number; title: string }): BrowserWindow {
  const window = new BrowserWindow({
    width: init.width,
    height: init.height,
    minWidth: 600,
    minHeight: 460,
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
  return window;
}

export class SettingsWindow {
  private readonly options: PageWindowOptions;
  private window: BrowserWindow | null = null;

  constructor(options: PageWindowOptions) {
    this.options = options;
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
    await window.loadURL(pageUrl(this.options.rendererDir, 'settings.html', tab ? { tab } : {}));
    window.show();
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
