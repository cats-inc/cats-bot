import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ConversationRecord, JournalEntry, TranscriptEntry } from '../types.ts';
import { rebuildJournalState } from './journal.ts';
import { transcriptFile, type BotPaths } from './paths.ts';
import { presentationResponsesAsWritten, presentationsDirectory } from './presentation.ts';
import {
  openBotStateStore,
  type BotStateStore,
  type OpenBotStateStoreOptions,
} from './stateStore.ts';

/**
 * SPEC-014 FR-11: a version-1 data root imported into a new state database, checked against
 * the files, and marked finished in the same durable transaction as the last batch.
 *
 * The import only reads the version-1 files. The steps around it are the migration's
 * (PLAN-014 task 1.5): copying the files aside first, removing the database when the import
 * did not finish (FR-12), writing the report beside the copy, raising the profile and
 * archiving the files. Records are kept as their files hold them, before any of today's
 * readers fill in or upgrade a field, so that those readers can run on them unchanged.
 */

/**
 * What the import found that is not a plain record. `BLOCKS` says which of them stop it.
 *
 * - `unreadable_file`: a transcript or the journal that exists and cannot be read, such as
 *   a directory in its place, a file the account may not read, or one too long for a
 *   string. Today's readers fail on it too.
 * - `unreadable_line`: a transcript or journal line that is not JSON, as a crash leaves the
 *   line it was writing. Today's readers skip it as well.
 * - `not_an_entry`: a transcript line that is JSON but no entry with a whole `seq` of 1 or
 *   more. Today's reader returns it and the note shows it, and the core numbers the next
 *   entry after it, so the entries after it are no entries either.
 * - `seq_out_of_order`: an entry whose `seq` does not come after the entry before it. The
 *   core never writes one; a hand edit or a second writer can. The database keeps one entry
 *   for each `seq` in order, so this one cannot be kept as it is.
 * - `unreadable_conversation`: a conversation file that is not a record with an id. Today it
 *   is skipped with a warning and stays on disk; after the import, its transcript would
 *   never be read again.
 * - `conversation_in_two_files`: two files that hold the same conversation id.
 * - `no_conversation`: a transcript or a presentation file of no conversation, as a crash
 *   while one was deleted leaves (its record goes first).
 * - `presentation_from_backup`: a sidecar that cannot be read, whose backup was imported
 *   instead, as today's reader uses it.
 * - `unreadable_presentation`: neither a sidecar nor its backup can be read. Today the
 *   conversation's view fails on it; the transcript is imported without it.
 * - `unsupported_presentation`: a sidecar whose version is not 1, or whose backup is one
 *   when it must be used. Today's reader refuses it, so that it never hides a later format
 *   behind an older backup.
 * - `not_read`: a file in the conversation, transcript or presentation directories that no
 *   reader of today reads, such as a backup copy or a temporary file.
 */
export type Version1ProblemKind =
  | 'unreadable_file'
  | 'unreadable_line'
  | 'not_an_entry'
  | 'seq_out_of_order'
  | 'unreadable_conversation'
  | 'conversation_in_two_files'
  | 'no_conversation'
  | 'presentation_from_backup'
  | 'unreadable_presentation'
  | 'unsupported_presentation'
  | 'not_read';

/**
 * Which problems stop the import: those after which a record shown today would be lost or
 * changed. The others are reported, and their files stay with the version-1 files.
 */
export const BLOCKS: Readonly<Record<Version1ProblemKind, boolean>> = {
  unreadable_file: true,
  unreadable_line: false,
  not_an_entry: true,
  seq_out_of_order: true,
  unreadable_conversation: true,
  conversation_in_two_files: true,
  no_conversation: false,
  presentation_from_backup: false,
  unreadable_presentation: false,
  unsupported_presentation: true,
  not_read: false,
};

/** A problem names files and line numbers, never what a line holds. */
export interface Version1Problem {
  kind: Version1ProblemKind;
  blocks: boolean;
  /** Relative to the bot root, with `/` between its parts. */
  file: string;
  /** The first line numbers, counted from 1; `count` says how many there are. */
  lines?: number[];
  count?: number;
  /** For `conversation_in_two_files`: the other file. */
  otherFile?: string;
  conversationId?: string;
  /** For `unreadable_file`: the error's code, such as `EISDIR`. */
  reason?: string;
}

export interface Version1Counts {
  conversations: number;
  entries: number;
  responses: number;
  journalLines: number;
  workItems: number;
  schedules: number;
  /** Work items whose conversation no longer exists, kept as today's journal keeps them. */
  workItemsWithoutConversation: number;
  perConversation: Record<string, { entries: number; responses: number }>;
}

export interface Version1ImportReport {
  /** Nothing blocked the import, the database matched the files, and the marker is written. */
  finished: boolean;
  problems: Version1Problem[];
  /** Where the database differed from the files, by ids and line numbers only. */
  mismatches: string[];
  counts: Version1Counts;
}

export interface ImportVersion1Options {
  paths: BotPaths;
  /** A database file that does not exist yet, or one with no records in it. */
  file: string;
  now?: () => Date;
  /** Entries per transaction while a transcript is imported. */
  batchSize?: number;
  /** Opens the store; a test replaces it to see what a failure on the way leaves. */
  open?: (options: OpenBotStateStoreOptions) => BotStateStore;
  /** More fields for the marker, such as which copy of the files the import read. */
  marker?: Record<string, unknown>;
}

const LINES_LISTED = 20;
const DEFAULT_BATCH_SIZE = 2000;

class VerificationFailed extends Error {}

/** The problems found so far, and whether any of them stops the import. */
class Problems {
  readonly list: Version1Problem[] = [];
  #blocked = false;

  push(found: Version1Problem): void {
    this.list.push(found);
    if (found.blocks) this.#blocked = true;
  }

  get blocked(): boolean {
    return this.#blocked;
  }
}

export function importVersion1(options: ImportVersion1Options): Version1ImportReport {
  const { paths } = options;
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize must be a whole number of entries, at least 1');
  }
  const warnings: string[] = [];
  const store = (options.open ?? openBotStateStore)({
    file: options.file,
    mode: 'writer',
    now,
    warn: (message) => warnings.push(message),
  });
  try {
    if (!store.isEmpty() || store.importMarker() !== undefined) {
      throw new Error(
        `${options.file} already holds records; the version-1 import needs a new database`,
      );
    }
    const problems = new Problems();
    const source = readSources(paths, problems);
    const counts = emptyCounts();

    // Records are written only while nothing has blocked the import; the files are still
    // read to the end, so that the report lists every problem.
    if (!problems.blocked) {
      store.transaction(() => {
        for (const record of source.conversations.values()) {
          store.saveConversation(record.value as unknown as ConversationRecord);
        }
      });
    }
    for (const id of source.conversations.keys()) {
      const transcript = readTranscriptSource(paths, id, problems);
      const presentation = readPresentationSource(paths, id, source, problems);
      if (!problems.blocked) {
        for (let start = 0; start < transcript.length; start += batchSize) {
          store.importEntries(id, transcript.slice(start, start + batchSize));
        }
        store.transaction(() => {
          for (const response of presentation) store.saveResponse(id, response as TranscriptEntry);
        });
      }
      counts.perConversation[id] = { entries: transcript.length, responses: presentation.length };
      counts.entries += transcript.length;
      counts.responses += presentation.length;
    }
    counts.conversations = source.conversations.size;
    let journal: unknown[] | null = readLineSource(paths.root, paths.journal, problems).values;
    const state = rebuildJournalState(journal as JournalEntry[]);
    counts.journalLines = journal.length;
    counts.workItems = state.workItems.size;
    counts.schedules = state.schedules.size;
    counts.workItemsWithoutConversation = [...state.workItems.values()].filter(
      (item) => !source.conversations.has(item.conversationId),
    ).length;

    if (problems.blocked) {
      return { finished: false, problems: problems.list, mismatches: [], counts };
    }

    const mismatches: string[] = [];
    try {
      store.transaction(
        () => {
          for (const line of journal!) store.appendJournal(line as JournalEntry);
          // The check reads the journal again; this copy is not needed beside it.
          journal = null;
          mismatches.push(...verify(paths, store, source, counts.journalLines, warnings));
          if (mismatches.length > 0) throw new VerificationFailed();
          store.setImportMarker(
            JSON.stringify({
              ...options.marker,
              from: 1,
              finishedAt: now().toISOString(),
              conversations: counts.conversations,
              entries: counts.entries,
              responses: counts.responses,
              journalLines: counts.journalLines,
            }),
          );
        },
        { durable: true },
      );
    } catch (error) {
      if (!(error instanceof VerificationFailed)) throw error;
      return { finished: false, problems: problems.list, mismatches, counts };
    }
    return { finished: true, problems: problems.list, mismatches, counts };
  } finally {
    store.close();
  }
}

/**
 * SPEC-014 FR-14: what the import would keep of the conversations of a version-1 root, read
 * the way the import reads them, for `cats-bot export`: each record, its entries and its
 * reply presentations as written. Nothing is written; the problems found come with them.
 */
export function readVersion1Conversations(paths: BotPaths): {
  conversations: Array<{ record: Record<string, unknown>; read(): { entries: unknown[]; responses: unknown[] } }>;
  problems: Version1Problem[];
} {
  const problems = new Problems();
  const sources = readSources(paths, problems);
  const conversations = [...sources.conversations.entries()].map(([id, { value }]) => ({
    record: value,
    read: () => ({
      entries: readTranscriptSource(paths, id, problems) as unknown[],
      responses: readPresentationSource(paths, id, sources, problems),
    }),
  }));
  return { conversations, problems: problems.list };
}

interface Sources {
  /** By the id each file holds, as today's loader keys them. */
  conversations: Map<string, { file: string; value: Record<string, unknown> }>;
}

function emptyCounts(): Version1Counts {
  return {
    conversations: 0,
    entries: 0,
    responses: 0,
    journalLines: 0,
    workItems: 0,
    schedules: 0,
    workItemsWithoutConversation: 0,
    // A conversation may be called `__proto__`.
    perConversation: Object.create(null) as Version1Counts['perConversation'],
  };
}

/**
 * Which file a path reaches. Whether two names reach one file is the file system's to say:
 * Windows and macOS ignore case by default, though not in every directory, and do not fold
 * case the way JavaScript does.
 */
function fileKey(file: string): string {
  try {
    const stat = statSync(file, { bigint: true });
    if (stat.ino !== 0n) return `${String(stat.dev)}:${String(stat.ino)}`;
  } catch {
    // Missing, or a name no file can have.
  }
  return `path:${file}`;
}

/** The conversation records, and every other file of the three directories accounted for. */
function readSources(paths: BotPaths, problems: Problems): Sources {
  const conversations: Sources['conversations'] = new Map();
  for (const name of listDirectory(paths.conversations)) {
    const file = join(paths.conversations, name);
    if (!name.endsWith('.json') || !isFile(file)) {
      problems.push(problem('not_read', paths.root, file));
      continue;
    }
    const value = readJson(file);
    // What `normalizeConversation` accepts as a record.
    if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') {
      problems.push(problem('unreadable_conversation', paths.root, file));
      continue;
    }
    const earlier = conversations.get(value.id);
    if (earlier) {
      problems.push({
        ...problem('conversation_in_two_files', paths.root, earlier.file),
        otherFile: rootRelative(paths.root, file),
        conversationId: value.id,
      });
      continue;
    }
    conversations.set(value.id, { file, value });
  }
  // The files the conversations' own paths reach, which is what the import reads.
  const ids = [...conversations.keys()];
  const transcripts = new Set(ids.map((id) => fileKey(transcriptFile(paths, id))));
  const directory = presentationsDirectory(paths);
  const sidecars = new Set(ids.map((id) => fileKey(join(directory, `${id}.json`))));
  const backups = new Set(ids.map((id) => fileKey(join(directory, `${id}.json.bak`))));

  for (const name of listDirectory(paths.transcripts)) {
    const file = join(paths.transcripts, name);
    if (!name.endsWith('.jsonl')) {
      problems.push(problem('not_read', paths.root, file));
    } else if (!transcripts.has(fileKey(file))) {
      problems.push(problem('no_conversation', paths.root, file));
    }
  }

  for (const name of listDirectory(directory)) {
    const file = join(directory, name);
    if (name.endsWith('.json')) {
      if (!sidecars.has(fileKey(file))) problems.push(problem('no_conversation', paths.root, file));
    } else if (!name.endsWith('.json.bak') || !backups.has(fileKey(file))) {
      // A backup is accounted for with its sidecar; anything else is not read.
      problems.push(problem('not_read', paths.root, file));
    }
  }
  return { conversations };
}

/** A conversation's entries in file order, keeping each one's `seq`; the rest is reported. */
function readTranscriptSource(
  paths: BotPaths,
  conversationId: string,
  problems: Problems,
): TranscriptEntry[] {
  const file = transcriptFile(paths, conversationId);
  const { values, lines } = readLineSource(paths.root, file, problems);
  const entries: TranscriptEntry[] = [];
  const notEntries: number[] = [];
  const outOfOrder: number[] = [];
  let last = 0;
  values.forEach((value, index) => {
    if (!isRecord(value) || !isWholeNumber(value.seq) || value.seq < 1) {
      notEntries.push(lines[index]!);
    } else if (value.seq <= last) {
      outOfOrder.push(lines[index]!);
    } else {
      entries.push(value as unknown as TranscriptEntry);
      last = value.seq;
    }
  });
  if (notEntries.length > 0) problems.push(problem('not_an_entry', paths.root, file, notEntries));
  if (outOfOrder.length > 0) {
    problems.push(problem('seq_out_of_order', paths.root, file, outOfOrder));
  }
  return entries;
}

/**
 * A conversation's reply presentations as written, from the file today's reader would use:
 * the sidecar, or its backup when the sidecar cannot be read.
 */
function readPresentationSource(
  paths: BotPaths,
  conversationId: string,
  sources: Sources,
  problems: Problems,
): unknown[] {
  if (!sources.conversations.has(conversationId)) return [];
  const file = join(presentationsDirectory(paths), `${conversationId}.json`);
  const backup = `${file}.bak`;
  // As `readPresentations` looks for it: anything by that name, a directory too.
  if (!existsSync(file)) {
    if (existsSync(backup)) problems.push(problem('not_read', paths.root, backup));
    return [];
  }
  const primary = readPresentationFile(file, conversationId);
  if (primary.kind === 'read') {
    // The backup is the generation before. One of another version is not read, here or
    // by today's reader, and today's writer leaves it alone.
    if (existsSync(backup) && readPresentationFile(backup, conversationId).kind === 'unsupported') {
      problems.push(problem('not_read', paths.root, backup));
    }
    return primary.responses;
  }
  if (primary.kind === 'unsupported') {
    problems.push(problem('unsupported_presentation', paths.root, file));
    return [];
  }
  if (!existsSync(backup)) {
    problems.push(problem('unreadable_presentation', paths.root, file));
    return [];
  }
  const fallback = readPresentationFile(backup, conversationId);
  if (fallback.kind === 'read') {
    problems.push(problem('presentation_from_backup', paths.root, file));
    return fallback.responses;
  }
  problems.push(
    problem(
      fallback.kind === 'unsupported' ? 'unsupported_presentation' : 'unreadable_presentation',
      paths.root,
      file,
    ),
  );
  return [];
}

type PresentationRead =
  { kind: 'read'; responses: unknown[] } | { kind: 'unsupported' } | { kind: 'unreadable' };

function readPresentationFile(file: string, conversationId: string): PresentationRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { kind: 'unreadable' };
  }
  try {
    return { kind: 'read', responses: presentationResponsesAsWritten(text, conversationId) };
  } catch (error) {
    // `readPresentations` refuses every file whose version is not 1 by this message, and
    // never uses the backup of one.
    if (error instanceof Error && error.message.startsWith('Unsupported')) {
      return { kind: 'unsupported' };
    }
    return { kind: 'unreadable' };
  }
}

/** Every line that is JSON, with its line number; lines that are not are reported. */
function readLineSource(
  root: string,
  file: string,
  problems: Problems,
): { values: unknown[]; lines: number[] } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { values: [], lines: [] };
    problems.push({
      ...problem('unreadable_file', root, file),
      reason: typeof code === 'string' ? code : 'unknown',
    });
    return { values: [], lines: [] };
  }
  const values: unknown[] = [];
  const lines: number[] = [];
  const unreadable: number[] = [];
  // As `readJsonLines` reads them.
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      values.push(JSON.parse(trimmed));
      lines.push(index + 1);
    } catch {
      unreadable.push(index + 1);
    }
  });
  if (unreadable.length > 0) problems.push(problem('unreadable_line', root, file, unreadable));
  return { values, lines };
}

/**
 * Reads the files again, the directories included, and the database through the store,
 * inside the import's last transaction. A record the store could not read counts as a
 * difference.
 */
function verify(
  paths: BotPaths,
  store: BotStateStore,
  imported: Sources,
  journalLines: number,
  warnings: string[],
): string[] {
  const found: string[] = [];
  const ignored = new Problems();
  const sources = readSources(paths, ignored);

  const stored = new Map<string, unknown>();
  for (const record of store.conversations()) {
    if (isRecord(record) && typeof record.id === 'string') stored.set(record.id, record);
  }
  if (stored.size !== sources.conversations.size || imported.conversations.size !== stored.size) {
    found.push(
      `conversations: ${sources.conversations.size} in the files, ${stored.size} in the database`,
    );
  }
  for (const [id, record] of sources.conversations) {
    if (!sameJson(stored.get(id), record.value)) found.push(`conversation ${id} differs`);

    const entries = readTranscriptSource(paths, id, ignored);
    const kept = store.entries(id);
    if (kept.length !== entries.length) {
      found.push(
        `entries of conversation ${id}: ${entries.length} in the files, ${kept.length} in the database`,
      );
    }
    const differing = entries.findIndex((entry, index) => !sameJson(kept[index], entry));
    if (differing >= 0) {
      found.push(`entry ${String(entries[differing]!.seq)} of conversation ${id} differs`);
    }

    const responses = readPresentationSource(paths, id, sources, ignored);
    const keptResponses = new Map<string, unknown>();
    for (const response of store.responses(id)) {
      const presentationId = presentationIdOf(response);
      if (presentationId !== null) keptResponses.set(presentationId, response);
    }
    if (keptResponses.size !== responses.length) {
      found.push(
        `presentations of conversation ${id}: ${responses.length} in the files, ${keptResponses.size} in the database`,
      );
    }
    for (const response of responses) {
      const presentationId = presentationIdOf(response);
      if (presentationId === null || !sameJson(keptResponses.get(presentationId), response)) {
        found.push(`a presentation of conversation ${id} differs`);
        break;
      }
    }
  }
  const lines = readLineSource(paths.root, paths.journal, ignored).values;
  if (ignored.blocked) found.push('the files now hold a problem that stops the import');
  const keptLines = store.journal();
  if (lines.length !== journalLines || keptLines.length !== lines.length) {
    found.push(`journal: ${lines.length} lines in the file, ${keptLines.length} in the database`);
  }
  const line = lines.findIndex((value, index) => !sameJson(keptLines[index], value));
  if (line >= 0) found.push(`journal line ${line + 1} of those read differs`);

  const state = rebuildJournalState(lines as JournalEntry[]);
  if (!sameJson(store.workItems(), [...state.workItems.values()])) {
    found.push('the current work items differ from the journal');
  }
  if (!sameJson(store.schedules(), [...state.schedules.values()])) {
    found.push('the current schedules differ from the journal');
  }
  for (const warning of warnings)
    found.push(`the database holds a record it cannot read: ${warning}`);
  return found;
}

function presentationIdOf(response: unknown): string | null {
  if (!isRecord(response) || !isRecord(response.presentation)) return null;
  const id = response.presentation.id;
  return typeof id === 'string' ? id : null;
}

/**
 * Equal as JSON: what the database keeps of a value is its JSON text. A number too large
 * for a double, such as `1e999`, is read as Infinity, which JSON writes as null, so a value
 * holding one is never equal: it would not come back as today's reader reads it.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined || !keepsAsJson(b)) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function keepsAsJson(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'number' && !Number.isFinite(next)) return false;
    // One at a time: spread into a call, a large array would overflow the stack.
    if (typeof next === 'object' && next !== null) {
      for (const value of Object.values(next)) pending.push(value);
    }
  }
  return true;
}

function problem(
  kind: Version1ProblemKind,
  root: string,
  file: string,
  lines?: number[],
): Version1Problem {
  return {
    kind,
    blocks: BLOCKS[kind],
    file: rootRelative(root, file),
    ...(lines ? { lines: lines.slice(0, LINES_LISTED), count: lines.length } : {}),
  };
}

function rootRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

function listDirectory(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort();
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
