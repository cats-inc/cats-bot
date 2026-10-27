/**
 * SPEC-002 FR-7: the Electron-free parts of the floating bot, so they can be
 * tested without a window: where it appears and what its bubble says.
 */

export const FLOATING_SIZE = { width: 300, height: 230 };

interface WorkArea {
  workArea: { x: number; y: number; width: number; height: number };
}

/** Keeps a remembered position on a display that still exists; otherwise bottom-right of the primary one. */
export function placeFloating(
  saved: { x?: number; y?: number },
  displays: WorkArea[],
  primary: WorkArea,
  size = FLOATING_SIZE,
): { x: number; y: number } {
  if (saved.x !== undefined && saved.y !== undefined) {
    const { x, y } = saved;
    const visible = displays.some(({ workArea }) => x + size.width > workArea.x + 40 && x < workArea.x + workArea.width - 40
      && y + size.height > workArea.y + 40 && y < workArea.y + workArea.height - 40);
    if (visible) return { x, y };
  }
  const area = primary.workArea;
  return { x: area.x + area.width - size.width - 16, y: area.y + area.height - size.height - 16 };
}

/** A reply as one short line of plain text, for the bubble. */
export function bubbleText(text: string, limit = 160): string {
  const plain = text.replace(/```[\s\S]*?```/gu, ' ').replace(/[*_`#>]+/gu, '').replace(/\s+/gu, ' ').trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}
