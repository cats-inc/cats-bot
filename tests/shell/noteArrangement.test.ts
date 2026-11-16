import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConversationRecord } from '../../src/core/types.ts';
import { FLOATING_CAT, FLOATING_SIZE, placeFloating } from '../../src/shell/electron/floatingPlacement.ts';
import {
  arrangementOrder,
  NOTE_TITLE_STEP,
  spreadNotes,
  stackNotes,
  type ArrangeableNote,
  type NoteArrangement,
} from '../../src/shell/electron/noteArrangement.ts';

/** SPEC-002 FR-7b: where Stack and Spread put a Cat's open notes. */

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const DISPLAY = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: AREA };

/** The cat where a first launch puts it: bottom-right of the work area. */
function catAt(position = placeFloating({}, [DISPLAY], DISPLAY, FLOATING_SIZE)) {
  return { ...FLOATING_CAT, x: position.x + FLOATING_CAT.x, y: position.y + FLOATING_CAT.y };
}

function note(id: string, width = 340, height = 460, top = false): ArrangeableNote {
  return { id, width, height, top };
}

function record(id: string, role: 'home' | 'note', at: string | null, extra: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    schemaVersion: 1, id, role, title: id, titleSource: 'owner',
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    attachment: { state: 'none', sessionId: null, providerSessionId: null, provider: null, model: null, configRevision: null, updatedAt: '2026-11-01T00:00:00.000Z' },
    unreadCount: 0, lastOwnerMessageAt: at, lastBotMessageAt: null, checkpoint: null, contactOf: null, contactName: null,
    ...extra,
  };
}

function inside(plan: NoteArrangement, area = AREA) {
  for (const placed of plan.placed) {
    assert.ok(placed.x >= area.x && placed.y >= area.y, `${placed.id} starts inside`);
    assert.ok(placed.x + placed.width <= area.x + area.width && placed.y + placed.height <= area.y + area.height, `${placed.id} ends inside`);
  }
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('the direct message comes first, then the latest notes, contact notes among them', () => {
  const conversations = [
    record('old', 'note', '2026-11-02T00:00:00.000Z'),
    record('home', 'home', null),
    record('contact', 'note', '2026-11-04T00:00:00.000Z', { contactOf: 'ada', contactName: 'Ada' }),
    record('new', 'note', '2026-11-03T00:00:00.000Z'),
  ];
  assert.deepEqual(arrangementOrder(conversations, ['old', 'new', 'contact', 'home']), ['home', 'contact', 'new', 'old']);
  assert.deepEqual(arrangementOrder(conversations, ['gone', 'old']), ['old', 'gone'], 'a note the core no longer lists goes last');
});

test('a stack stands beside the cat with every title bar showing and the direct message whole in front', () => {
  const cat = catAt();
  const plan = stackNotes([note('home'), note('a', 360, 480), note('b')], cat, AREA);
  assert.deepEqual(plan.raise, ['b', 'a', 'home'], 'raised back to front');
  assert.deepEqual(plan.placed.map(({ id, width, height }) => ({ id, width, height })),
    [{ id: 'b', width: 340, height: 460 }, { id: 'a', width: 360, height: 480 }, { id: 'home', width: 340, height: 460 }],
    'no note is resized');
  for (const [index, placed] of plan.placed.entries()) {
    assert.equal(placed.x + placed.width, cat.x - 14, `${placed.id} lines up left of the cat`);
    if (index > 0) assert.equal(placed.y - plan.placed[index - 1]!.y, NOTE_TITLE_STEP, `${placed.id} leaves the title above it showing`);
  }
  inside(plan);
});

test('a stack opens to the right of a cat at the left edge, and keeps top-layer notes in front', () => {
  const cat = catAt({ x: -FLOATING_CAT.x + 20, y: 300 });
  const plan = stackNotes([note('home'), note('pinned', 340, 460, true), note('b')], cat, AREA);
  assert.deepEqual(plan.raise, ['b', 'home', 'pinned'], 'a top-layer note is in front whatever is raised later');
  for (const placed of plan.placed) assert.equal(placed.x, cat.x + cat.width + 14);
  assert.deepEqual(plan.placed.map((placed) => placed.y), [...plan.placed.map((placed) => placed.y)].sort((a, b) => a - b),
    'each note further front sits lower, so the titles behind it show');
  inside(plan);
});

test('a stack too tall for the screen closes up but stays on it', () => {
  const notes = Array.from({ length: 20 }, (_, index) => note(`n${index}`));
  const plan = stackNotes(notes, catAt(), AREA);
  const steps = plan.placed.slice(1).map((placed, index) => placed.y - plan.placed[index]!.y);
  assert.ok(steps.every((step) => step > 0 && step < NOTE_TITLE_STEP), JSON.stringify(steps));
  inside(plan);
});

test('spread lays notes side by side on the display without overlap, the direct message first', () => {
  const plan = spreadNotes([note('home'), note('a', 400, 520), note('b')], AREA);
  assert.deepEqual(plan.placed.map((placed) => placed.id), ['home', 'a', 'b']);
  assert.ok(plan.placed[0]!.x < plan.placed[1]!.x && plan.placed[1]!.x < plan.placed[2]!.x, 'one row, in order');
  for (const [index, a] of plan.placed.entries()) {
    for (const b of plan.placed.slice(index + 1)) assert.equal(overlaps(a, b), false, `${a.id} and ${b.id}`);
  }
  const left = plan.placed[0]!.x;
  const right = AREA.width - (plan.placed[2]!.x + plan.placed[2]!.width);
  assert.ok(Math.abs(left - right) <= 1, 'the row is centred');
  inside(plan);
});

test('spread wraps into rows, and rows that do not fit overlap evenly with their titles showing', () => {
  const fits = spreadNotes(Array.from({ length: 6 }, (_, index) => note(`n${index}`, 600, 400)), AREA);
  assert.equal(new Set(fits.placed.map((placed) => placed.y)).size, 2, 'three to a row');
  for (const [index, a] of fits.placed.entries()) {
    for (const b of fits.placed.slice(index + 1)) assert.equal(overlaps(a, b), false, `${a.id} and ${b.id}`);
  }
  inside(fits);
  const crowded = spreadNotes(Array.from({ length: 12 }, (_, index) => note(`n${index}`, 600, 500)), AREA);
  const rows = [...new Set(crowded.placed.map((placed) => placed.y))];
  assert.equal(rows.length, 4);
  assert.ok(rows.slice(1).every((y, index) => y - rows[index]! >= NOTE_TITLE_STEP), JSON.stringify(rows));
  assert.deepEqual(crowded.raise, crowded.placed.map((placed) => placed.id), 'a later row is in front');
  inside(crowded);
});

test('nothing to arrange plans nothing', () => {
  assert.deepEqual(stackNotes([], catAt(), AREA), { placed: [], raise: [] });
  assert.deepEqual(spreadNotes([], AREA), { placed: [], raise: [] });
});
