import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserWindow, screen } from 'electron';

import type { BotCore } from '../../core/bot.ts';
import type { BotHostEvent } from '../../core/types.ts';
import { DEFAULT_NOTE_SIZE, readShellState, writeShellState, type NoteViewState, type ShellState } from './viewState.ts';

/**
 * SPEC-001 FR-33 / FR-34: one frameless sticky-note window per conversation.
 * Closing a note hides it (the conversation and the bot keep running);
 * deleting a conversation and quitting the bot are separate actions.
 */

export interface NoteWindowsOptions {
  core: BotCore;
  botRoot: string;
  preloadPath: string;
  rendererDir: string;
  isQuitting(): boolean;
}

function clampToScreen(bounds: { x: number; y: number; width: number; height: number }) {
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

export class NoteWindows {
  private readonly options: NoteWindowsOptions;
  private readonly windows = new Map<string, BrowserWindow>();
  private state: ShellState;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(options: NoteWindowsOptions) {
    this.options = options;
    this.state = readShellState(options.botRoot);
  }

  get shellState(): ShellState {
    return this.state;
  }

  setOpenAtLogin(value: boolean): void {
    this.state.openAtLogin = value;
    this.persist();
  }

  /** Saves the shell state soon; the floating bot shares the file. */
  persist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeShellState(this.options.botRoot, this.state);
    }, 250);
    this.saveTimer.unref?.();
  }

  private viewState(conversationId: string): NoteViewState {
    let view = this.state.views[conversationId];
    if (!view) {
      view = { ...DEFAULT_NOTE_SIZE, alwaysOnTop: false, open: false };
      this.state.views[conversationId] = view;
    }
    return view;
  }

  listOpen(): string[] {
    return [...this.windows.entries()].filter(([, window]) => window.isVisible()).map(([id]) => id);
  }

  /** Conversations whose note was open when the shell last ran. */
  previouslyOpen(): string[] {
    return Object.entries(this.state.views).filter(([, view]) => view.open).map(([id]) => id);
  }

  async open(conversationId: string): Promise<BrowserWindow> {
    const existing = this.windows.get(conversationId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      this.viewState(conversationId).open = true;
      this.persist();
      await this.options.core.openView(conversationId);
      return existing;
    }
    const view = this.viewState(conversationId);
    const bounds = view.x !== undefined && view.y !== undefined
      ? clampToScreen({ x: view.x, y: view.y, width: view.width, height: view.height })
      : { width: view.width, height: view.height };
    const window = new BrowserWindow({
      ...bounds,
      minWidth: 260,
      minHeight: 240,
      frame: false,
      show: false,
      skipTaskbar: false,
      alwaysOnTop: view.alwaysOnTop,
      autoHideMenuBar: true,
      backgroundColor: '#fff8d6',
      title: 'Cats Bot',
      icon: join(this.options.rendererDir, '..', 'icon.png'),
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.windows.set(conversationId, window);
    const url = pathToFileURL(join(this.options.rendererDir, 'note.html'));
    url.searchParams.set('conversation', conversationId);
    window.on('close', (event) => {
      if (this.options.isQuitting()) return;
      event.preventDefault();
      window.hide();
      view.open = false;
      this.persist();
      void this.options.core.closeView(conversationId);
    });
    window.on('closed', () => {
      this.windows.delete(conversationId);
    });
    const remember = () => {
      if (window.isDestroyed() || !window.isVisible()) return;
      const { x, y, width, height } = window.getBounds();
      Object.assign(view, { x, y, width, height });
      this.persist();
    };
    window.on('moved', remember);
    window.on('resized', remember);
    window.on('show', () => {
      view.open = true;
      this.persist();
    });
    await window.loadURL(url.href);
    window.show();
    await this.options.core.openView(conversationId);
    return window;
  }

  hide(conversationId: string): void {
    const window = this.windows.get(conversationId);
    if (window && !window.isDestroyed()) window.close();
  }

  togglePin(conversationId: string): boolean {
    const window = this.windows.get(conversationId);
    const view = this.viewState(conversationId);
    view.alwaysOnTop = !view.alwaysOnTop;
    if (window && !window.isDestroyed()) window.setAlwaysOnTop(view.alwaysOnTop, 'floating');
    this.persist();
    return view.alwaysOnTop;
  }

  /** Whether the note of a conversation is the window the owner is looking at. */
  isFocused(conversationId: string): boolean {
    const window = this.windows.get(conversationId);
    return window !== undefined && !window.isDestroyed() && window.isVisible() && window.isFocused();
  }

  isPinned(conversationId: string): boolean {
    return this.viewState(conversationId).alwaysOnTop;
  }

  windowFor(webContentsId: number): { conversationId: string; window: BrowserWindow } | null {
    for (const [conversationId, window] of this.windows) {
      if (!window.isDestroyed() && window.webContents.id === webContentsId) return { conversationId, window };
    }
    return null;
  }

  broadcast(event: BotHostEvent): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.webContents.send('bot:event', event);
    }
  }

  forget(conversationId: string): void {
    const window = this.windows.get(conversationId);
    if (window && !window.isDestroyed()) window.destroy();
    this.windows.delete(conversationId);
    delete this.state.views[conversationId];
    this.persist();
  }

  destroyAll(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      writeShellState(this.options.botRoot, this.state);
    }
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
  }
}
