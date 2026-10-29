import type { BotInteraction, TranscriptEntry, TranscriptEntryKind, WorkItem } from '../../core/types.ts';

/**
 * SPEC-001 FR-33, SPEC-003: what the note shows, apart from React. The note
 * keeps no durable state: entries come from the core's transcript, a reply
 * being streamed is held as `PendingReply` until the turn completes and the
 * transcript is read again.
 */

export interface PendingReply {
  workItemId: string;
  text: string;
}

/** Progress lines are for the runtime, not the owner. */
export function visibleEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((entry) => entry.kind !== 'progress');
}

/**
 * Adds a live entry (a tool call reported mid-turn). A transcript read can
 * already hold it, since the core appends before it reports.
 */
export function addEntry(entries: readonly TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  if (entry.kind === 'progress') return [...entries];
  if (entry.seq > 0 && entries.some((existing) => existing.seq === entry.seq)) return [...entries];
  return [...entries, entry];
}

/** Streamed text of one reply; a different work item starts a new reply. */
export function appendDelta(pending: PendingReply | null, workItemId: string, text: string): PendingReply {
  if (pending && pending.workItemId === workItemId) return { workItemId, text: pending.text + text };
  return { workItemId, text };
}

let localSeq = 0;

/** A line the note shows by itself (for example a send that failed); it never reaches the transcript. */
export function localEntry(kind: TranscriptEntryKind, text: string, at = new Date()): TranscriptEntry {
  localSeq -= 1;
  return { seq: localSeq, at: at.toISOString(), kind, text, origin: 'system' };
}

export function entryKey(entry: TranscriptEntry): string {
  return `${entry.seq}:${entry.at}`;
}

export function entryClass(kind: TranscriptEntryKind): string {
  switch (kind) {
    case 'owner': return 'entry entry-owner';
    case 'bot': return 'entry entry-bot';
    case 'tool_use':
    case 'tool_result': return 'entry entry-tool';
    case 'progress': return 'entry entry-progress';
    case 'error': return 'entry entry-error';
    default: return 'entry entry-system';
  }
}

/** Plain text for everything but bot replies, which are markdown. */
export function entryText(entry: TranscriptEntry): string {
  if (entry.kind === 'tool_use') return `⚙ ${entry.toolName || 'tool'} ${entry.text || ''}`.trim();
  if (entry.kind === 'tool_result') return `↳ ${entry.text || ''}`.trim();
  return entry.text;
}

/** The time under an owner or bot message; an unprompted (heartbeat) reply says so. */
export function entryMeta(entry: TranscriptEntry, formatTime = (at: Date) => at.toLocaleTimeString()): string | null {
  if (!entry.at || (entry.kind !== 'owner' && entry.kind !== 'bot')) return null;
  const unprompted = entry.kind === 'bot' && entry.origin === 'heartbeat' ? 'unprompted · ' : '';
  return `${unprompted}${formatTime(new Date(entry.at))}`;
}

export { errorText } from '../errors.ts';

// ---- SPEC-003 FR-4, FR-5: tool cards and the owner's decisions -------------------

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolItem {
  type: 'tool';
  key: string;
  name: string;
  /** What the CLI reported as the call's input; empty when only a result was seen. */
  input: string;
  result: string | null;
  status: ToolStatus;
}

export type DecisionStatus = 'waiting' | 'approved' | 'denied' | 'expired';

export interface DecisionItem {
  type: 'decision';
  key: string;
  entry: TranscriptEntry;
  workItemId: string;
  status: DecisionStatus;
  /** Why it expired, when it did. */
  detail: string | null;
}

export type NoteItem = { type: 'entry'; key: string; entry: TranscriptEntry } | ToolItem | DecisionItem;

/** Work items that ask the owner something: `ask_owner` questions and interrupted turns to run again. */
const DECIDED_BY_OWNER = new Set(['ask_owner', 'recovery']);

function decisionStatus(item: WorkItem): DecisionStatus {
  switch (item.state) {
    case 'awaiting_owner': return 'waiting';
    case 'completed': return item.result?.text === 'denied' ? 'denied' : 'approved';
    case 'cancelled': return 'denied';
    default: return 'expired';
  }
}

/**
 * Turns the transcript into what the note shows: a tool call and its result
 * (matched by `toolId`, newest call first, since a CLI may reuse ids across
 * turns) become one card; the entry that asked the owner becomes a decision
 * with buttons while its work item waits. Everything else stays an entry.
 */
export function buildNoteItems(entries: readonly TranscriptEntry[], workItems: readonly WorkItem[]): NoteItem[] {
  const work = new Map(workItems.map((item) => [item.id, item]));
  const running = new Set(workItems.filter((item) => item.state === 'running').map((item) => item.id));
  const items: NoteItem[] = [];
  const openCalls = new Map<string, { item: ToolItem; workItemId: string | undefined }>();
  const asked = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'progress') continue;
    if (entry.kind === 'tool_use') {
      const item: ToolItem = { type: 'tool', key: `tool:${entry.seq}`, name: entry.toolName || 'tool', input: entry.text, result: null, status: 'done' };
      if (entry.toolId) openCalls.set(entry.toolId, { item, workItemId: entry.workItemId });
      item.status = entry.workItemId && running.has(entry.workItemId) ? 'running' : 'done';
      items.push(item);
      continue;
    }
    if (entry.kind === 'tool_result') {
      const call = entry.toolId ? openCalls.get(entry.toolId) : undefined;
      const item: ToolItem = call?.item ?? { type: 'tool', key: `tool:${entry.seq}`, name: entry.toolName || 'tool', input: '', result: null, status: 'done' };
      item.result = entry.text;
      item.status = entry.isError ? 'error' : 'done';
      if (call && entry.toolId) openCalls.delete(entry.toolId);
      else items.push(item);
      continue;
    }
    const asking = entry.kind === 'system' && entry.workItemId ? work.get(entry.workItemId) : undefined;
    if (asking && DECIDED_BY_OWNER.has(asking.source) && !asked.has(asking.id)) {
      asked.add(asking.id);
      const status = decisionStatus(asking);
      items.push({ type: 'decision', key: `decision:${asking.id}`, entry, workItemId: asking.id, status, detail: status === 'expired' ? asking.error ?? null : null });
      continue;
    }
    items.push({ type: 'entry', key: entryKey(entry), entry });
  }
  return items;
}

/** Input fields that say what a call is about, in the order they are preferred. */
const SUMMARY_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];

function firstLine(text: string): string {
  return (text.split(/\r?\n/u).find((part) => part.trim()) ?? '').trim();
}

/**
 * One line for a collapsed card. JSON input (how the Claude CLI reports it)
 * shows its most telling field, else the compacted object; other input its
 * first line; no input the first line of the result.
 */
export function toolSummary(item: ToolItem): string {
  if (!item.input) return firstLine(item.result ?? '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.input);
  } catch {
    return firstLine(item.input);
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const fields = parsed as Record<string, unknown>;
    for (const name of SUMMARY_FIELDS) {
      const value = fields[name];
      if (typeof value === 'string' && value.trim()) return firstLine(value);
    }
  }
  return JSON.stringify(parsed) ?? '';
}

/**
 * SPEC-004 B5: the native requests the note shows, those that can still be
 * answered. A finished request's redacted receipt stays in the core
 * (`cats-bot interactions`); as a card it only repeated "resolved".
 */
export function liveInteractions(interactions: readonly BotInteraction[]): BotInteraction[] {
  return interactions.filter((i) => i.status === 'pending' || i.status === 'responding');
}

/** Keeps the note's copy of a work item current from `work.updated` events. */
export function upsertWorkItem(items: readonly WorkItem[], item: WorkItem): WorkItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}
