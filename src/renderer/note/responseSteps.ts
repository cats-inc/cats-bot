import type { ConversationPresentation } from '@cats-inc/platform-ui-web/contracts';

import { t } from '../localeStore.ts';

/**
 * SPEC-003 FR-12: what a reply keeps folded while live progress details are on. Text is always shown, and so is
 * a failed step; the tool calls and progress lines in between are the reply's steps.
 */
export function foldedStepCount(presentation: Pick<ConversationPresentation, 'blocks'>): number {
  return presentation.blocks.filter((block) => block.kind !== 'text' && block.status !== 'error').length;
}

/** A reply still being written shows its steps as they come; a finished one folds them behind a link. */
export function isLiveReply(presentation: Pick<ConversationPresentation, 'phase'>): boolean {
  return presentation.phase !== 'sealed';
}

/** Whether a reply shows anything with its steps folded: some text, or a failed step. */
export function hasVisibleBody(presentation: Pick<ConversationPresentation, 'blocks'>): boolean {
  return presentation.blocks.some((block) => (block.kind === 'text' ? block.text.trim() !== '' : block.status === 'error'));
}

export interface ReplySteps {
  /** Whether the reply's steps are drawn. */
  open: boolean;
  /** The link under the reply: `open` to show its steps, `close` to fold them, or none. */
  link: 'open' | 'close' | null;
}

/**
 * How a reply draws its steps, with the bot's switch `on` and the owner having `opened` this reply. A live reply
 * shows them as they come. A finished one folds them behind its link, except one with nothing else to show (a turn
 * cancelled after its tools, or one ending on a tool call): folding would hide the whole reply, link and time.
 */
export function replySteps(presentation: Pick<ConversationPresentation, 'blocks' | 'phase'>, on: boolean, opened: boolean): ReplySteps {
  if (!on) return { open: false, link: null };
  if (isLiveReply(presentation)) return { open: true, link: null };
  if (foldedStepCount(presentation) === 0) return { open: false, link: null };
  if (!hasVisibleBody(presentation)) return { open: true, link: null };
  return { open: opened, link: opened ? 'close' : 'open' };
}

/** The link under a finished reply: how many steps it folds, or how to fold them again. */
export function stepsLinkLabel(count: number, open: boolean): string {
  if (open) return t('Hide steps');
  return count === 1 ? t('1 step') : t('{count} steps', { count: String(count) });
}
