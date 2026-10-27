import type { ConversationStore } from '../conversations/store.ts';
import type { RuntimeClient } from '../runtime/client.ts';
import type { WorkItem } from '../types.ts';

/**
 * SPEC-001 FR-28: an `interrupted` work item is settled by evidence, never
 * by rerunning it. The runtime's own transcript (`history`) decides: a reply
 * after the prompt means the turn completed; otherwise the owner decides.
 */

export type RecoveryVerdict =
  | { verdict: 'completed'; text: string }
  | { verdict: 'awaiting_owner'; evidence: string }
  | { verdict: 'unknown'; reason: string };

export async function reconcileInterrupted(
  item: WorkItem,
  client: RuntimeClient,
): Promise<RecoveryVerdict> {
  const sessionId = item.run?.sessionId;
  if (!sessionId) {
    return { verdict: 'awaiting_owner', evidence: 'the turn never reached a runtime session' };
  }
  let messages: Array<{ role: string; text: string }>;
  try {
    const history = await client.getHistory(sessionId);
    messages = Array.isArray(history.messages) ? history.messages : [];
  } catch (error) {
    return { verdict: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
  const prompt = item.prompt.trim();
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user' && message.text.trim().endsWith(prompt)) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex === -1) {
    return { verdict: 'awaiting_owner', evidence: 'the runtime transcript does not contain the prompt' };
  }
  const reply = messages.slice(promptIndex + 1).find((message) => message.role === 'assistant' && message.text.trim());
  if (reply) return { verdict: 'completed', text: reply.text.trim() };
  return { verdict: 'awaiting_owner', evidence: 'the runtime transcript has the prompt but no reply' };
}

/** Appends the recovered reply unless the transcript already carries it. */
export function recordRecoveredReply(conversations: ConversationStore, item: WorkItem, text: string): void {
  const existing = conversations.transcript(item.conversationId)
    .some((entry) => entry.workItemId === item.id && entry.kind === 'bot');
  if (existing) return;
  conversations.append(item.conversationId, { kind: 'bot', origin: 'system', text, workItemId: item.id });
}
