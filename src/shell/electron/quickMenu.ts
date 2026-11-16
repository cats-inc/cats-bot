import type { RemoteBotCore } from '../../core/host-api/remote.ts';
import type { ConversationRecord } from '../../core/types.ts';
import { translate, type Locale } from '../../shared/language.ts';
import type { QuickMenuItemKind } from '../../shared/quickMenu.ts';
import { FLOATING_CAT } from './floatingPlacement.ts';

/**
 * SPEC-002 FR-7a / ADR-027: the floating Cat's quick menu, as plain data so it
 * can be tested without Electron: what it offers and where it opens.
 */

/** The direct message, then at most this many recent notes. */
export const QUICK_MENU_NOTES = 4;

export interface QuickMenuItem {
  kind: QuickMenuItemKind;
  /** Null for `new`, which makes a note when chosen. */
  conversationId: string | null;
  label: string;
  unread: number;
  /** Something in it waits for the owner (`waitingConversations`). */
  waiting: boolean;
}

/** When a note last had a message from either side; one without any counts from when it was made. */
export function noteActivity(record: Pick<ConversationRecord, 'lastOwnerMessageAt' | 'lastBotMessageAt' | 'createdAt'>): number {
  const times = [record.lastOwnerMessageAt, record.lastBotMessageAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter(Number.isFinite);
  if (times.length > 0) return Math.max(...times);
  const created = Date.parse(record.createdAt);
  return Number.isFinite(created) ? created : 0;
}

/**
 * The direct message first, then the notes with something waiting for the
 * owner, then the notes with the latest messages; waiting notes are never
 * crowded out by newer ones. Contact notes (SPEC-012 FR-5) are left out.
 * Fewer than four notes leaves room for one New conversation item.
 */
export function quickMenuItems(
  conversations: readonly ConversationRecord[],
  locale: Locale,
  waiting: ReadonlySet<string> = new Set(),
): QuickMenuItem[] {
  const home = conversations.find((record) => record.role === 'home');
  const homeId = home?.id ?? 'home';
  const items: QuickMenuItem[] = [{
    kind: 'home',
    conversationId: homeId,
    label: home && !['Home', 'Direct message'].includes(home.title) ? home.title : translate(locale, 'Direct message'),
    unread: home?.unreadCount ?? 0,
    waiting: waiting.has(homeId),
  }];
  const notes = conversations
    .filter((record) => record.role === 'note' && !record.contactOf)
    .map((record) => ({ record, at: noteActivity(record), waiting: waiting.has(record.id) }))
    .sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.at - a.at || a.record.id.localeCompare(b.record.id))
    .slice(0, QUICK_MENU_NOTES);
  for (const { record, waiting: waits } of notes) {
    items.push({ kind: 'note', conversationId: record.id, label: record.title, unread: record.unreadCount, waiting: waits });
  }
  if (notes.length < QUICK_MENU_NOTES) {
    items.push({ kind: 'new', conversationId: null, label: translate(locale, 'New conversation'), unread: 0, waiting: false });
  }
  return items;
}

/** An item as a line of Linux's native quick menu: its unread count, then its waiting mark. */
export function quickMenuNativeLabel(item: QuickMenuItem, locale: Locale): string {
  return item.label + (item.unread ? ` (${item.unread})` : '') + (item.waiting ? ` · ${translate(locale, 'Needs you')}` : '');
}

/**
 * The conversations where something waits for the owner: a question or an
 * approval the bot asked (`awaiting_owner`), a provider request in the running
 * turn, or a desktop-control grant request. Two light reads, read together;
 * each conversation's grant state is read only when a grant request waits.
 */
export async function waitingConversations(
  core: Pick<RemoteBotCore, 'status' | 'desktopControlState'>,
): Promise<Set<string>> {
  const [status, desktop] = await Promise.all([core.status(), core.desktopControlState()]);
  // A core started before this field existed (the Hub can attach to one still running) names none.
  const waiting = new Set<string>(status.awaitingOwnerConversations ?? []);
  if (status.pendingInteractions > 0 && status.queue.running) waiting.add(status.queue.running.conversationId);
  if (desktop.pendingRequests > 0) {
    await Promise.all(desktop.conversations.map((conversationId) =>
      Promise.resolve(core.desktopControlState(conversationId)).then((one) => {
        if (one.conversation?.pendingRequests.length) waiting.add(conversationId);
      }, () => undefined)));
  }
  return waiting;
}

type Rect = { x: number; y: number; width: number; height: number };

/** One item: a pill wide enough for a note title of a few words, which the page cuts short. */
export const QUICK_MENU_ITEM = { width: 208, height: 34 };
const ITEM_GAP = 8;
/** The face's centre in the floating window: every look draws it at (64, 72) of 128 (avatarArt.ts). */
export const FLOATING_HEAD = {
  x: FLOATING_CAT.x + FLOATING_CAT.width / 2,
  y: FLOATING_CAT.y + Math.round((FLOATING_CAT.height * 72) / 128),
};
/** Between the cat's side and the nearest item. */
const CAT_CLEARANCE = 14;
/** How much further from the cat the middle item stands than the end ones: an arc round the head. */
const BULGE = 24;
/** Items keep this far inside the work area; the window's padding is no wider, so it stays inside too. */
const EDGE = 8;
const PADDING = 8;

export interface QuickMenuLayout {
  /** The menu window, in screen coordinates. */
  bounds: Rect;
  /** Which side of the cat the items are on. */
  side: 'left' | 'right';
  /** The cat's head in the menu window's coordinates; the items turn out from it. */
  head: { x: number; y: number };
  item: { width: number; height: number };
  /** Each item's top-left corner in the menu window's coordinates. */
  items: Array<{ x: number; y: number }>;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where a quick menu of `count` items opens for the cat whose floating window
 * is at `floating`: a column beside the cat, on the side with room for it
 * (left first, as the cat usually sits bottom-right), centred on the head but
 * kept inside `workArea`. The window never covers the cat itself unless the
 * work area is too small for the column beside it.
 */
export function quickMenuLayout(floating: { x: number; y: number }, workArea: Rect, count: number): QuickMenuLayout {
  const head = { x: floating.x + FLOATING_HEAD.x, y: floating.y + FLOATING_HEAD.y };
  const catLeft = floating.x + FLOATING_CAT.x;
  const catRight = catLeft + FLOATING_CAT.width;
  const { width, height } = QUICK_MENU_ITEM;
  const total = count * height + Math.max(0, count - 1) * ITEM_GAP;
  const needed = width + BULGE;
  const roomLeft = catLeft - CAT_CLEARANCE - (workArea.x + EDGE);
  const roomRight = workArea.x + workArea.width - EDGE - (catRight + CAT_CLEARANCE);
  const side = roomLeft >= needed || roomLeft >= roomRight ? 'left' : 'right';
  const top = Math.round(clamp(head.y - total / 2, workArea.y + EDGE, workArea.y + workArea.height - EDGE - total));
  const middle = (count - 1) / 2;
  const placed = Array.from({ length: count }, (_, index) => {
    const offset = middle === 0 ? 0 : (index - middle) / middle;
    const out = Math.round(BULGE * (1 - offset * offset));
    const x = side === 'left' ? catLeft - CAT_CLEARANCE - out - width : catRight + CAT_CLEARANCE + out;
    return {
      x: Math.round(clamp(x, workArea.x + EDGE, workArea.x + workArea.width - EDGE - width)),
      y: top + index * (height + ITEM_GAP),
    };
  });
  const left = Math.min(...placed.map((item) => item.x)) - PADDING;
  const right = Math.max(...placed.map((item) => item.x + width)) + PADDING;
  const bounds = { x: left, y: top - PADDING, width: right - left, height: total + 2 * PADDING };
  return {
    bounds,
    side,
    head: { x: head.x - bounds.x, y: head.y - bounds.y },
    item: { width, height },
    items: placed.map((item) => ({ x: item.x - bounds.x, y: item.y - bounds.y })),
  };
}
