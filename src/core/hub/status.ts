import type {
  BotStatus,
  BotWorkBoard,
  ConversationRecord,
  ScheduleRecord,
  WorkItem,
  WorkItemKind,
} from '../types.ts';

/**
 * SPEC-012 FR-1 to FR-3: the status board a bot's core builds for the hub,
 * without the model and without message text. It is a pure read of what the
 * core already holds; it never binds or wakes a session. Note titles are its
 * only free text, cleaned and cut here and fenced by every consumer.
 */

export const BOARD_TITLE_LIMIT = 80;
export const BOARD_NOTE_LIMIT = 20;
export const BOARD_ATTENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

/** Control, zero-width and bidirectional-override characters, which can hide or reorder text. */
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]', 'gu');

/** SPEC-012 FR-3: a title as it may leave the bot. */
export function cleanBoardText(text: string, limit = BOARD_TITLE_LIMIT): string {
  const flat = text.replace(UNSAFE, ' ').replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Turns that are the owner's work: not the heartbeat's, and not another bot's (SPEC-012 FR-2). */
function ownerWork(item: WorkItem): boolean {
  return item.kind !== 'heartbeat' && item.source !== 'bot';
}

function settledAt(item: WorkItem): string {
  return item.result?.completedAt ?? item.updatedAt;
}

export interface WorkBoardInput {
  status: BotStatus;
  conversations: ConversationRecord[];
  workItems: WorkItem[];
  schedules: ScheduleRecord[];
  /** Provider interactions waiting for the owner outside contact notes. */
  waitingInteractions: number;
  now: Date;
}

export function buildWorkBoard(input: WorkBoardInput): BotWorkBoard {
  const { status, now } = input;
  const contactIds = new Set(input.conversations.filter((record) => record.contactOf).map((record) => record.id));
  const items = input.workItems.filter((item) => ownerWork(item) && !contactIds.has(item.conversationId));

  // The latest settled turn of each conversation; only a failed or interrupted one needs attention.
  const latestByConversation = new Map<string, WorkItem>();
  for (const item of items) {
    if (!['completed', 'failed', 'interrupted'].includes(item.state)) continue;
    const previous = latestByConversation.get(item.conversationId);
    if (!previous || settledAt(item) > settledAt(previous)) latestByConversation.set(item.conversationId, item);
  }
  const since = now.getTime() - BOARD_ATTENTION_DAYS * DAY_MS;
  const attention = [...latestByConversation.values()]
    .filter((item) => (item.state === 'failed' || item.state === 'interrupted') && Date.parse(settledAt(item)) >= since)
    .sort((a, b) => settledAt(a).localeCompare(settledAt(b)))
    .map((item) => ({
      workItemId: item.id,
      conversationId: item.conversationId,
      state: item.state as 'failed' | 'interrupted',
      at: settledAt(item),
    }));

  const latestTurn = new Map<string, WorkItem>();
  for (const item of items) {
    const previous = latestTurn.get(item.conversationId);
    if (!previous || item.updatedAt > previous.updatedAt) latestTurn.set(item.conversationId, item);
  }
  const lastTurnOf = (conversationId: string): BotWorkBoard['notes'][number]['lastTurn'] => {
    const latest = latestTurn.get(conversationId);
    if (!latest) return null;
    if (latest.state === 'running') return 'running';
    if (latest.state === 'awaiting_owner') return 'awaiting_owner';
    if (latest.state === 'failed' || latest.state === 'interrupted') return 'failed';
    return null;
  };
  const activity = (record: ConversationRecord): string =>
    [record.lastOwnerMessageAt, record.lastBotMessageAt, record.createdAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? record.createdAt;
  const notes = input.conversations
    .filter((record) => record.role === 'note' && !record.contactOf)
    .sort((a, b) => activity(b).localeCompare(activity(a)))
    .slice(0, BOARD_NOTE_LIMIT)
    .map((record) => ({
      id: record.id,
      title: cleanBoardText(record.title),
      lastOwnerMessageAt: record.lastOwnerMessageAt,
      lastBotMessageAt: record.lastBotMessageAt,
      lastTurn: lastTurnOf(record.id),
    }));

  const home = input.conversations.find((record) => record.role === 'home');
  const running = status.queue.running;
  const active = input.schedules.filter((schedule) => schedule.state === 'active');
  const nextDue = active
    .map((schedule) => schedule.nextAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0] ?? null;

  return {
    id: status.id,
    name: cleanBoardText(status.name),
    runtime: status.runtime.state,
    home: {
      presence: home && ['ready', 'initializing'].includes(home.attachment.state) ? 'awake' : 'asleep',
      lastOwnerMessageAt: home?.lastOwnerMessageAt ?? null,
      lastBotMessageAt: home?.lastBotMessageAt ?? null,
    },
    ownInitiative: {
      enabled: status.heartbeat.enabled,
      mode: status.heartbeat.mode,
      phase: status.heartbeat.phase,
      unanswered: status.heartbeat.unanswered,
      waitingForOwner: status.heartbeat.waitingForOwner,
      nextAt: status.heartbeat.nextAt,
    },
    queue: {
      running: running
        ? { kind: running.kind as WorkItemKind, conversationId: running.conversationId, startedAt: running.run?.startedAt ?? null }
        : null,
      queued: status.queue.queued,
    },
    attention,
    // SPEC-012 FR-2: a question asked in a contact note comes from the Boss Cat's own exchange.
    waitingDecisions: items.filter((item) => item.state === 'awaiting_owner').length + input.waitingInteractions,
    schedules: { count: active.length, nextAt: nextDue },
    notes,
    builtAt: now.toISOString(),
  };
}
