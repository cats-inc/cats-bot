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

/** The link under a finished reply: how many steps it folds, or how to fold them again. */
export function stepsLinkLabel(count: number, open: boolean): string {
  if (open) return t('Hide steps');
  return count === 1 ? t('1 step') : t('{count} steps', { count: String(count) });
}
