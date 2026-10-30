import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserWindow, screen } from 'electron';

import type { RemoteBotCore } from '../../core/host-api/remote.ts';
import type { BotHostEvent } from '../../core/types.ts';
import { applyWindowIdentity, type WindowIdentity } from './windowIdentity.ts';
import type { LanguageState } from '../../shared/language.ts';
import {
  DEFAULT_NOTE_SIZE,
  readShellState,
  startupConversations,
  writeShellState,
  type NoteLayer,
  type NoteViewState,
  type ShellState,
} from './viewState.ts';
import { guardNavigation } from './navigation.ts';
import type { DesktopHost } from './win32Desktop.ts';

/**
 * SPEC-001 FR-33 / FR-34: one frameless sticky-note window per conversation.
 * Closing a note hides it (the conversation and the bot keep running);
 * deleting a conversation and quitting the bot are separate actions.
 *
 * SPEC-002 FR-8: each note has a layer. A desktop or wallpaper note is a
 * child of Explorer's desktop window, which never takes the keyboard, so a
 * desktop note that gets focus is lifted to an ordinary window while it is
 * used and goes back when it loses focus (desktop-work-fleet ADR-030 projects
 * an operated scene to floating the same way). Explorer destroys its children
 * when it restarts; such notes are opened again in their layer.
 */

export interface NoteWindowsOptions {
  core: Pick<RemoteBotCore, 'openView' | 'closeView' | 'setViewFocused'>;
  botRoot: string;
  preloadPath: string;
  /** The built pages (`dist/renderer`, ADR-003). */
  rendererDir: string;
  iconPath: string;
  isQuitting(): boolean;
  /** Windows only; without it notes offer the normal and top layers. */
  desktop?: DesktopHost | null;
  log?(line: string): void;
  /** SPEC-008 FR-17: the AUMID of this bot's notes. */
  identity?: WindowIdentity;
  /** The bot's place among the hub's bots: a note never placed before opens a step further. */
  slot?: number;
}

const ATTACHED: readonly NoteLayer[] = ['desktop', 'wallpaper'];
const SETTLE_MS = 400;
const HEALTH_MS = 5_000;
const REOPEN_MS = 3_000;
const REOPEN_TRIES = 20;

function isAttachedLayer(layer: NoteLayer): layer is 'desktop' | 'wallpaper' {
  return ATTACHED.includes(layer);
}

function handleOf(window: BrowserWindow): number {
  const buffer = window.getNativeWindowHandle();
  return buffer.length >= 8 ? Number(buffer.readBigUInt64LE(0)) : buffer.readUInt32LE(0);
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
  private readonly loading = new Map<string, Promise<void>>();
  private state: ShellState;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Desktop or wallpaper notes taken out of their layer while the owner uses them. */
  private readonly lifted = new Set<string>();
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(options: NoteWindowsOptions) {
    this.options = options;
    this.state = readShellState(options.botRoot);
    if (options.desktop) {
      this.healthTimer = setInterval(() => this.checkDesktopHosts(), HEALTH_MS);
      this.healthTimer.unref?.();
    }
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  /** The layers this host can offer. */
  availableLayers(): NoteLayer[] {
    return this.options.desktop ? ['normal', 'top', 'desktop', 'wallpaper'] : ['normal', 'top'];
  }

  layerOf(conversationId: string): NoteLayer {
    return this.viewState(conversationId).layer;
  }

  layers(): Record<string, NoteLayer> {
    return Object.fromEntries(Object.entries(this.state.views).map(([id, view]) => [id, view.layer]));
  }

  get shellState(): ShellState {
    return this.state;
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

  flush(): void {
    for (const [id, window] of this.windows) this.rememberBounds(id, window);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    writeShellState(this.options.botRoot, this.state);
  }

  private rememberBounds(conversationId: string, window: BrowserWindow): void {
    if (window.isDestroyed() || window.isMinimized()) return;
    // Electron reports logical bounds even for Explorer-attached windows.
    // GetWindowRect includes invisible Windows resize borders and would shift
    // and grow the saved window at fractional display scaling.
    const bounds = window.getBounds();
    Object.assign(this.viewState(conversationId), bounds);
  }

  private viewState(conversationId: string): NoteViewState {
    let view = this.state.views[conversationId];
    if (!view) {
      view = { ...DEFAULT_NOTE_SIZE, layer: 'normal', alwaysOnTop: false, open: false };
      this.state.views[conversationId] = view;
    }
    return view;
  }

  listOpen(): string[] {
    return [...this.windows.entries()].filter(([, window]) => window.isVisible()).map(([id]) => id);
  }

  /** Conversations whose note was open when the shell last ran. */
  previouslyOpen(): string[] {
    return startupConversations(this.state);
  }

  /**
   * Shows a conversation's note. The owner opening a note (tray, settings,
   * the floating cat) is asking to use it, so a desktop or wallpaper note is
   * lifted and focused; `restore` (the shell starting, or Explorer coming
   * back) puts it straight into its layer without taking the focus.
   */
  async open(conversationId: string, options: { restore?: boolean } = {}): Promise<BrowserWindow> {
    const view = this.viewState(conversationId);
    const layered = isAttachedLayer(view.layer) && Boolean(this.options.desktop);
    const existing = this.windows.get(conversationId);
    if (existing && !existing.isDestroyed()) {
      // Startup may have selected this note before the owner opened/closed it.
      // Restoring must not override a newer action or take focus from its owner.
      if (options.restore) {
        await this.loading.get(conversationId);
        return existing;
      }
      view.open = true;
      this.persist();
      // A second launch can arrive before the first page has finished loading.
      // Do not expose that page early, or show it after a subsequent close.
      await this.loading.get(conversationId);
      if (!this.mayShow(conversationId, existing)) return existing;
      if (layered) {
        // Attached, or detached since it was hidden while lifted: either way lifted until it loses focus,
        // so the periodic host check does not put it back under the owner's cursor.
        existing.show();
        this.lift(conversationId, existing);
      } else {
        existing.show();
        existing.focus();
      }
      await this.options.core.openView(conversationId);
      return existing;
    }
    const slot = this.options.slot ?? 0;
    const area = slot > 0 ? screen.getPrimaryDisplay().workArea : null;
    const bounds = view.x !== undefined && view.y !== undefined
      ? clampToScreen({ x: view.x, y: view.y, width: view.width, height: view.height })
      : area
        ? clampToScreen({
          x: Math.round(area.x + (area.width - view.width) / 2 + slot * 40),
          y: Math.round(area.y + (area.height - view.height) / 2 + slot * 40),
          width: view.width,
          height: view.height,
        })
        : { width: view.width, height: view.height };
    const window = new BrowserWindow({
      ...bounds,
      minWidth: 260,
      minHeight: 240,
      frame: false,
      show: false,
      skipTaskbar: false,
      alwaysOnTop: view.layer === 'top',
      autoHideMenuBar: true,
      backgroundColor: '#fff8d6',
      title: 'Cats Bot',
      icon: this.options.iconPath,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    applyWindowIdentity(window, this.options.identity);
    guardNavigation(window.webContents);
    this.windows.set(conversationId, window);
    const url = pathToFileURL(join(this.options.rendererDir, 'note.html'));
    url.searchParams.set('conversation', conversationId);
    window.on('close', (event) => {
      if (this.options.isQuitting()) return;
      event.preventDefault();
      this.rememberBounds(conversationId, window);
      window.hide();
      view.open = false;
      this.persist();
      void Promise.resolve(this.options.core.closeView(conversationId)).catch(() => undefined);
    });
    window.on('closed', () => {
      if (this.windows.get(conversationId) === window) this.windows.delete(conversationId);
      this.lifted.delete(conversationId);
      void Promise.resolve(this.options.core.setViewFocused(conversationId, false)).catch(() => undefined);
      // Not closed by us: Explorer restarted and took its children down.
      if (!this.options.isQuitting() && view.open && isAttachedLayer(view.layer)) this.reopenLater(conversationId, REOPEN_TRIES);
    });
    window.webContents.on('focus', () => {
      if (this.mayShow(conversationId, window) && window.isVisible()
        && view.layer === 'desktop' && this.options.desktop?.isAttached(handleOf(window))) this.lift(conversationId, window);
    });
    // A note that is open but not in front (on the desktop, the wallpaper or behind other windows) has not read
    // a reply: unread counts follow focus, not whether the window exists.
    window.on('focus', () => {
      void Promise.resolve(this.options.core.setViewFocused(conversationId, true)).catch(() => undefined);
    });
    window.on('blur', () => {
      void Promise.resolve(this.options.core.setViewFocused(conversationId, false)).catch(() => undefined);
      if (this.lifted.has(conversationId)) this.settle(conversationId, window);
    });
    const remember = () => {
      if (window.isDestroyed() || !window.isVisible()) return;
      this.rememberBounds(conversationId, window);
      this.persist();
    };
    window.on('move', remember);
    window.on('resize', remember);
    window.on('show', () => {
      view.open = true;
      this.rememberBounds(conversationId, window);
      this.persist();
    });
    view.open = true;
    const loading = window.loadURL(url.href);
    this.loading.set(conversationId, loading);
    try {
      await loading;
    } finally {
      if (this.loading.get(conversationId) === loading) this.loading.delete(conversationId);
    }
    if (!this.mayShow(conversationId, window)) return window;
    if (options.restore && view.x !== undefined && view.y !== undefined) window.setBounds(bounds);
    if (layered && options.restore) {
      window.showInactive();
      this.applyLayer(conversationId, window);
    } else if (layered) {
      // Never attached yet; it goes to its layer when it loses focus (settle).
      window.show();
      this.lift(conversationId, window);
    } else {
      if (options.restore) window.showInactive();
      else window.show();
      this.applyLayer(conversationId, window);
    }
    this.rememberBounds(conversationId, window);
    this.persist();
    await this.options.core.openView(conversationId);
    return window;
  }

  private mayShow(conversationId: string, window: BrowserWindow): boolean {
    return !this.options.isQuitting() && !window.isDestroyed()
      && this.windows.get(conversationId) === window && this.state.views[conversationId]?.open === true;
  }

  /** Puts a window where its note's layer says, unless the owner is using it right now. */
  private applyLayer(conversationId: string, window: BrowserWindow): void {
    const view = this.viewState(conversationId);
    const desktop = this.options.desktop;
    const handle = handleOf(window);
    if (isAttachedLayer(view.layer) && desktop) {
      window.setAlwaysOnTop(false);
      if (this.lifted.has(conversationId) || desktop.attachedLayer(handle) === view.layer) return;
      // attach() keeps the window's screen rectangle, also when it moves from one layer's host to the other.
      if (!desktop.attach(handle, view.layer)) {
        this.log(
          `conversation ${conversationId}: no Explorer ${view.layer} host; shown as an ordinary window until there is one`,
        );
      }
      return;
    }
    if (desktop?.isAttached(handle)) desktop.detach(handle);
    window.setAlwaysOnTop(view.layer === 'top', 'floating');
  }

  setLayer(conversationId: string, layer: NoteLayer): NoteLayer {
    if (!this.availableLayers().includes(layer)) throw new Error(`The ${layer} layer is not available here`);
    const view = this.viewState(conversationId);
    view.layer = layer;
    this.lifted.delete(conversationId);
    this.persist();
    const window = this.windows.get(conversationId);
    if (window && !window.isDestroyed()) {
      this.applyLayer(conversationId, window);
      window.webContents.send('note:layer', layer);
    }
    return layer;
  }

  /** Takes an attached note out of its layer so it can be typed into and dragged. */
  private lift(conversationId: string, window: BrowserWindow): void {
    const desktop = this.options.desktop;
    if (!desktop) return;
    const handle = handleOf(window);
    this.lifted.add(conversationId);
    desktop.detach(handle);
    desktop.bringToFront(handle);
    window.focus();
    window.webContents.focus();
    window.webContents.send('note:lifted');
  }

  /** Returns a lifted note to its layer once the owner has moved on to another window. */
  private settle(conversationId: string, window: BrowserWindow): void {
    setTimeout(() => {
      if (window.isDestroyed() || window.isFocused() || !this.lifted.has(conversationId)) return;
      this.lifted.delete(conversationId);
      if (window.isVisible()) this.applyLayer(conversationId, window);
    }, SETTLE_MS);
  }

  private reopenLater(conversationId: string, tries: number): void {
    const timer = setTimeout(() => {
      if (this.options.isQuitting() || this.windows.has(conversationId)) return;
      let view = this.state.views[conversationId];
      if (!view || !view.open) return;
      this.options.desktop?.refresh();
      void this.open(conversationId, { restore: true }).then(
        () =>
          this.log(
            `conversation ${conversationId}: reopened in the ${view.layer} layer after Explorer restarted`,
          ),
        () => {
          if (tries > 1) this.reopenLater(conversationId, tries - 1);
        },
      );
    }, REOPEN_MS);
    timer.unref?.();
  }

  /** Explorer can recreate its hosts without destroying our windows (a wallpaper change); attach again. */
  private checkDesktopHosts(): void {
    const desktop = this.options.desktop;
    if (!desktop) return;
    desktop.refresh();
    for (const [conversationId, window] of this.windows) {
      let view = this.state.views[conversationId];
      if (!view || window.isDestroyed() || !window.isVisible() || !isAttachedLayer(view.layer) || this.lifted.has(conversationId)) continue;
      const handle = handleOf(window);
      if (!desktop.isAttached(handle) || !desktop.hostAlive(handle)) {
        desktop.detach(handle);
        if (desktop.attach(handle, view.layer))
          this.log(`conversation ${conversationId}: attached to the ${view.layer} layer again`);
      }
    }
  }

  hide(conversationId: string): void {
    const window = this.windows.get(conversationId);
    if (window && !window.isDestroyed()) window.close();
  }

  /** Whether the note of a conversation is the window the owner is looking at. */
  isFocused(conversationId: string): boolean {
    const window = this.windows.get(conversationId);
    return (
      window !== undefined && !window.isDestroyed() && window.isVisible() && window.isFocused()
    );
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

  sendLanguage(state: LanguageState): void {
    for (const window of this.windows.values())
      if (!window.isDestroyed()) window.webContents.send('ui:languageChanged', state);
  }

  forget(conversationId: string): void {
    const window = this.windows.get(conversationId);
    if (window && !window.isDestroyed()) window.destroy();
    this.windows.delete(conversationId);
    delete this.state.views[conversationId];
    this.persist();
  }

  destroyAll(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.flush();
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
  }
}
