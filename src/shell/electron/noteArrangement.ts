import type { ConversationRecord } from '../../core/types.ts';
import { noteActivity } from './quickMenu.ts';

/**
 * SPEC-002 FR-7b: arranging one Cat's open notes from its menu, as plain data
 * so it can be tested without Electron. Stack piles them beside the Cat with
 * every title bar showing; Spread lays them side by side on the Cat's display.
 * Neither resizes a note.
 */

type Rect = { x: number; y: number; width: number; height: number };

export type ArrangeKind = 'stack' | 'spread';

export interface ArrangeableNote {
  id: string;
  width: number;
  height: number;
  /** On the top layer: in front of every normal-layer note, whatever order they are raised in. */
  top: boolean;
}

export interface NoteArrangement {
  /** Where each note goes, in screen coordinates, at its own size. */
  placed: Array<Rect & { id: string }>;
  /** The notes from back to front, the order to raise them in. */
  raise: string[];
}

/** How far a note in a stack sits below the one behind it: a note's title bar (note.css). */
export const NOTE_TITLE_STEP = 36;
/** A stack too tall for the screen closes up, down to this much of each title bar. */
const MIN_STEP = 8;
/** Between spread notes, and between their rows. */
const GAP = 12;
/** Notes keep this far inside the work area. */
const EDGE = 8;
/** Between the cat's side and a stack, as for the quick menu. */
const CAT_CLEARANCE = 14;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * The direct message first, then the notes with the latest messages: the
 * quick menu's order (SPEC-002 FR-7a), with contact notes among the rest.
 */
export function arrangementOrder(conversations: readonly ConversationRecord[], ids: readonly string[]): string[] {
  const records = new Map(conversations.map((record) => [record.id, record]));
  const home = (id: string) => (records.get(id)?.role ?? (id === 'home' ? 'home' : 'note')) === 'home' ? 0 : 1;
  const activity = (id: string) => {
    const record = records.get(id);
    return record ? noteActivity(record) : -1;
  };
  return [...ids].sort((a, b) => home(a) - home(b) || activity(b) - activity(a) || a.localeCompare(b));
}

/** First is the front: top-layer notes stay in front of the others, so they are raised last. */
function backToFront(notes: readonly ArrangeableNote[]): ArrangeableNote[] {
  return [...notes.filter((note) => !note.top).reverse(), ...notes.filter((note) => note.top).reverse()];
}

/**
 * A stack beside the cat (left when it fits, as the cat usually sits
 * bottom-right), centred on it but kept inside the work area. `notes` comes
 * front first; each note behind sits one title bar higher, so every title
 * shows and the front note shows whole.
 */
export function stackNotes(notes: readonly ArrangeableNote[], cat: Rect, workArea: Rect): NoteArrangement {
  if (notes.length === 0) return { placed: [], raise: [] };
  const order = backToFront(notes);
  const room = workArea.height - 2 * EDGE;
  let step = NOTE_TITLE_STEP;
  order.forEach((note, index) => {
    if (index > 0) step = Math.min(step, Math.floor((room - note.height) / index));
  });
  step = Math.max(MIN_STEP, step);
  const height = Math.max(...order.map((note, index) => index * step + note.height));
  const width = Math.max(...order.map((note) => note.width));
  const catRight = cat.x + cat.width;
  const roomLeft = cat.x - CAT_CLEARANCE - (workArea.x + EDGE);
  const roomRight = workArea.x + workArea.width - EDGE - (catRight + CAT_CLEARANCE);
  const side = roomLeft >= width || roomLeft >= roomRight ? 'left' : 'right';
  const top = clamp(cat.y + cat.height / 2 - height / 2, workArea.y + EDGE, workArea.y + workArea.height - EDGE - height);
  const placed = order.map((note, index) => ({
    id: note.id,
    x: Math.round(clamp(
      side === 'left' ? cat.x - CAT_CLEARANCE - note.width : catRight + CAT_CLEARANCE,
      workArea.x + EDGE,
      workArea.x + workArea.width - EDGE - note.width,
    )),
    y: Math.round(clamp(top + index * step, workArea.y + EDGE, workArea.y + workArea.height - EDGE - note.height)),
    width: note.width,
    height: note.height,
  }));
  return { placed, raise: order.map((note) => note.id) };
}

/**
 * Rows across the work area in `notes` order, centred and apart. When the rows
 * do not fit, they overlap evenly instead of shrinking a note: a later row in
 * front, each row's title bars still showing.
 */
export function spreadNotes(notes: readonly ArrangeableNote[], workArea: Rect): NoteArrangement {
  if (notes.length === 0) return { placed: [], raise: [] };
  const roomWidth = workArea.width - 2 * EDGE;
  const roomHeight = workArea.height - 2 * EDGE;
  const rows: ArrangeableNote[][] = [];
  let used = 0;
  for (const note of notes) {
    const row = rows.at(-1);
    if (row && used + GAP + note.width <= roomWidth) {
      row.push(note);
      used += GAP + note.width;
    } else {
      rows.push([note]);
      used = note.width;
    }
  }
  const heights = rows.map((row) => Math.max(...row.map((note) => note.height)));
  const total = heights.reduce((sum, height) => sum + height, 0) + GAP * (rows.length - 1);
  let tops: number[];
  if (total <= roomHeight) {
    let y = workArea.y + EDGE + (roomHeight - total) / 2;
    tops = heights.map((height) => {
      const top = y;
      y += height + GAP;
      return top;
    });
  } else {
    const step = Math.max(NOTE_TITLE_STEP, (roomHeight - heights.at(-1)!) / Math.max(1, rows.length - 1));
    tops = rows.map((_, index) => workArea.y + EDGE + index * step);
  }
  const placed = rows.flatMap((row, index) => {
    const width = row.reduce((sum, note) => sum + note.width, 0) + GAP * (row.length - 1);
    let x = workArea.x + EDGE + Math.max(0, (roomWidth - width) / 2);
    return row.map((note) => {
      const at = {
        id: note.id,
        x: Math.round(clamp(x, workArea.x + EDGE, workArea.x + workArea.width - EDGE - note.width)),
        y: Math.round(clamp(tops[index]!, workArea.y + EDGE, workArea.y + workArea.height - EDGE - note.height)),
        width: note.width,
        height: note.height,
      };
      x += note.width + GAP;
      return at;
    });
  });
  return { placed, raise: notes.map((note) => note.id) };
}
