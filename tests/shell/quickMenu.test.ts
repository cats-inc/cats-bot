import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConversationRecord } from '../../src/core/types.ts';
import { FLOATING_CAT, FLOATING_SIZE, placeFloating } from '../../src/shell/electron/floatingPlacement.ts';
import { FLOATING_HEAD, noteActivity, QUICK_MENU_ITEM, quickMenuItems, quickMenuLayout } from '../../src/shell/electron/quickMenu.ts';

function conversation(id: string, role: 'home' | 'note', changes: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    schemaVersion: 1,
    id,
    role,
    title: id,
    titleSource: 'owner',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    attachment: { state: 'none', sessionId: null, providerSessionId: null, provider: null, model: null, configRevision: null, updatedAt: '2026-11-01T10:00:00.000Z' },
    unreadCount: 0,
    lastOwnerMessageAt: null,
    lastBotMessageAt: null,
    checkpoint: null,
    contactOf: null,
    contactName: null,
    ...changes,
  };
}

const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T09:00:00.000Z`;

test('the quick menu offers the direct message, then the four notes with the latest messages (SPEC-002 FR-7a)', () => {
  const items = quickMenuItems([
    conversation('n-old', 'note', { lastOwnerMessageAt: at(2) }),
    conversation('n-bot', 'note', { lastBotMessageAt: at(9), lastOwnerMessageAt: at(3) }),
    conversation('home', 'home', { title: 'Home', unreadCount: 2 }),
    conversation('n-new', 'note', { lastOwnerMessageAt: at(8) }),
    // Renamed or read today, but its last message is the oldest: updatedAt does not count.
    conversation('n-touched', 'note', { lastOwnerMessageAt: at(1), updatedAt: at(15) }),
    conversation('n-unread', 'note', { lastBotMessageAt: at(7), unreadCount: 3 }),
    conversation('contact', 'note', { lastBotMessageAt: at(14), contactOf: 'ada', contactName: 'Ada' }),
  ], 'en');
  assert.deepEqual(items.map((item) => [item.kind, item.conversationId, item.label, item.unread]), [
    ['home', 'home', 'Direct message', 2],
    ['note', 'n-bot', 'n-bot', 0],
    ['note', 'n-new', 'n-new', 0],
    ['note', 'n-unread', 'n-unread', 3],
    ['note', 'n-old', 'n-old', 0],
  ]);
});

test('fewer than four notes leaves one New conversation item, and the direct message keeps an owner name', () => {
  const items = quickMenuItems([
    conversation('home', 'home', { title: 'Desk' }),
    conversation('only', 'note', { title: 'Trip plans' }),
    conversation('contact', 'note', { contactOf: 'ada' }),
  ], 'zh-TW');
  assert.deepEqual(items.map((item) => [item.kind, item.conversationId, item.label]), [
    ['home', 'home', 'Desk'],
    ['note', 'only', 'Trip plans'],
    ['new', null, '新增對話'],
  ]);
  assert.deepEqual(quickMenuItems([], 'zh-TW').map((item) => item.label), ['私訊', '新增對話']);
});

test('a note with no messages counts from when it was made', () => {
  assert.equal(noteActivity(conversation('a', 'note')), Date.parse('2026-11-01T10:00:00.000Z'));
  assert.equal(noteActivity(conversation('a', 'note', { lastOwnerMessageAt: at(3), lastBotMessageAt: at(4) })), Date.parse(at(4)));
});

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const head = (floating: { x: number; y: number }) => ({ x: floating.x + FLOATING_HEAD.x, y: floating.y + FLOATING_HEAD.y });
const inside = (rect: { x: number; y: number; width: number; height: number }, outer: typeof area) =>
  rect.x >= outer.x && rect.y >= outer.y && rect.x + rect.width <= outer.x + outer.width && rect.y + rect.height <= outer.y + outer.height;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('the menu opens beside a cat in its default corner, inside the work area and clear of the cat (ADR-027)', () => {
  const floating = placeFloating({}, [{ bounds: area, workArea: area }], { bounds: area, workArea: area });
  const layout = quickMenuLayout(floating, area, 5);
  const cat = { x: floating.x + FLOATING_CAT.x, y: floating.y + FLOATING_CAT.y, width: FLOATING_CAT.width, height: FLOATING_CAT.height };
  assert.equal(layout.side, 'left');
  assert.ok(inside(layout.bounds, area), JSON.stringify(layout.bounds));
  assert.ok(!overlaps(layout.bounds, cat), 'the menu window leaves the cat to be clicked');
  assert.equal(layout.items.length, 5);
  const screenItems = layout.items.map((item) => ({ x: layout.bounds.x + item.x, y: layout.bounds.y + item.y, ...QUICK_MENU_ITEM }));
  for (const [index, item] of screenItems.entries()) {
    assert.ok(inside(item, area));
    if (index > 0) assert.ok(item.y >= screenItems[index - 1]!.y + QUICK_MENU_ITEM.height, 'items do not overlap');
  }
  // An arc round the head: the middle item stands out furthest from the cat.
  assert.ok(screenItems[2]!.x < screenItems[0]!.x && screenItems[2]!.x < screenItems[4]!.x);
  assert.deepEqual({ x: layout.bounds.x + layout.head.x, y: layout.bounds.y + layout.head.y }, head(floating));
});

test('a cat at the left edge opens its menu to the right, and one at the top keeps it on the screen', () => {
  const topLeft = { x: -FLOATING_CAT.x + 4, y: -FLOATING_CAT.y + 4 };
  const layout = quickMenuLayout(topLeft, area, 5);
  assert.equal(layout.side, 'right');
  assert.ok(inside(layout.bounds, area), JSON.stringify(layout.bounds));
  assert.ok(layout.bounds.x >= topLeft.x + FLOATING_CAT.x + FLOATING_CAT.width);
});

test('a cat at the bottom of the work area lifts the column above the taskbar; menus follow a second display', () => {
  const second = { x: 1920, y: -200, width: 1280, height: 984 };
  const floating = { x: second.x + 600, y: second.y + second.height - FLOATING_SIZE.height };
  const layout = quickMenuLayout(floating, second, 3);
  assert.ok(inside(layout.bounds, second), JSON.stringify(layout.bounds));
  assert.equal(layout.bounds.y + layout.bounds.height, second.y + second.height);
});

test('a work area too narrow for the column beside the cat still keeps every item on it', () => {
  const narrow = { x: 0, y: 0, width: 320, height: 600 };
  const layout = quickMenuLayout({ x: 0, y: 200 }, narrow, 5);
  for (const item of layout.items) {
    assert.ok(inside({ x: layout.bounds.x + item.x, y: layout.bounds.y + item.y, ...QUICK_MENU_ITEM }, narrow));
  }
});
