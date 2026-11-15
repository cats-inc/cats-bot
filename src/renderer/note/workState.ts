import { isHeartbeatTurn } from '../../shared/heartbeatTurn.ts';
import type { TranscriptEntry, WorkItem } from '../../core/types.ts';

/** Deferred work still belongs to the conversation and stays cancellable. */
export function conversationWorkState(items: readonly WorkItem[], conversationId: string): { active: boolean; waiting: boolean } {
  const active = items.filter(item => item.conversationId === conversationId && (item.state === 'queued' || item.state === 'running'));
  return { active: active.length > 0, waiting: active.some(item => item.state === 'queued' || item.error === 'session_busy') };
}

export interface AwaitedReply {
  conversationId: string;
  workItems: readonly WorkItem[];
  entries: readonly TranscriptEntry[];
  /** Streamed text of a reply without a presentation is already in its own bubble. */
  streaming: boolean;
  /** A question or a desktop grant waits for the owner, which the header says. */
  askingOwner: boolean;
}

/**
 * SPEC-003 FR-18: the turns whose reply the note awaits with Cats Desktop's waiting bubble, three dots where the
 * reply will come; none, and the bubble does not show. A reply is awaited while a turn is queued or running, from the moment the owner's message shows (a turn
 * without one, such as a schedule's, from its start), until something of that turn's attempt is in the
 * transcript: its reply's own bubble, which keeps the dots until it has something to show, or its error. The
 * core shows a reply sealed before it reports the turn done, so a finished reply counts too, while a retried
 * turn's earlier attempts do not. A heartbeat may say nothing, so it is never awaited, nor is an interrupted
 * one run again, which the core still runs as a heartbeat.
 */
export function awaitedReplies(input: AwaitedReply): string[] {
  if (input.askingOwner || input.streaming) return [];
  const turns = input.workItems.filter(item => item.conversationId === input.conversationId
    && (item.state === 'queued' || item.state === 'running') && !isHeartbeatTurn(item)
    && (item.kind !== 'owner_message' || input.entries.some(entry => entry.kind === 'owner' && entry.workItemId === item.id)));
  const attempts = new Map(turns.map(item => [item.id, item.attemptFromSeq ?? 0]));
  const answered = input.entries.some(entry => entry.workItemId !== undefined && attempts.has(entry.workItemId)
    && entry.seq > attempts.get(entry.workItemId)! && (entry.presentation !== undefined || entry.kind === 'bot' || entry.kind === 'error'));
  return answered ? [] : turns.map(item => item.id);
}
