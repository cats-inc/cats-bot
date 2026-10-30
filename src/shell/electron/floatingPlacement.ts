/**
 * SPEC-002 FR-7: the Electron-free parts of the floating bot, so they can be
 * tested without a window: where it appears and what its bubble says.
 */

export const FLOATING_SIZE = { width: 300, height: 230 };

/**
 * Where the cat itself sits in the transparent window (floating.css: 96 px,
 * 12 px from the right, 8 px from the bottom); the rest is click-through.
 */
export const FLOATING_CAT = { x: 192, y: 126, width: 96, height: 96 };

/** How much of the cat must be on a screen to be grabbed. */
const REACHABLE = 48;

type Rect = { x: number; y: number; width: number; height: number };

interface Display {
  bounds: Rect;
  workArea: Rect;
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** Whether the cat at a window position can still be grabbed: half of it on one display at least. */
export function catReachable(position: { x: number; y: number }, displays: Display[]): boolean {
  const cat = { ...FLOATING_CAT, x: position.x + FLOATING_CAT.x, y: position.y + FLOATING_CAT.y };
  return displays.some(({ bounds }) => {
    const shared = overlap(cat, bounds);
    return shared.width >= REACHABLE && shared.height >= REACHABLE;
  });
}

/**
 * Keeps a remembered position while the cat on it can be grabbed; otherwise
 * bottom-right of the primary display. The window is larger than the cat and
 * mostly transparent, so the window touching a screen is not enough. A
 * further bot's cat (`slot` 1, 2, …) sits one cat to the left of the last.
 */
export function placeFloating(
  saved: { x?: number; y?: number },
  displays: Display[],
  primary: Display,
  size = FLOATING_SIZE,
  slot = 0,
): { x: number; y: number } {
  if (saved.x !== undefined && saved.y !== undefined && catReachable({ x: saved.x, y: saved.y }, displays)) {
    return { x: saved.x, y: saved.y };
  }
  const area = primary.workArea;
  const step = FLOATING_CAT.width + 16;
  return {
    x: Math.max(area.x, area.x + area.width - size.width - 16 - slot * step),
    y: area.y + area.height - size.height - 16,
  };
}

/** A reply as one short line of plain text, for the bubble. */
export function bubbleText(text: string, limit = 160): string {
  const plain = text.replace(/```[\s\S]*?```/gu, ' ').replace(/[*_`#>]+/gu, '').replace(/\s+/gu, ' ').trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}
