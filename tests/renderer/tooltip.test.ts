import assert from 'node:assert/strict';
import { test } from 'node:test';

import { placeTooltip, TOOLTIP_EDGE_PX, TOOLTIP_GAP_PX } from '../../src/renderer/tooltipPlacement.ts';

/** The note's own tooltips (tooltip.ts): where one goes in a narrow note. */

const note = { width: 340, height: 460 };

test('a tooltip sits centered above what it explains', () => {
  const send = { left: 300, top: 420, width: 28, height: 28 };
  const place = placeTooltip({ left: 150, top: 420, width: 28, height: 28 }, { width: 60, height: 20 }, note);
  assert.deepEqual(place, { left: 134, top: 420 - TOOLTIP_GAP_PX - 20 });
  // Near the right edge it stays inside the window.
  assert.equal(placeTooltip(send, { width: 120, height: 20 }, note).left, note.width - TOOLTIP_EDGE_PX - 120);
});

test('a header button\'s tooltip goes below it, kept inside the left edge', () => {
  const info = { left: 60, top: 9, width: 14, height: 14 };
  assert.deepEqual(placeTooltip(info, { width: 200, height: 32 }, note),
    { left: TOOLTIP_EDGE_PX, top: 9 + 14 + TOOLTIP_GAP_PX });
});

test('a tooltip wider than the note starts at its left edge', () => {
  assert.equal(placeTooltip({ left: 100, top: 200, width: 20, height: 20 }, { width: 400, height: 20 }, note).left,
    TOOLTIP_EDGE_PX);
});
