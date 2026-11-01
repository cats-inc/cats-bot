import type { WorkItem } from '../../core/types.ts';

/** Deferred work still belongs to the conversation and stays cancellable. */
export function conversationWorkState(items: readonly WorkItem[], conversationId: string): { active: boolean; waiting: boolean } {
  const active = items.filter(item => item.conversationId === conversationId && (item.state === 'queued' || item.state === 'running'));
  return { active: active.length > 0, waiting: active.some(item => item.state === 'queued' || item.error === 'session_busy') };
}
