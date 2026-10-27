import type { TranscriptEntry, TranscriptEntryKind } from '../../core/types.ts';

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

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes errors thrown in the main process.
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');
}
