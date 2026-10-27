import type { JournalEntry, ScheduleRecord, WorkItem } from '../types.ts';
import { appendJsonLine, readJsonLines } from './atomicFile.ts';
import type { BotPaths } from './paths.ts';

/**
 * SPEC-001 FR-2 / ADR-001 §6: `journal.jsonl` is append-only; every state
 * transition of a work item or schedule writes the whole record again, and
 * startup rebuilds the truth by keeping the last record per id.
 */

export interface JournalState {
  workItems: Map<string, WorkItem>;
  schedules: Map<string, ScheduleRecord>;
  entries: JournalEntry[];
  corruptLines: number;
}

export function appendJournal(paths: BotPaths, entry: JournalEntry): void {
  appendJsonLine(paths.journal, entry);
}

export function readJournal(paths: BotPaths): JournalState {
  const { entries, corruptLines } = readJsonLines<JournalEntry>(paths.journal);
  return { ...rebuildJournalState(entries), entries, corruptLines };
}

export function rebuildJournalState(
  entries: Iterable<JournalEntry>,
): Pick<JournalState, 'workItems' | 'schedules'> {
  const workItems = new Map<string, WorkItem>();
  const schedules = new Map<string, ScheduleRecord>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'work' && entry.item && typeof entry.item.id === 'string') {
      workItems.set(entry.item.id, entry.item);
    } else if (entry.type === 'schedule' && entry.schedule && typeof entry.schedule.id === 'string') {
      schedules.set(entry.schedule.id, entry.schedule);
    }
  }
  return { workItems, schedules };
}
