import type { BotPaths } from './paths.ts';
import type { BotStateStore } from './stateStore.ts';
import { readVersion1Conversations } from './version1Import.ts';

/**
 * SPEC-014 FR-14: one conversation as JSON lines, for portability and inspection.
 *
 * The same lines come from a bot's state database and from the version-1 files the
 * migration imports, so an export from before the migration and one from after it are
 * equal byte for byte when nothing was lost (SPEC-014 Acceptance). Each line is one JSON
 * object with a `type`:
 *
 * - `conversation`: the conversation's record, first;
 * - `entry`: each transcript entry, in `seq` order;
 * - `presentation`: each reply presentation, by `seq` and then by its id.
 *
 * Every record is written as it was stored, its fields in their order.
 */

export interface ConversationContent {
  record: Record<string, unknown>;
  entries: unknown[];
  responses: unknown[];
}

/** The lines of an export, each ending with a newline. */
export function exportLines(content: ConversationContent): string[] {
  const responses = [...content.responses].sort(byPresentation);
  return [
    { type: 'conversation', record: content.record },
    ...content.entries.map((entry) => ({ type: 'entry', entry })),
    ...responses.map((response) => ({ type: 'presentation', response })),
  ].map((line) => `${JSON.stringify(line)}\n`);
}

/**
 * The conversation `id` from the state database, or null when there is none. `home` is
 * also the home conversation, whatever its id.
 */
export function conversationFromDatabase(
  store: BotStateStore,
  id: string,
): ConversationContent | null {
  return store.snapshot(() => {
    const record = pick(store.conversations(), id);
    if (!record) return null;
    const own = String(record.id);
    return { record, entries: store.entries(own), responses: store.responses(own) };
  });
}

/**
 * The conversation `id` from a version-1 root, as the migration would import it, with what
 * it found that the import reports; null when there is no such conversation.
 */
export function conversationFromVersion1(
  paths: BotPaths,
  id: string,
): { content: ConversationContent; problems: string[] } | null {
  const { conversations, problems } = readVersion1Conversations(paths);
  const record = pick(
    conversations.map((conversation) => conversation.record),
    id,
  );
  if (!record) return null;
  const found = conversations.find((conversation) => conversation.record === record)!;
  const { entries, responses } = found.read();
  return {
    content: { record, entries, responses },
    problems: problems.map((problem) => `${problem.kind}: ${problem.file}`),
  };
}

function pick(records: readonly unknown[], id: string): Record<string, unknown> | null {
  const all = records.filter(
    (record): record is Record<string, unknown> => typeof record === 'object' && record !== null,
  );
  return (
    all.find((record) => record.id === id) ??
    (id === 'home' ? all.find((record) => record.role === 'home') : undefined) ??
    null
  );
}

function byPresentation(a: unknown, b: unknown): number {
  const seq = (value: unknown): number => Number((value as { seq?: unknown }).seq);
  const id = (value: unknown): string =>
    String((value as { presentation?: { id?: unknown } }).presentation?.id ?? '');
  return seq(a) - seq(b) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
}
