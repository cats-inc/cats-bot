import { EventEmitter } from 'node:events';

/** A controllable page load; lifecycle tests use the real NoteWindows manager. */
export class BrowserWindow extends EventEmitter {
  static instances: BrowserWindow[] = [];
  readonly webContents = Object.assign(new EventEmitter(), {
    id: BrowserWindow.instances.length + 1,
    setWindowOpenHandler() {},
    send() {},
    focus() {},
  });
  private visible = false;
  private destroyed = false;
  private finishLoad: (() => void) | undefined;
  private readonly bounds: { x: number; y: number; width: number; height: number };

  constructor(options: { x?: number; y?: number; width: number; height: number }) {
    super();
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height };
    BrowserWindow.instances.push(this);
  }

  loadURL(): Promise<void> {
    return new Promise(resolve => { this.finishLoad = resolve; });
  }
  loaded(): void { this.finishLoad?.(); }
  isVisible(): boolean { return this.visible; }
  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return false; }
  isFocused(): boolean { return false; }
  getBounds() { return this.bounds; }
  setBounds(bounds: typeof this.bounds): void { Object.assign(this.bounds, bounds); }
  getNativeWindowHandle(): Buffer { return Buffer.alloc(8); }
  setAlwaysOnTop(): void {}
  focus(): void {}
  show(): void { this.visible = true; this.emit('show'); }
  showInactive(): void { this.show(); }
  hide(): void { this.visible = false; this.emit('hide'); }
  close(): void {
    let prevented = false;
    this.emit('close', { preventDefault() { prevented = true; } });
    if (!prevented) this.destroy();
  }
  destroy(): void { this.destroyed = true; this.visible = false; this.emit('closed'); }
}

export const screen = {
  getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
};
export const shell = { openExternal: async () => {} };
