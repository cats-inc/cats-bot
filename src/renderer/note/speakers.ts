import type { TranscriptEntry } from '../../core/types.ts';

/**
 * SPEC-003 FR-16, SPEC-009 FR-10, SPEC-012 FR-5: who speaks in a note and where. A note is a talk between the
 * owner and one cat, so its bubbles carry no face: the cat's face is the header's, ringed in gold for the Boss
 * Cat. A message from another cat carries that cat's face and name. In a contact note both sides are cats:
 * each bubble carries its cat's face and name, the Boss Cat writes on the right like the owner does elsewhere,
 * and the header shows the cat it looks after.
 */

export interface NoteCat {
  name: string;
  /** The face's image; none when the cat is not known to this note (its look is drawn from its initial). */
  avatar: string | undefined;
  bossCat: boolean;
}

/** A cat this note can hear from, as the shell reports it (`window.state().peers`). */
export interface NotePeerLook {
  id: string;
  name: string;
  avatar: string | undefined;
  bossCat: boolean;
}

export interface NoteCast {
  /** This note's own cat. */
  self: NoteCat;
  /** The cats it can hear from: every other cat for the Boss Cat, the Boss Cat for any other. */
  peers: readonly NotePeerLook[];
  /** On a contact note, the other cat's id and name. */
  contact: { id: string; name: string } | null;
}

export type BubbleSide = 'left' | 'right';

export interface BubbleSpeaker {
  side: BubbleSide;
  /** The face and name over the bubble; none in a talk between the owner and this note's cat. */
  cat: NoteCat | null;
}

function contactCat(cast: NoteCast): NoteCat | null {
  if (!cast.contact) return null;
  const known = cast.peers.find((peer) => peer.id === cast.contact!.id);
  return known
    ? { name: known.name, avatar: known.avatar, bossCat: known.bossCat }
    : { name: cast.contact.name, avatar: undefined, bossCat: false };
}

/** Whether this note's own cat writes on the right: only in a contact note, and only as the Boss Cat. */
function selfOnRight(cast: NoteCast): boolean {
  return cast.contact !== null && cast.self.bossCat;
}

/** This note's cat: its replies, and what it says on its own. */
export function selfSpeaker(cast: NoteCast): BubbleSpeaker {
  return { side: selfOnRight(cast) ? 'right' : 'left', cat: cast.contact ? cast.self : null };
}

/**
 * A message written into the note: the owner's, or one another cat sent. On a contact note the other cat sits
 * opposite this note's cat; elsewhere another cat's message sits with the cats, on the left, by its face.
 */
export function entrySpeaker(entry: Pick<TranscriptEntry, 'kind' | 'origin' | 'from'>, cast: NoteCast): BubbleSpeaker {
  if (entry.kind === 'bot') return selfSpeaker(cast);
  if (entry.origin !== 'bot') return { side: 'right', cat: null };
  const contact = contactCat(cast);
  if (contact) return { side: selfOnRight(cast) ? 'left' : 'right', cat: contact };
  const name = entry.from ?? '';
  const known = cast.peers.find((peer) => peer.name === name);
  return { side: 'left', cat: { name, avatar: known?.avatar, bossCat: known?.bossCat ?? false } };
}

/** The face in the header: this note's cat, or on a contact note the cat the Boss Cat looks after. */
export function headerCat(cast: NoteCast): NoteCat {
  return selfOnRight(cast) ? contactCat(cast) ?? cast.self : cast.self;
}

/** SPEC-003 FR-15: the direct message reaches Telegram once Telegram is on, its token stored and the owner's chat bound. */
export function reachesTelegram(policy: { enabled: boolean; ownerChatId: number | null }, tokenStored: boolean): boolean {
  return policy.enabled && tokenStored && policy.ownerChatId !== null;
}
