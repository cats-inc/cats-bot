import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrangeFloating, FLOATING_CAT } from '../../src/shell/electron/floatingPlacement.ts';

test('arrangement gathers cats in order at the selected work area, clear of the taskbar', () => {
  const area = { x: -1920, y: -120, width: 1920, height: 1040 };
  assert.deepEqual(arrangeFloating(0, area), []);
  const positions = arrangeFloating(5, area);
  assert.equal(positions.length, 5);
  for (const [index, position] of positions.entries()) {
    const cat = { x: position.x + FLOATING_CAT.x, y: position.y + FLOATING_CAT.y };
    assert.equal(cat.y + FLOATING_CAT.height, area.y + area.height - 16);
    assert.equal(cat.x + FLOATING_CAT.width, area.x + area.width - 16 - index * 112);
  }
});

test('cats wrap into separate rows on a narrow monitor with no overlap or offscreen cats', () => {
  const area = { x: 100, y: 200, width: 400, height: 600 };
  const cats = arrangeFloating(8, area).map(position => ({
    x: position.x + FLOATING_CAT.x, y: position.y + FLOATING_CAT.y,
  }));
  for (const [index, cat] of cats.entries()) {
    assert.ok(cat.x >= area.x && cat.x + FLOATING_CAT.width <= area.x + area.width);
    assert.ok(cat.y >= area.y && cat.y + FLOATING_CAT.height <= area.y + area.height);
    for (const other of cats.slice(index + 1)) {
      assert.ok(Math.abs(cat.x - other.x) >= FLOATING_CAT.width + 16
        || Math.abs(cat.y - other.y) >= FLOATING_CAT.height + 16);
    }
  }
  assert.equal(new Set(cats.map(cat => cat.y)).size, 3);
});

test('small work areas keep every avatar inside the visible area when rows must be packed', () => {
  const area = { x: -500, y: 0, width: 200, height: 200 };
  for (const position of arrangeFloating(5, area)) {
    assert.ok(position.x + FLOATING_CAT.x >= area.x);
    assert.ok(position.x + FLOATING_CAT.x + FLOATING_CAT.width <= area.x + area.width);
    assert.ok(position.y + FLOATING_CAT.y >= area.y);
    assert.ok(position.y + FLOATING_CAT.y + FLOATING_CAT.height <= area.y + area.height);
  }
});
