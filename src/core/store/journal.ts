import { readFileSync } from 'node:fs';

import { HEARTBEAT_PROMPT_PREFIX, isHeartbeatPrompt } from '../../shared/heartbeatTurn.ts';
import type { JournalEntry, ScheduleRecord, WorkItem } from '../types.ts';
import { appendJsonLine, readJsonLines, writeFileAtomic } from './atomicFile.ts';
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

/**
 * SPEC-002 FR-5b and SPEC-001 FR-14: a work item of a cleared or deleted conversation keeps its id, kind, state,
 * times, `sourceRef` and chain, so a message accepted once stays accepted once and a delivery's state can still be
 * read, but no longer what was asked or answered. A heartbeat keeps the mark that makes it one.
 */
export function blankWorkItemText(item: WorkItem): WorkItem {
  const blank: WorkItem = { ...item, prompt: isHeartbeatPrompt(item.prompt) ? HEARTBEAT_PROMPT_PREFIX : '' };
  if (item.result) blank.result = { ...item.result, text: '' };
  return blank;
}

/**
 * Blanks one conversation's text in `journal.jsonl`: its work items' prompts and replies and, with `schedules`,
 * its schedules' prompts. The file is rewritten line by line, so a line that cannot be read stays as it was, and
 * atomically, without a backup copy, which would keep exactly what is erased. Returns how many lines changed.
 */
export function blankJournalText(paths: BotPaths, conversationId: string, options: { schedules: boolean }): number {
  let text: string;
  try {
    text = readFileSync(paths.journal, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let changed = 0;
  const lines = text.split('\n').map((line) => {
    if (!line.trim()) return line;
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      return line;
    }
    if (entry?.type === 'work' && entry.item?.conversationId === conversationId) {
      const blank = blankWorkItemText(entry.item);
      if (blank.prompt === entry.item.prompt && blank.result?.text === entry.item.result?.text) return line;
      changed += 1;
      return JSON.stringify({ ...entry, item: blank });
    }
    if (options.schedules && entry?.type === 'schedule' && entry.schedule?.conversationId === conversationId && entry.schedule.prompt) {
      changed += 1;
      return JSON.stringify({ ...entry, schedule: { ...entry.schedule, prompt: '' } });
    }
    return line;
  });
  if (changed) writeFileAtomic(paths.journal, lines.join('\n'));
  return changed;
}
