import { BrowserWindow, screen } from 'electron';

import type { BotHostEvent } from '../../core/types.ts';
import { bubbleText, FLOATING_CAT, FLOATING_SIZE, floatingInputRegions, placeFloating } from './floatingPlacement.ts';
import { guardNavigation } from './navigation.ts';
import { pageUrl, type PageWindowOptions } from './settingsWindow.ts';
import { applyWindowIdentity } from './windowIdentity.ts';
import type { FloatingBotState } from './viewState.ts';

/**
 * SPEC-002 FR-7 / ADR-002 §4: the floating bot. One transparent, frameless,
 * topmost window that never takes the taskbar or the focus. It ignores the
 * mouse (forwarding moves, so the page still sees hover) except while the
 * pointer is over the cat or its bubble, which the page reports.
 */

export interface FloatingBubble {
  conversationId: string;
  from: string;
  text: string;
}

export interface FloatingBotOptions extends PageWindowOptions {
  state(): FloatingBotState;
  persist(): void;
  /** SPEC-008 FR-17: the bot's place among the hub's bots, for a cat that was never moved. */
  slot?: number;
}

export class FloatingBot {
  private readonly options: FloatingBotOptions;
  private window: BrowserWindow | null = null;
  private watchingDisplays = false;

  constructor(options: FloatingBotOptions) {
    this.options = options;
  }

  /** A display removed, added or rescaled can leave the cat off every screen; bring it back. */
  private readonly keepReachable = (): void => {
    const window = this.browserWindow;
    if (!window) return;
    const [x = 0, y = 0] = window.getPosition();
    const next = placeFloating({ x, y }, screen.getAllDisplays(), screen.getPrimaryDisplay());
    if (next.x === x && next.y === y) return;
    this.moveTo(next.x, next.y);
    this.remember();
  };

  private watchDisplays(watch: boolean): void {
    if (watch === this.watchingDisplays) return;
    this.watchingDisplays = watch;
    if (watch) {
      screen.on('display-added', this.keepReachable);
      screen.on('display-removed', this.keepReachable);
      screen.on('display-metrics-changed', this.keepReachable);
    } else {
      screen.removeListener('display-added', this.keepReachable);
      screen.removeListener('display-removed', this.keepReachable);
      screen.removeListener('display-metrics-changed', this.keepReachable);
    }
  }

  get visible(): boolean {
    return this.browserWindow?.isVisible() ?? false;
  }

  get browserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  owns(webContentsId: number): boolean {
    return this.browserWindow?.webContents.id === webContentsId;
  }

  async show(): Promise<void> {
    const state = this.options.state();
    state.visible = true;
    this.options.persist();
    const existing = this.browserWindow;
    if (existing) {
      existing.showInactive();
      return;
    }
    const position = placeFloating(state, screen.getAllDisplays(), screen.getPrimaryDisplay(), undefined, this.options.slot ?? 0);
    const window = new BrowserWindow({
      ...position,
      ...FLOATING_SIZE,
      transparent: true,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      title: 'Cats Bot',
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
    applyWindowIdentity(window, this.options.identity);
    guardNavigation(window.webContents);
    // Above ordinary topmost windows, like a desktop pet.
    window.setAlwaysOnTop(true, 'screen-saver');
    const resetInput = () => {
      if (process.platform === 'linux') {
        // Linux cannot forward mouse moves through an ignored window. Keep
        // the visible regions interactive and let X11 pass the rest through.
        window.setIgnoreMouseEvents(false);
        window.setShape([FLOATING_CAT]);
      } else window.setIgnoreMouseEvents(true, { forward: true });
    };
    resetInput();
    // Forwarded moves go to the page's own child window, which a load replaces.
    window.webContents.on('did-finish-load', resetInput);
    window.on('move', () => this.remember());
    window.on('closed', () => {
      if (this.window === window) this.window = null;
      this.watchDisplays(false);
    });
    this.watchDisplays(true);
    await window.loadURL(pageUrl(this.options.rendererDir, 'floating.html'));
    // The owner may hide the avatar while its renderer is still loading.
    if (this.options.state().visible) window.showInactive();
    this.remember();
  }

  hide(): void {
    const state = this.options.state();
    state.visible = false;
    this.options.persist();
    this.browserWindow?.hide();
  }

  setInteractive(interactive: boolean): void {
    if (process.platform === 'linux') return;
    const window = this.browserWindow;
    if (!window) return;
    if (interactive) window.setIgnoreMouseEvents(false);
    else window.setIgnoreMouseEvents(true, { forward: true });
  }

  setInputRegions(value: unknown): void {
    if (process.platform !== 'linux') return;
    const regions = floatingInputRegions(value);
    if (regions) this.browserWindow?.setShape(regions);
  }

  moveTo(x: number, y: number): void {
    const window = this.browserWindow;
    if (!window || !Number.isFinite(x) || !Number.isFinite(y)) return;
    // setPosition at a fractional scale factor grows the window a pixel at a time; fixed bounds do not.
    window.setBounds({ x: Math.round(x), y: Math.round(y), ...FLOATING_SIZE });
    this.remember();
  }

  remember(): void {
    const window = this.browserWindow;
    if (!window) return;
    const [x, y] = window.getPosition();
    const state = this.options.state();
    state.x = x;
    state.y = y;
    this.options.persist();
  }

  bubble(message: FloatingBubble): void {
    const window = this.browserWindow;
    if (!window || !window.isVisible()) return;
    window.webContents.send('floating:bubble', { ...message, text: bubbleText(message.text) });
  }

  broadcast(event: BotHostEvent): void {
    this.browserWindow?.webContents.send('bot:event', event);
  }

  destroy(): void {
    this.watchDisplays(false);
    this.browserWindow?.destroy();
    this.window = null;
  }
}
