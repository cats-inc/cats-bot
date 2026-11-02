/**
 * SPEC-008 FR-29: the looks a bot's Cat can have. The ids are stored in
 * profile.json, so they never change. Their order is the order the hub assigns
 * them in, and the first is the Cat every bot had before there was a choice.
 */

export const BOT_AVATARS = [
  'ginger', 'tuxedo', 'siamese', 'calico', 'fold',
  'tabby', 'white-tabby', 'black', 'persian', 'bengal',
] as const;
export type BotAvatar = (typeof BOT_AVATARS)[number];
export const DEFAULT_BOT_AVATAR: BotAvatar = 'ginger';

/** Display names; each has a Traditional Chinese entry in language.ts. */
export const BOT_AVATAR_LABELS: Readonly<Record<BotAvatar, string>> = {
  ginger: 'Ginger tabby',
  tuxedo: 'Tuxedo',
  siamese: 'Siamese',
  calico: 'Calico',
  fold: 'Gray fold',
  tabby: 'Brown tabby',
  'white-tabby': 'White tabby',
  black: 'Black',
  persian: 'Persian',
  bengal: 'Bengal',
};

export function isBotAvatar(value: unknown): value is BotAvatar {
  return (BOT_AVATARS as readonly unknown[]).includes(value);
}

/** A profile from before the choice, or one naming a look this version lacks, shows the default Cat. */
export function resolveBotAvatar(value: unknown): BotAvatar {
  return isBotAvatar(value) ? value : DEFAULT_BOT_AVATAR;
}

/**
 * The look for a new bot: one no bot is using when there is one, preferring
 * one no archived bot would bring back either. The owner may still give
 * several bots the same look, so past the end this takes the least used.
 */
export function nextBotAvatar(active: readonly BotAvatar[], archived: readonly BotAvatar[] = []): BotAvatar {
  const uses = (bots: readonly BotAvatar[], avatar: BotAvatar) => bots.filter((used) => used === avatar).length;
  // A stable sort, so the catalog order decides what is left tied.
  return [...BOT_AVATARS].sort((a, b) => uses(active, a) - uses(active, b) || uses(archived, a) - uses(archived, b))[0]!;
}
