import { join } from 'node:path';

import { readJsonFile, writeJsonAtomic } from '../../core/store/atomicFile.ts';

/**
 * SPEC-001 FR-33: a sticky note is a view of a conversation (position, size,
 * visibility, layer). The shell keeps this beside the bot's data, never in
 * the renderer, so reopening a note lands where it was.
 */

export interface NoteViewState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  alwaysOnTop: boolean;
  open: boolean;
}

/** SPEC-002 FR-7: the floating bot's window position (top-left) and visibility. */
export interface FloatingBotState {
  visible: boolean;
  x?: number;
  y?: number;
}

export interface ShellState {
  schemaVersion: 1;
  views: Record<string, NoteViewState>;
  openAtLogin: boolean;
  floatingBot: FloatingBotState;
}

export const DEFAULT_NOTE_SIZE = { width: 340, height: 460 };

export function shellStatePath(botRoot: string): string {
  return join(botRoot, 'shell-state.json');
}

export function readShellState(botRoot: string): ShellState {
  const read = readJsonFile<Partial<ShellState>>(shellStatePath(botRoot));
  const views: Record<string, NoteViewState> = {};
  if (read.ok && read.value && typeof read.value.views === 'object' && read.value.views) {
    for (const [id, raw] of Object.entries(read.value.views)) {
      if (!raw || typeof raw !== 'object') continue;
      views[id] = {
        ...(typeof raw.x === 'number' ? { x: raw.x } : {}),
        ...(typeof raw.y === 'number' ? { y: raw.y } : {}),
        width: typeof raw.width === 'number' && raw.width >= 200 ? raw.width : DEFAULT_NOTE_SIZE.width,
        height: typeof raw.height === 'number' && raw.height >= 200 ? raw.height : DEFAULT_NOTE_SIZE.height,
        alwaysOnTop: raw.alwaysOnTop === true,
        open: raw.open === true,
      };
    }
  }
  const floating = read.ok && read.value && typeof read.value.floatingBot === 'object' && read.value.floatingBot
    ? read.value.floatingBot
    : null;
  return {
    schemaVersion: 1,
    views,
    openAtLogin: read.ok && read.value?.openAtLogin === true,
    floatingBot: {
      // Shown unless the owner hid it.
      visible: floating?.visible !== false,
      ...(floating && Number.isFinite(floating.x) && Number.isFinite(floating.y) ? { x: floating.x, y: floating.y } : {}),
    },
  };
}

export function writeShellState(botRoot: string, state: ShellState): void {
  writeJsonAtomic(shellStatePath(botRoot), state);
}
