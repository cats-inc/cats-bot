import type { ConversationStore } from '../conversations/store.ts';
import type { RuntimeClient } from '../runtime/client.ts';
import type { TranscriptEntry, WorkItem } from '../types.ts';

/**
 * SPEC-001 FR-28: an `interrupted` work item is settled by evidence, never
 * by rerunning it. The runtime's transcript (`history`) has no end-of-turn
 * marker, so completion has to be earned: the prompt must be this run's
 * (after the history baseline journaled before it was sent), a reply must
 * follow it, and every tool call the core saw for the turn must have its
 * result before that reply. Anything less goes to the owner with the evidence.
 */

export type RecoveryVerdict =
  | { verdict: 'completed'; text: string }
  | { verdict: 'awaiting_owner'; evidence: string }
  | { verdict: 'unknown'; reason: string };

/** Clock skew tolerated between the core and the provider's transcript timestamps. */
const TIMESTAMP_SLACK_MS = 5_000;
const EXCERPT = 80;

interface HistoryMessage {
  role: string;
  text: string;
  timestamp?: string;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT)}…` : flat;
}

/** Index of this run's prompt, or a reason it cannot be told apart from earlier ones. */
function findRunPrompt(item: WorkItem, messages: HistoryMessage[]): number | string {
  const prompt = item.prompt.trim();
  const baseline = item.run?.historyBaseline;
  const startedAt = Date.parse(item.run?.startedAt ?? item.admittedAt ?? '');
  for (let index = typeof baseline === 'number' ? baseline : 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'user' || !message.text.trim().endsWith(prompt)) continue;
    if (typeof baseline === 'number') return index;
    // Without a baseline only a timestamp can tie the message to this run.
    const at = Date.parse(message.timestamp ?? '');
    if (Number.isFinite(at) && Number.isFinite(startedAt) && at >= startedAt - TIMESTAMP_SLACK_MS) return index;
  }
  return typeof baseline === 'number' || messages.some((message) => message.timestamp)
    ? 'the runtime transcript does not contain this turn\'s prompt'
    : 'the runtime transcript cannot tell this turn\'s prompt from an earlier identical one';
}

export async function reconcileInterrupted(
  item: WorkItem,
  client: RuntimeClient,
  ownTranscript: TranscriptEntry[] = [],
): Promise<RecoveryVerdict> {
  const sessionId = item.run?.sessionId;
  if (!sessionId) {
    return { verdict: 'awaiting_owner', evidence: 'the turn never reached a runtime session' };
  }
  let messages: HistoryMessage[];
  try {
    const history = await client.getHistory(sessionId);
    messages = Array.isArray(history.messages) ? history.messages : [];
  } catch (error) {
    return { verdict: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
  const promptIndex = findRunPrompt(item, messages);
  if (typeof promptIndex === 'string') return { verdict: 'awaiting_owner', evidence: promptIndex };

  // The turn's span ends where the next prompt starts.
  const span: HistoryMessage[] = [];
  for (const message of messages.slice(promptIndex + 1)) {
    if (message.role === 'user' && message.text.trim()) break;
    span.push(message);
  }
  const replies = span.filter((message) => message.role === 'assistant' && message.text.trim());
  if (replies.length === 0) {
    return { verdict: 'awaiting_owner', evidence: 'the runtime transcript has the prompt but no reply' };
  }
  const last = replies.at(-1)!;
  const tools = ownTranscript.filter((entry) => entry.workItemId === item.id
    && (entry.kind === 'tool_use' || entry.kind === 'tool_result'));
  const finished = new Set(tools.filter((entry) => entry.kind === 'tool_result').map((entry) => entry.toolId));
  const open = tools.find((entry) => entry.kind === 'tool_use' && !finished.has(entry.toolId));
  if (open) {
    return {
      verdict: 'awaiting_owner',
      evidence: `the tool call ${open.toolName ?? open.toolId ?? ''} has no result; the last reply "${excerpt(last.text)}" may be partial`,
    };
  }
  if (tools.length > 0) {
    const lastToolAt = Date.parse(tools.at(-1)!.at);
    const replyAt = Date.parse(last.timestamp ?? '');
    // Text written before a tool call precedes its result; only a reply after the result ends the turn.
    if (!(Number.isFinite(replyAt) && Number.isFinite(lastToolAt) && replyAt > lastToolAt)) {
      return {
        verdict: 'awaiting_owner',
        evidence: `the last reply "${excerpt(last.text)}" cannot be placed after the turn's last tool call`,
      };
    }
  }
  return { verdict: 'completed', text: replies.map((message) => message.text.trim()).join('\n\n') };
}

/** Appends the recovered reply unless the transcript already carries it. */
export function recordRecoveredReply(conversations: ConversationStore, item: WorkItem, text: string): void {
  const existing = conversations.transcript(item.conversationId)
    .some((entry) => entry.workItemId === item.id && entry.kind === 'bot');
  if (existing) return;
  conversations.append(item.conversationId, { kind: 'bot', origin: 'system', text, workItemId: item.id });
}
