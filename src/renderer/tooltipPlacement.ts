/** Where the note's own tooltips (tooltip.ts) go; no DOM here, so it is tested in Node. */

export interface TooltipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Room kept between the tooltip and the window's edges, and between the tooltip and what it explains. */
export const TOOLTIP_EDGE_PX = 4;
export const TOOLTIP_GAP_PX = 6;
/**
 * Where a tooltip of `size` goes for `anchor`, in a window of `viewport`: above it, or below when there is no
 * room above (the header's buttons), centered on it but kept inside a narrow note on both sides.
 */
export function placeTooltip(
  anchor: TooltipRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const above = anchor.top - TOOLTIP_GAP_PX - size.height;
  const below = anchor.top + anchor.height + TOOLTIP_GAP_PX;
  const fitsAbove = above >= TOOLTIP_EDGE_PX;
  const fitsBelow = below + size.height <= viewport.height - TOOLTIP_EDGE_PX;
  const top = fitsAbove || (!fitsBelow && anchor.top > viewport.height - anchor.top - anchor.height) ? above : below;
  const centered = anchor.left + anchor.width / 2 - size.width / 2;
  const maxLeft = viewport.width - TOOLTIP_EDGE_PX - size.width;
  const left = Math.max(TOOLTIP_EDGE_PX, Math.min(centered, maxLeft));
  return { left: Math.round(left), top: Math.round(Math.max(TOOLTIP_EDGE_PX, top)) };
}
