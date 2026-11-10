import type { NoteLayer } from '../bridge.ts';

/**
 * SPEC-002 FR-8: the note header's layer button draws three plates stacked
 * back to front: always on top, the desktop, the wallpaper. The plate of the
 * note's layer is filled. An ordinary window rests on none of them: its top
 * plate is a full-strength outline and the two below are faint.
 */
export const LAYER_PLATES = [
  { layer: 'top', path: 'M12 2.5 20 5.5 12 8.5 4 5.5Z' },
  { layer: 'desktop', path: 'M12 9 20 12 12 15 4 12Z' },
  { layer: 'wallpaper', path: 'M12 15.5 20 18.5 12 21.5 4 18.5Z' },
] as const;

export type PlateState = 'current' | 'other' | 'outline' | 'off';

/** How each plate of `LAYER_PLATES` is drawn for a note on `layer`. */
export function layerPlateStates(layer: NoteLayer): PlateState[] {
  if (layer === 'normal') return LAYER_PLATES.map((_, index) => (index === 0 ? 'outline' : 'off'));
  return LAYER_PLATES.map((plate) => (plate.layer === layer ? 'current' : 'other'));
}
