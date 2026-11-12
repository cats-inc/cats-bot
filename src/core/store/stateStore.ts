import type {
  ConversationRecord,
  JournalEntry,
  ScheduleRecord,
  TranscriptEntry,
  WorkItem,
} from '../types.ts';
import { buildSearchQuery, INDEX_FORM, indexText } from './searchText.ts';
import { BOT_ENTRY_WORK_ITEM, responseCovers } from './stateSchema.ts';
export { StateDatabaseError, type StateDatabaseErrorCode } from './stateDatabase.ts';
import {
  openStateDatabase,
  type StateDatabase,
  type StateDatabaseMode,
  type StateRow,
  type Synchronous,
  type TransactionOptions,
} from './stateDatabase.ts';

/**
 * SPEC-014 FR-3 and FR-5 to FR-10: a bot's records in its state database.
 *
 * This is what the rest of the core uses; the adapter under it stays inside the store. Every
 * record is kept as the JSON it was given and comes back as that JSON parsed, so a field
 * this version does not know survives. The columns beside it only find and order records.
 *
 * Nothing is checked on the way out: a conversation record or a reply presentation is what
 * was stored, and the caller validates it as it validated the file it used to read. A record
 * that cannot be read at all is left out and reported through `warn`, as an unreadable line
 * of a file is today.
 */

/**
 * What `deleted_work` keeps of a work item. A record that is not JSON keeps only its id, so
 * that it never stops its conversation from being deleted.
 */
const DELETED_WORK_SELECT = `select id,
  case when json_valid(json) then json_extract(json, '$.sourceRef') end,
  case when json_valid(json) then json_extract(json, '$.chain.deliveryId') end
  from work_items`;

/** The `meta` key the version-1 import writes when it has finished (FR-11). */
const IMPORT_MARKER = 'version1_import';

export interface EntriesPage {
  /** How many entries at most. */
  limit: number;
  /** Only entries before this `seq`; without it, the newest ones. */
  beforeSeq?: number;
}

export interface SearchOptions {
  /** Default 50. */
  limit?: number;
  conversationId?: string;
}

export interface SearchHit {
  conversationId: string;
  /** Carries `kind` and `origin`, so a caller can drop tool output or another bot's words. */
  entry: TranscriptEntry;
}

export interface BotStateStore {
  readonly mode: StateDatabaseMode;
  /** All of `work` or none of it, and synced to the disk when `durable`; see `StateDatabase.transaction`. */
  transaction<T>(work: () => Synchronous<T>, options?: TransactionOptions): T;
  /** Several reads against one snapshot. */
  snapshot<T>(work: () => Synchronous<T>): T;
  close(): void;

  /** Every conversation record as stored, in no particular order. */
  conversations(): unknown[];
  saveConversation(record: ConversationRecord): void;
  /**
   * FR-5 and FR-7: the record with its entries, their index rows, its presentations, and
   * its work items with their journal lines, in one transaction. Schedules are the
   * caller's to cancel.
   */
  deleteConversation(id: string): void;

  /** The whole transcript in `seq` order. */
  entries(conversationId: string): TranscriptEntry[];
  /** FR-10: the newest entries, or the ones before a `seq`, in `seq` order. */
  entriesPage(conversationId: string, page: EntriesPage): TranscriptEntry[];
  /** The entries after a `seq`, in `seq` order. */
  entriesAfter(conversationId: string, seq: number): TranscriptEntry[];
  /**
   * FR-10: up to `limit` entries before `beforeSeq`, or the newest, in `seq` order, with
   * `firstSeq`: the `seq` column of the oldest row they were read from, which a record that
   * lost its own `seq` still has, or null when there were none.
   */
  entriesWindow(
    conversationId: string,
    page: EntriesPage,
  ): { entries: TranscriptEntry[]; firstSeq: number | null };
  /** FR-10: the entries from `fromSeq` to before `beforeSeq`, in `seq` order. */
  entriesBetween(conversationId: string, fromSeq: number, beforeSeq: number): TranscriptEntry[];
  /** FR-10: whether the conversation holds a row before `seq`, readable or not. */
  hasEntryBefore(conversationId: string, seq: number): boolean;
  /** FR-10: whether a bot entry of the work item is at `fromSeq` or after, by index. */
  hasBotEntryOf(conversationId: string, workItemId: string, fromSeq: number): boolean;
  /** The highest `seq` of a conversation, or 0. */
  lastSeq(conversationId: string): number;
  /**
   * FR-5 and FR-9: stored with the next `seq` and indexed in the same transaction. The
   * conversation must exist.
   */
  appendEntry(conversationId: string, entry: Omit<TranscriptEntry, 'seq'>): TranscriptEntry;

  /**
   * FR-11, for the version-1 import: entries stored as they are given, each keeping its
   * `seq`, and indexed in the same transaction. Each `seq` must be greater than the one
   * before it and than any the conversation already holds. The conversation must exist.
   */
  importEntries(conversationId: string, entries: readonly TranscriptEntry[]): void;
  /** Whether the store holds no record of any kind. */
  isEmpty(): boolean;
  /** FR-11: what the version-1 import recorded when it finished, or undefined. */
  importMarker(): string | undefined;
  /** FR-11: written in the same transaction as the import's last batch. */
  setImportMarker(value: string): void;

  /** FR-6: one row per reply presentation, as stored. */
  responses(conversationId: string): unknown[];
  /**
   * FR-10: the reply presentations from `fromSeq` to before `beforeSeq` (to the end without
   * it), as stored, in the order `responses` gives them.
   */
  responsesBetween(conversationId: string, fromSeq: number, beforeSeq?: number): unknown[];
  /**
   * FR-10: the lowest `seq` of a presentation before `seq` that covers `seq`, or null. Read
   * from the index alone: no presentation is read.
   */
  presentationReach(conversationId: string, seq: number): number | null;
  /** The conversation must exist. */
  saveResponse(conversationId: string, entry: TranscriptEntry): void;

  /**
   * FR-7: one journal line, kept whatever it holds. A line that gives a work item or a
   * schedule with an id also becomes that item's current state, in the same transaction.
   */
  appendJournal(entry: JournalEntry): void;
  /**
   * FR-7: whether a work item from this source went with a deleted conversation, so that a
   * delivery handled before cannot come in as a new one.
   */
  isDeletedSource(sourceRef: string): boolean;
  /**
   * FR-7: work items whose conversation no longer exists, as 0.5 kept them, deleted as their
   * conversation's would have been, with what `deleted_work` keeps. Returns how many.
   */
  forgetWorkWithoutConversation(): number;
  /** FR-7: the deliveries, among those named, whose work item went with a deleted conversation. */
  deletedDeliveries(deliveryIds: readonly string[]): Array<{ id: string; deliveryId: string }>;
  /** The journal in the order it was written; with `ref`, the lines about one work item or schedule. */
  journal(ref?: string): JournalEntry[];
  /** The current state of every work item, in the order each first appeared. */
  workItems(): WorkItem[];
  /** The current state of every schedule, in the order each first appeared. */
  schedules(): ScheduleRecord[];

  /**
   * FR-8: entries holding every word of `query`, best match first. It runs on the store's
   * own connection, and a word found in a large share of the entries takes seconds there.
   */
  search(query: string, options?: SearchOptions): SearchHit[];
  /**
   * FR-9: empties the index and builds it again from the entries. It does not read the
   * index, so it also repairs a damaged one. Returns how many entries it indexed.
   */
  rebuildIndex(): number;
}

export interface OpenBotStateStoreOptions {
  file: string;
  mode: StateDatabaseMode;
  busyTimeoutMs?: number;
  now?: () => Date;
  /** Receives problems that are not fatal, such as a record that cannot be read. */
  warn?: (message: string) => void;
}

/**
 * Opens a bot's store. A writer also makes sure the index was built the way this version
 * searches it, and rebuilds one that was not, which takes minutes for a million entries.
 */
export function openBotStateStore(options: OpenBotStateStoreOptions): BotStateStore {
  const database = openStateDatabase(options);
  try {
    const store = new Store(database, options.warn ?? (() => {}));
    store.matchIndexForm();
    return store;
  } catch (error) {
    database.close();
    throw error;
  }
}

const DEFAULT_SEARCH_LIMIT = 50;
const REBUILD_BATCH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * The two shapes of a search. `cross join` keeps SQLite from starting at the entries: for
 * one conversation, the SQLite in Electron 41 otherwise walks every entry of it and asks
 * the index about each.
 */
export function searchSql(scoped: boolean): string {
  return scoped
    ? `select e.conversation_id as conversation_id, e.seq as seq, e.json as json
       from entries_fts cross join entries e on e.id = entries_fts.rowid
       where entries_fts match ? and e.conversation_id = ?
       order by entries_fts.rank, e.id desc limit ?`
    : // Ranked and cut down inside the index, before any record is fetched.
      `select e.conversation_id as conversation_id, e.seq as seq, e.json as json
       from (select rowid, rank from entries_fts where entries_fts match ? order by rank, rowid desc limit ?) hit
       cross join entries e on e.id = hit.rowid
       order by hit.rank, e.id desc`;
}

class Store implements BotStateStore {
  readonly #database: StateDatabase;
  readonly #warn: (message: string) => void;
  /** What has been reported already: a record that cannot be read is read again and again. */
  readonly #reported = new Set<string>();
  /** Whether the index was made the way this version searches it. */
  #indexMatches = false;

  constructor(database: StateDatabase, warn: (message: string) => void) {
    this.#database = database;
    this.#warn = warn;
  }

  get mode(): StateDatabaseMode {
    return this.#database.mode;
  }

  transaction<T>(work: () => Synchronous<T>, options?: TransactionOptions): T {
    return this.#database.transaction(work, options);
  }

  snapshot<T>(work: () => Synchronous<T>): T {
    return this.#database.snapshot(work);
  }

  close(): void {
    this.#database.close();
  }

  /**
   * The index is searched with this version's rewriting, so it must have been built with
   * it. A writer rebuilds one that was not; a reader can only refuse to search it.
   */
  matchIndexForm(): void {
    const form = String(INDEX_FORM);
    const matches = (): boolean => this.#database.meta('index_form') === form;
    this.#indexMatches = matches();
    if (this.#indexMatches || this.#database.mode !== 'writer') return;
    this.#database.transaction(() => {
      // Looked at again now that nobody else can be writing: another writer may just have done it.
      if (matches()) return;
      if (this.#database.get('select 1 as found from entries limit 1')) this.rebuildIndex();
      this.#database.setMeta('index_form', form);
    });
    this.#indexMatches = true;
  }

  /**
   * The records of some rows, without the ones that cannot be read: JSON that does not
   * parse, or parses to something that is not a record. A journal line may hold anything.
   */
  #records<T>(rows: StateRow[], what: (row: StateRow) => string, anything = false): T[] {
    const records: T[] = [];
    for (const row of rows) {
      let record: unknown;
      try {
        record = JSON.parse(String(row.json));
      } catch {
        record = undefined;
      }
      if (record === undefined || (!anything && !isRecord(record))) {
        const message = `${what(row)} cannot be read and was left out`;
        if (!this.#reported.has(message)) {
          this.#reported.add(message);
          this.#warn(message);
        }
        continue;
      }
      records.push(record as T);
    }
    return records;
  }

  /**
   * Up to `count` records of the rows `fetch` gives. When some of them cannot be read it
   * asks for more, so that a damaged record does not look like the end of what there is.
   */
  #filled<T>(
    count: number,
    fetch: (want: number) => StateRow[],
    read: (rows: StateRow[]) => T[],
  ): T[] {
    for (let want = count; ; want *= 2) {
      const rows = fetch(want);
      const records = read(rows);
      if (records.length >= count || rows.length < want) return records.slice(0, count);
    }
  }

  #entryRecords(conversationId: string, rows: StateRow[]): TranscriptEntry[] {
    return this.#records(
      rows,
      (row) => `entry ${String(row.seq)} of conversation ${conversationId}`,
    );
  }

  conversations(): unknown[] {
    return this.#records(
      this.#database.all('select id, json from conversations'),
      (row) => `conversation ${String(row.id)}`,
    );
  }

  saveConversation(record: ConversationRecord): void {
    this.#database.run(
      'insert into conversations(id, json) values (?, ?) on conflict(id) do update set json = excluded.json',
      record.id,
      JSON.stringify(record),
    );
  }

  deleteConversation(id: string): void {
    this.#database.transaction(() => {
      this.#database.run(
        'delete from entries_fts where rowid in (select id from entries where conversation_id = ?)',
        id,
      );
      this.#database.run('delete from entries where conversation_id = ?', id);
      this.#database.run('delete from responses where conversation_id = ?', id);
      this.#database.run(
        `insert or ignore into deleted_work(id, source_ref, delivery_id) ${DELETED_WORK_SELECT}
         where conversation_id = ?`,
        id,
      );
      this.#database.run(
        `delete from journal where type = 'work' and ref in (select id from work_items where conversation_id = ?)`,
        id,
      );
      this.#database.run('delete from work_items where conversation_id = ?', id);
      this.#database.run('delete from conversations where id = ?', id);
    });
  }

  entries(conversationId: string): TranscriptEntry[] {
    return this.#entryRecords(
      conversationId,
      this.#database.all(
        'select seq, json from entries where conversation_id = ? order by seq',
        conversationId,
      ),
    );
  }

  entriesPage(conversationId: string, page: EntriesPage): TranscriptEntry[] {
    const count = positive(page.limit, 'limit');
    const newestFirst = this.#filled(
      count,
      (want) =>
        page.beforeSeq === undefined
          ? this.#database.all(
              'select seq, json from entries where conversation_id = ? order by seq desc limit ?',
              conversationId,
              want,
            )
          : this.#database.all(
              'select seq, json from entries where conversation_id = ? and seq < ? order by seq desc limit ?',
              conversationId,
              page.beforeSeq,
              want,
            ),
      (rows) => this.#entryRecords(conversationId, rows),
    );
    return newestFirst.reverse();
  }

  entriesAfter(conversationId: string, seq: number): TranscriptEntry[] {
    return this.#entryRecords(
      conversationId,
      this.#database.all(
        'select seq, json from entries where conversation_id = ? and seq > ? order by seq',
        conversationId,
        seq,
      ),
    );
  }

  entriesWindow(
    conversationId: string,
    page: EntriesPage,
  ): { entries: TranscriptEntry[]; firstSeq: number | null } {
    const count = positive(page.limit, 'limit');
    // As `entriesPage` reads them, keeping each record's row.
    for (let want = count; ; want *= 2) {
      const rows =
        page.beforeSeq === undefined
          ? this.#database.all(
              'select seq, json from entries where conversation_id = ? order by seq desc limit ?',
              conversationId,
              want,
            )
          : this.#database.all(
              'select seq, json from entries where conversation_id = ? and seq < ? order by seq desc limit ?',
              conversationId,
              page.beforeSeq,
              want,
            );
      const kept: Array<{ seq: number; entry: TranscriptEntry }> = [];
      for (const row of rows) {
        const [entry] = this.#entryRecords(conversationId, [row]);
        if (entry) kept.push({ seq: Number(row.seq), entry });
        if (kept.length === count) break;
      }
      if (kept.length >= count || rows.length < want) {
        kept.reverse();
        return { entries: kept.map((item) => item.entry), firstSeq: kept[0]?.seq ?? null };
      }
    }
  }

  entriesBetween(conversationId: string, fromSeq: number, beforeSeq: number): TranscriptEntry[] {
    return this.#entryRecords(
      conversationId,
      this.#database.all(
        'select seq, json from entries where conversation_id = ? and seq >= ? and seq < ? order by seq',
        conversationId,
        fromSeq,
        beforeSeq,
      ),
    );
  }

  hasEntryBefore(conversationId: string, seq: number): boolean {
    return (
      this.#database.get(
        'select 1 as found from entries where conversation_id = ? and seq < ? limit 1',
        conversationId,
        seq,
      ) !== undefined
    );
  }

  hasBotEntryOf(conversationId: string, workItemId: string, fromSeq: number): boolean {
    // The expression and the condition are the index's own, so that SQLite reads by it.
    return (
      this.#database.get(
        `select 1 as found from entries
         where conversation_id = ? and kind = 'bot' and ${BOT_ENTRY_WORK_ITEM} = ? and seq >= ?
         limit 1`,
        conversationId,
        workItemId,
        fromSeq,
      ) !== undefined
    );
  }

  lastSeq(conversationId: string): number {
    const last = this.#database.get(
      'select max(seq) as seq from entries where conversation_id = ?',
      conversationId,
    )?.seq;
    return typeof last === 'number' ? last : 0;
  }

  appendEntry(conversationId: string, entry: Omit<TranscriptEntry, 'seq'>): TranscriptEntry {
    return this.#database.transaction(() => {
      this.#requireConversation(conversationId);
      const seq = this.lastSeq(conversationId) + 1;
      // An imported entry may carry the largest `seq` a number holds; one more could not be
      // read back.
      if (!Number.isSafeInteger(seq)) {
        throw new RangeError(`Conversation ${conversationId} holds no more entries`);
      }
      // As today's core writes an entry: `seq` first, and never one the entry came with.
      const { seq: _given, ...rest } = entry as Partial<TranscriptEntry>;
      const full = { seq, ...rest } as TranscriptEntry;
      const id = this.#database.insert(
        'insert into entries(conversation_id, seq, kind, origin, at, json) values (?, ?, ?, ?, ?, ?)',
        conversationId,
        full.seq,
        text(full.kind),
        text(full.origin),
        text(full.at),
        JSON.stringify(full),
      );
      this.#index(id, full.text);
      return full;
    });
  }

  importEntries(conversationId: string, entries: readonly TranscriptEntry[]): void {
    this.#database.transaction(() => {
      this.#requireConversation(conversationId);
      let last = this.lastSeq(conversationId);
      for (const entry of entries) {
        const seq: unknown = entry.seq;
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= last) {
          throw new RangeError(
            `Entry ${String(seq)} of conversation ${conversationId} does not come after entry ${last}`,
          );
        }
        const id = this.#database.insert(
          'insert into entries(conversation_id, seq, kind, origin, at, json) values (?, ?, ?, ?, ?, ?)',
          conversationId,
          seq,
          text(entry.kind),
          text(entry.origin),
          text(entry.at),
          JSON.stringify(entry),
        );
        this.#index(id, entry.text);
        last = seq;
      }
    });
  }

  isEmpty(): boolean {
    const row = this.#database.get(
      `select not (exists (select 1 from conversations) or exists (select 1 from entries)
        or exists (select 1 from responses) or exists (select 1 from journal)
        or exists (select 1 from work_items) or exists (select 1 from schedules)
        or exists (select 1 from deleted_work)) as empty`,
    );
    return row?.empty === 1;
  }

  importMarker(): string | undefined {
    return this.#database.meta(IMPORT_MARKER);
  }

  setImportMarker(value: string): void {
    this.#database.setMeta(IMPORT_MARKER, value);
  }

  /** As `ConversationStore` requires one today: nothing is kept for a conversation that is not there. */
  #requireConversation(id: string): void {
    if (!this.#database.get('select 1 as found from conversations where id = ?', id)) {
      throw new Error(`Unknown conversation ${id}`);
    }
  }

  #index(rowid: number, body: unknown): void {
    if (typeof body !== 'string') return;
    const terms = indexText(body);
    if (terms.trim() === '') return;
    this.#database.run('insert into entries_fts(rowid, terms) values (?, ?)', rowid, terms);
  }

  responses(conversationId: string): unknown[] {
    return this.#records(
      this.#database.all(
        'select presentation_id, json from responses where conversation_id = ? order by seq, presentation_id',
        conversationId,
      ),
      (row) => `presentation ${String(row.presentation_id)} of conversation ${conversationId}`,
    );
  }

  responsesBetween(conversationId: string, fromSeq: number, beforeSeq?: number): unknown[] {
    return this.#records(
      beforeSeq === undefined
        ? this.#database.all(
            'select presentation_id, json from responses where conversation_id = ? and seq >= ? order by seq, presentation_id',
            conversationId,
            fromSeq,
          )
        : this.#database.all(
            'select presentation_id, json from responses where conversation_id = ? and seq >= ? and seq < ? order by seq, presentation_id',
            conversationId,
            fromSeq,
            beforeSeq,
          ),
      (row) => `presentation ${String(row.presentation_id)} of conversation ${conversationId}`,
    );
  }

  presentationReach(conversationId: string, seq: number): number | null {
    // The longest any presentation covers bounds how far back one can start and still reach
    // `seq`; both reads are of an index only.
    const span = this.#database.get(
      'select max(covers - seq) as span from responses where conversation_id = ?',
      conversationId,
    )?.span;
    if (typeof span !== 'number' || span < 1) return null;
    const reach = this.#database.get(
      'select min(seq) as reach from responses where conversation_id = ? and seq >= ? and seq < ? and covers >= ?',
      conversationId,
      seq - span,
      seq,
      seq,
    )?.reach;
    return typeof reach === 'number' ? reach : null;
  }

  saveResponse(conversationId: string, entry: TranscriptEntry): void {
    const presentation = entry.presentation as { id?: unknown; phase?: unknown } | undefined;
    if (typeof presentation?.id !== 'string' || presentation.id === '') {
      throw new TypeError('A reply presentation needs an id');
    }
    const id = presentation.id;
    this.#database.transaction(() => {
      this.#requireConversation(conversationId);
      this.#database.run(
        `insert into responses(conversation_id, presentation_id, seq, revision, phase, covers, json)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(conversation_id, presentation_id) do update set seq = excluded.seq,
           revision = excluded.revision, phase = excluded.phase, covers = excluded.covers,
           json = excluded.json`,
        conversationId,
        id,
        integer(entry.seq),
        integer(entry.presentationRevision),
        text(presentation.phase),
        responseCovers(entry),
        JSON.stringify(entry),
      );
    });
  }

  forgetWorkWithoutConversation(): number {
    return this.#database.transaction(() => {
      // The home conversation is made on first use and is never deleted, so its work items
      // are never a deleted conversation's, even before its record exists.
      const orphans = `select id from work_items where conversation_id is not null
        and conversation_id <> 'home'
        and conversation_id not in (select id from conversations)`;
      this.#database.run(
        `insert or ignore into deleted_work(id, source_ref, delivery_id) ${DELETED_WORK_SELECT}
         where id in (${orphans})`,
      );
      this.#database.run(`delete from journal where type = 'work' and ref in (${orphans})`);
      return this.#database.run(`delete from work_items where id in (${orphans})`);
    });
  }

  isDeletedSource(sourceRef: string): boolean {
    return (
      this.#database.get('select 1 as found from deleted_work where source_ref = ?', sourceRef) !==
      undefined
    );
  }

  deletedDeliveries(deliveryIds: readonly string[]): Array<{ id: string; deliveryId: string }> {
    const found: Array<{ id: string; deliveryId: string }> = [];
    for (const deliveryId of new Set(deliveryIds)) {
      const row = this.#database.get(
        'select id from deleted_work where delivery_id = ? order by id limit 1',
        deliveryId,
      );
      if (typeof row?.id === 'string') found.push({ id: row.id, deliveryId });
    }
    return found;
  }

  appendJournal(entry: JournalEntry): void {
    // What `rebuildJournalState` reads today, and nothing more: a line that names no work
    // item or schedule by a text id is kept as a line and becomes nobody's current state.
    const line: Record<string, unknown> = isRecord(entry) ? entry : {};
    const item = line.type === 'work' && isRecord(line.item) ? line.item : null;
    const schedule = line.type === 'schedule' && isRecord(line.schedule) ? line.schedule : null;
    this.#database.transaction(() => {
      let ref: string | null = null;
      if (item && typeof item.id === 'string') {
        ref = item.id;
        // A row keeps its place when it is replaced, so items stay in the order they first appeared.
        this.#database.run(
          `insert into work_items(id, conversation_id, state, updated_at, json) values (?, ?, ?, ?, ?)
           on conflict(id) do update set conversation_id = excluded.conversation_id, state = excluded.state,
             updated_at = excluded.updated_at, json = excluded.json`,
          item.id,
          text(item.conversationId),
          text(item.state),
          text(item.updatedAt),
          JSON.stringify(item),
        );
      } else if (schedule && typeof schedule.id === 'string') {
        ref = schedule.id;
        this.#database.run(
          `insert into schedules(id, conversation_id, json) values (?, ?, ?)
           on conflict(id) do update set conversation_id = excluded.conversation_id, json = excluded.json`,
          schedule.id,
          text(schedule.conversationId),
          JSON.stringify(schedule),
        );
      }
      this.#database.run(
        'insert into journal(at, type, ref, json) values (?, ?, ?, ?)',
        text(line.at),
        text(line.type),
        ref,
        JSON.stringify(entry),
      );
    });
  }

  journal(ref?: string): JournalEntry[] {
    const rows =
      ref === undefined
        ? this.#database.all('select id, json from journal order by id')
        : this.#database.all('select id, json from journal where ref = ? order by id', ref);
    return this.#records(rows, (row) => `journal line ${String(row.id)}`, true);
  }

  workItems(): WorkItem[] {
    return this.#records(
      this.#database.all('select id, json from work_items order by rowid'),
      (row) => `work item ${String(row.id)}`,
    );
  }

  schedules(): ScheduleRecord[] {
    return this.#records(
      this.#database.all('select id, json from schedules order by rowid'),
      (row) => `schedule ${String(row.id)}`,
    );
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const match = buildSearchQuery(query);
    if (!match) return [];
    const count = positive(options.limit ?? DEFAULT_SEARCH_LIMIT, 'limit');
    if (!this.#indexMatches) {
      throw new Error(
        'The search index of this bot was made by another version of Cats Bot. The bot rebuilds it when it starts with this version.',
      );
    }
    const { conversationId } = options;
    return this.#filled(
      count,
      (want) =>
        conversationId === undefined
          ? this.#database.all(searchSql(false), match, want)
          : this.#database.all(searchSql(true), match, conversationId, want),
      (rows) =>
        rows.flatMap((row) => {
          const found = String(row.conversation_id);
          return this.#entryRecords(found, [row]).map((entry) => ({
            conversationId: found,
            entry,
          }));
        }),
    );
  }

  rebuildIndex(): number {
    return this.#database.transaction(() => {
      // FTS5's own command: it drops the index without reading it.
      this.#database.run(`insert into entries_fts(entries_fts) values ('delete-all')`);
      let after = 0;
      for (;;) {
        const rows = this.#database.all(
          'select id, conversation_id, seq, json from entries where id > ? order by id limit ?',
          after,
          REBUILD_BATCH,
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          after = Number(row.id);
          const [entry] = this.#entryRecords(String(row.conversation_id), [row]);
          if (entry) this.#index(after, entry.text);
        }
      }
      return Number(this.#database.get('select count(*) as n from entries_fts_docsize')?.n);
    });
  }
}
