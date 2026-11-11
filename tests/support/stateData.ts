import { mkdirSync } from 'node:fs';
import { botPathsFor, stateDatabaseFile, type BotPaths } from '../../src/core/store/paths.ts';
import { openBotStateStore, type BotStateStore } from '../../src/core/store/stateStore.ts';
import type { JournalEntry, ScheduleRecord, WorkItem } from '../../src/core/types.ts';

/**
 * A bot's state database, read or written by a test while no core of that bot holds it
 * for writing (SPEC-014). A reader may read beside a running core.
 */
export function withStateStore<T>(
  root: string,
  work: (store: BotStateStore) => T,
  mode: 'reader' | 'writer' = 'reader',
): T {
  const store = openBotStateStore({ file: stateDatabaseFile(botPathsFor(root)), mode });
  try {
    return work(store);
  } finally {
    store.close();
  }
}

/** The journal as the version-1 reader gave it: every line, and the last state of each item. */
export function readStateJournal(root: string): {
  entries: JournalEntry[];
  workItems: Map<string, WorkItem>;
  schedules: Map<string, ScheduleRecord>;
} {
  return withStateStore(root, (store) => ({
    entries: store.journal(),
    workItems: new Map(store.workItems().map((item) => [item.id, item])),
    schedules: new Map(store.schedules().map((schedule) => [schedule.id, schedule])),
  }));
}

/** A journal line written while the bot is stopped, as a crash would have left it. */
export function appendStateJournal(root: string, entry: JournalEntry): void {
  withStateStore(root, (store) => store.appendJournal(entry), 'writer');
}

/**
 * A writer on a bot root's database for a test that builds the core's parts by hand, closed
 * when the test ends.
 */
export function openTestStateStore(
  paths: BotPaths,
  t: { after(fn: () => void): void },
): BotStateStore {
  mkdirSync(paths.root, { recursive: true });
  const store = openBotStateStore({ file: stateDatabaseFile(paths), mode: 'writer' });
  t.after(() => store.close());
  return store;
}
