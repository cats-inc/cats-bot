import type { BrowserWindow, Rectangle } from 'electron';

import { readJsonFile, writeJsonAtomic } from '../../core/store/atomicFile.ts';

export interface PageWindowPlacement {
  file: string;
  key: string;
  log?(message: string): void;
}

interface Placement extends Rectangle { maximized: boolean; fullScreen: boolean }
interface Placements { schemaVersion: 1; windows: Record<string, Placement> }

function read(file: string): Placements {
  const result = readJsonFile<Placements>(file);
  if (!result.ok) {
    if (result.reason === 'missing') return { schemaVersion: 1, windows: {} };
    throw new Error('Window positions could not be read; the original file was kept.');
  }
  if (result.value?.schemaVersion !== 1 || !result.value.windows || typeof result.value.windows !== 'object'
    || Array.isArray(result.value.windows)) throw new Error('Unsupported window positions; the original file was kept.');
  return result.value;
}

export function readPageWindowPlacement(options: PageWindowPlacement): Placement | null {
  try {
    const value = read(options.file).windows[options.key];
    if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite)
      || value.width <= 0 || value.height <= 0) return null;
    return { x: value.x, y: value.y, width: value.width, height: value.height,
      maximized: value.maximized === true, fullScreen: value.fullScreen === true };
  } catch (error) {
    options.log?.(String(error));
    return null;
  }
}

/** Electron's display matching chooses the nearest remaining monitor after unplugging one. */
export function fitPageWindow(bounds: Rectangle, area: Rectangle, minimum: { width: number; height: number }): Rectangle {
  const width = Math.min(area.width, Math.max(minimum.width, bounds.width));
  const height = Math.min(area.height, Math.max(minimum.height, bounds.height));
  return { width, height,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) };
}

/** Save during use too: Windows shutdown can bypass Electron's quit handlers. */
export function rememberPageWindow(window: BrowserWindow, options: PageWindowPlacement): void {
  const events: NodeJS.EventEmitter = window;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: Placement | null = null;
  const capture = () => {
    if (window.isDestroyed() || window.isMinimized()) return;
    latest = { ...(window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds()),
      maximized: window.isMaximized(), fullScreen: window.isFullScreen() };
  };
  const save = () => {
    clearTimeout(timer);
    if (!latest) return;
    try {
      const state = read(options.file);
      state.windows[options.key] = latest;
      writeJsonAtomic(options.file, state);
    } catch (error) { options.log?.(String(error)); }
  };
  for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    events.on(event, () => {
      capture();
      clearTimeout(timer);
      timer = setTimeout(save, 200);
    });
  }
  window.on('close', () => { capture(); save(); });
  // destroy() does not emit close; the last frame is still durable.
  window.on('closed', save);
}
