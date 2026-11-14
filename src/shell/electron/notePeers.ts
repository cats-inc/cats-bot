import type { BotAvatar } from '../../shared/avatars.ts';

/** A cat a note can hear from, by face (bridge.ts `NoteWindowState.peers`). */
export interface NotePeer {
  id: string;
  name: string;
  avatar: BotAvatar | null;
  bossCat: boolean;
}

/**
 * SPEC-003 FR-16, SPEC-012 FR-5: the faces of the cats a bot's notes can hear from, and no others: the Boss
 * Cat hears from every other cat (their replies), any other cat only from the Boss Cat (its messages).
 * Archived cats say nothing. `profileOf` reads a cat's name and look; one it cannot read shows by id.
 */
export function notePeers(
  registry: { bots: ReadonlyArray<{ id: string; archivedAt: string | null }>; bossCat: { holder: string | null } },
  botId: string,
  profileOf: (id: string) => { name: string; avatar: BotAvatar } | null,
): NotePeer[] {
  const holder = registry.bossCat.holder;
  return registry.bots
    .filter((bot) => bot.id !== botId && bot.archivedAt === null && (botId === holder || bot.id === holder))
    .map((bot) => {
      let profile: { name: string; avatar: BotAvatar } | null = null;
      try {
        profile = profileOf(bot.id);
      } catch { /* an unreadable profile shows by id, without a face */ }
      return { id: bot.id, name: profile?.name ?? bot.id, avatar: profile?.avatar ?? null, bossCat: bot.id === holder };
    });
}
