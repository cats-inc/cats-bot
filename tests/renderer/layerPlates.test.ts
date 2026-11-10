import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LAYER_PLATES, layerPlateStates } from '../../src/renderer/note/layerPlates.ts';

/** SPEC-002 FR-8: the note's layer button. */

test('the layer button fills the plate of the note layer, stacked back to front', () => {
  assert.deepEqual(LAYER_PLATES.map((plate) => plate.layer), ['top', 'desktop', 'wallpaper']);
  assert.deepEqual(layerPlateStates('top'), ['current', 'other', 'other']);
  assert.deepEqual(layerPlateStates('desktop'), ['other', 'current', 'other']);
  assert.deepEqual(layerPlateStates('wallpaper'), ['other', 'other', 'current']);
});

test('an ordinary window fills no plate: the top one is outlined, the two below it faint', () => {
  assert.deepEqual(layerPlateStates('normal'), ['outline', 'off', 'off']);
});
