import type { Locale } from './language.ts';

/** SPEC-002 FR-7a / ADR-027: the floating Cat's quick menu, as the shell and its pages share it. */

/** What the shell tells the floating Cat's page. */
export interface QuickMenuState {
  /** SPEC-008 FR-32: whether a single click opens the menu. */
  enabled: boolean;
  open: boolean;
}

export type QuickMenuItemKind = 'home' | 'note' | 'new';

/** What the menu's own page draws: labels already translated, positions in its window. */
export interface QuickMenuView {
  locale: Locale;
  title: string;
  /** The side of the cat the items are on. */
  side: 'left' | 'right';
  /** The cat's head in the menu window, where the items turn out from. */
  head: { x: number; y: number };
  item: { width: number; height: number };
  /** `waiting`: something in that conversation waits for the owner (SPEC-002 FR-7a). */
  items: Array<{ kind: QuickMenuItemKind; label: string; unread: number; waiting: boolean; x: number; y: number }>;
}
