import type {
  ConversationRecord,
  JournalEntry,
  ScheduleRecord,
  TranscriptEntry,
  WorkItem,
} from '../types.ts';
import { buildSearchQuery, containsPattern, indexText } from './searchText.ts';
import { openStateDatabase, type StateDatabase, type StateDatabaseMode } from './stateDatabase.ts';

/**
 * SPEC-014 FR-3 and FR-5 to FR-10: a bot's records in its state database.
 *
 * This is what the rest of the core uses; the adapter under it stays inside the store. Every
 * record is kept as the JSON it was given and comes back as that JSON parsed, so a field
 * this version does not know survives. The columns beside it only find and order records.
 */

/** A journal line other than a work item or a schedule: evidence the core does not read back. */
export type StateEvent = Exclude<JournalEntry, { type: 'work' } | { type: 'schedule' }>;

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
  /** All of `work` or none of it; see `StateDatabase.transaction`. */
  transaction<T>(work: () => T): T;
  /** Several reads against one snapshot. */
  snapshot<T>(work: () => T): T;
  close(): void;

  /** Every conversation record as stored, in no particular order. */
  conversations(): unknown[];
  saveConversation(record: ConversationRecord): void;
  /**
   * FR-5: the record with its entries, their index rows, its presentations, and its work
   * items with their transitions, in one transaction. Schedules are the caller's to cancel.
   */
  deleteConversation(id: string): void;

  /** The whole transcript in `seq` order. */
  entries(conversationId: string): TranscriptEntry[];
  /** FR-10: the newest entries, or the ones before a `seq`, in `seq` order. */
  entriesPage(conversationId: string, page: EntriesPage): TranscriptEntry[];
  /** FR-5 and FR-9: stored with the next `seq` and indexed in the same transaction. */
  appendEntry(conversationId: string, entry: Omit<TranscriptEntry, 'seq'>): TranscriptEntry;

  /** FR-6: one row per reply presentation. */
  responses(conversationId: string): TranscriptEntry[];
  saveResponse(conversationId: string, entry: TranscriptEntry): void;

  workItems(): WorkItem[];
  /** FR-7: the current state and the transition, in one transaction. */
  saveWorkItem(item: WorkItem, at: string): void;
  /** Every recorded state of one work item, oldest first. */
  workItemHistory(id: string): WorkItem[];
  schedules(): ScheduleRecord[];
  saveSchedule(schedule: ScheduleRecord): void;
  appendEvent(event: StateEvent): void;

  /** FR-8: entries holding every word of `query`, best match first. */
  search(query: string, options?: SearchOptions): SearchHit[];
  /** FR-9: throws the index away and builds it again from the entries. Returns how many it indexed. */
  rebuildIndex(): number;
}

export interface OpenBotStateStoreOptions {
  file: string;
  mode: StateDatabaseMode;
  busyTimeoutMs?: number;
  now?: () => Date;
}

export function openBotStateStore(options: OpenBotStateStoreOptions): BotStateStore {
  return new Store(openStateDatabase(options));
}

const DEFAULT_SEARCH_LIMIT = 50;
const REBUILD_BATCH = 500;
const SEARCH_BATCH = 200;

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function parse<T>(json: unknown): T {
  return JSON.parse(String(json)) as T;
}

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

class Store implements BotStateStore {
  private readonly database: StateDatabase;

  constructor(database: StateDatabase) {
    this.database = database;
  }

  get mode(): StateDatabaseMode {
    return this.database.mode;
  }

  transaction<T>(work: () => T): T {
    return this.database.transaction(work);
  }

  snapshot<T>(work: () => T): T {
    return this.database.snapshot(work);
  }

  close(): void {
    this.database.close();
  }

  conversations(): unknown[] {
    return this.database
      .all('select json from conversations')
      .map((row) => parse<unknown>(row.json));
  }

  saveConversation(record: ConversationRecord): void {
    this.database.run(
      `insert into conversations(id, role, updated_at, json) values (?, ?, ?, ?)
       on conflict(id) do update set role = excluded.role, updated_at = excluded.updated_at, json = excluded.json`,
      record.id,
      text(record.role),
      text(record.updatedAt),
      JSON.stringify(record),
    );
  }

  deleteConversation(id: string): void {
    this.database.transaction(() => {
      this.database.run(
        'delete from entries_fts where rowid in (select id from entries where conversation_id = ?)',
        id,
      );
      this.database.run('delete from entries where conversation_id = ?', id);
      this.database.run('delete from responses where conversation_id = ?', id);
      this.database.run(
        'delete from work_events where work_item_id in (select id from work_items where conversation_id = ?)',
        id,
      );
      this.database.run('delete from work_items where conversation_id = ?', id);
      this.database.run('delete from conversations where id = ?', id);
    });
  }

  entries(conversationId: string): TranscriptEntry[] {
    return this.database
      .all('select json from entries where conversation_id = ? order by seq, id', conversationId)
      .map((row) => parse<TranscriptEntry>(row.json));
  }

  entriesPage(conversationId: string, page: EntriesPage): TranscriptEntry[] {
    const count = limit(page.limit, 'limit');
    const rows =
      page.beforeSeq === undefined
        ? this.database.all(
            'select json from entries where conversation_id = ? order by seq desc, id desc limit ?',
            conversationId,
            count,
          )
        : this.database.all(
            'select json from entries where conversation_id = ? and seq < ? order by seq desc, id desc limit ?',
            conversationId,
            page.beforeSeq,
            count,
          );
    return rows.reverse().map((row) => parse<TranscriptEntry>(row.json));
  }

  appendEntry(conversationId: string, entry: Omit<TranscriptEntry, 'seq'>): TranscriptEntry {
    return this.database.transaction(() => {
      const last = this.database.get(
        'select max(seq) as seq from entries where conversation_id = ?',
        conversationId,
      )?.seq;
      const full: TranscriptEntry = { ...entry, seq: (typeof last === 'number' ? last : 0) + 1 };
      const id = this.database.insert(
        'insert into entries(conversation_id, seq, kind, origin, at, work_item_id, json) values (?, ?, ?, ?, ?, ?, ?)',
        conversationId,
        full.seq,
        text(full.kind),
        text(full.origin),
        text(full.at),
        text(full.workItemId),
        JSON.stringify(full),
      );
      this.index(id, full.text);
      return full;
    });
  }

  private index(rowid: number, body: unknown): void {
    if (typeof body !== 'string' || body === '') return;
    this.database.run(
      'insert into entries_fts(rowid, terms) values (?, ?)',
      rowid,
      indexText(body),
    );
  }

  responses(conversationId: string): TranscriptEntry[] {
    return this.database
      .all(
        'select json from responses where conversation_id = ? order by seq, presentation_id',
        conversationId,
      )
      .map((row) => parse<TranscriptEntry>(row.json));
  }

  saveResponse(conversationId: string, entry: TranscriptEntry): void {
    const presentation = entry.presentation as { id?: unknown; phase?: unknown } | undefined;
    if (typeof presentation?.id !== 'string' || presentation.id === '') {
      throw new TypeError('A reply presentation needs an id');
    }
    this.database.run(
      `insert into responses(conversation_id, presentation_id, seq, work_item_id, revision, phase, json)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict(conversation_id, presentation_id) do update set seq = excluded.seq,
         work_item_id = excluded.work_item_id, revision = excluded.revision, phase = excluded.phase, json = excluded.json`,
      conversationId,
      presentation.id,
      integer(entry.seq),
      text(entry.workItemId),
      integer(entry.presentationRevision),
      text(presentation.phase),
      JSON.stringify(entry),
    );
  }

  workItems(): WorkItem[] {
    return this.database
      .all('select json from work_items order by created_at, id')
      .map((row) => parse<WorkItem>(row.json));
  }

  saveWorkItem(item: WorkItem, at: string): void {
    const json = JSON.stringify(item);
    this.database.transaction(() => {
      this.database.run(
        `insert into work_items(id, conversation_id, kind, state, created_at, updated_at, source_ref, json)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set conversation_id = excluded.conversation_id, kind = excluded.kind,
           state = excluded.state, created_at = excluded.created_at, updated_at = excluded.updated_at,
           source_ref = excluded.source_ref, json = excluded.json`,
        item.id,
        text(item.conversationId),
        text(item.kind),
        text(item.state),
        text(item.createdAt),
        text(item.updatedAt),
        text(item.sourceRef),
        json,
      );
      this.database.run(
        'insert into work_events(work_item_id, at, state, json) values (?, ?, ?, ?)',
        item.id,
        at,
        text(item.state),
        json,
      );
    });
  }

  workItemHistory(id: string): WorkItem[] {
    return this.database
      .all('select json from work_events where work_item_id = ? order by id', id)
      .map((row) => parse<WorkItem>(row.json));
  }

  schedules(): ScheduleRecord[] {
    return this.database
      .all('select json from schedules order by id')
      .map((row) => parse<ScheduleRecord>(row.json));
  }

  saveSchedule(schedule: ScheduleRecord): void {
    this.database.run(
      `insert into schedules(id, conversation_id, state, next_at, json) values (?, ?, ?, ?, ?)
       on conflict(id) do update set conversation_id = excluded.conversation_id, state = excluded.state,
         next_at = excluded.next_at, json = excluded.json`,
      schedule.id,
      text(schedule.conversationId),
      text(schedule.state),
      text(schedule.nextAt),
      JSON.stringify(schedule),
    );
  }

  appendEvent(event: StateEvent): void {
    this.database.run(
      'insert into events(at, type, json) values (?, ?, ?)',
      text(event.at),
      text(event.type),
      JSON.stringify(event),
    );
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const built = buildSearchQuery(query);
    if (!built) return [];
    const count = limit(options.limit ?? DEFAULT_SEARCH_LIMIT, 'limit');
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (built.match) {
      conditions.push('entries_fts match ?');
      parameters.push(built.match);
    }
    if (options.conversationId !== undefined) {
      conditions.push('e.conversation_id = ?');
      parameters.push(options.conversationId);
    }
    // A single CJK character: a first cut over the whole record in SQL, where JSON keeps
    // such a character as written, then the exact test on the text below. Asking SQLite
    // for the text itself would stop at a NUL character.
    for (const character of built.contains) {
      conditions.push(`e.json like ? escape '\\'`);
      parameters.push(containsPattern(character));
    }
    const sql = built.match
      ? `select e.conversation_id as conversation_id, e.json as json
         from entries_fts join entries e on e.id = entries_fts.rowid
         where ${conditions.join(' and ')} order by bm25(entries_fts), e.id desc limit ? offset ?`
      : `select e.conversation_id as conversation_id, e.json as json
         from entries e where ${conditions.join(' and ')} order by e.id desc limit ? offset ?`;
    const batch = built.contains.length > 0 ? Math.max(count, SEARCH_BATCH) : count;
    const found: SearchHit[] = [];
    return this.database.snapshot(() => {
      for (let offset = 0; ; offset += batch) {
        const rows = this.database.all(sql, ...parameters, batch, offset);
        for (const row of rows) {
          const entry = parse<TranscriptEntry>(row.json);
          const body = typeof entry.text === 'string' ? entry.text : '';
          if (!built.contains.every((character) => body.includes(character))) continue;
          found.push({ conversationId: String(row.conversation_id), entry });
          if (found.length === count) return found;
        }
        if (rows.length < batch) return found;
      }
    });
  }

  rebuildIndex(): number {
    return this.database.transaction(() => {
      this.database.run('delete from entries_fts');
      let indexed = 0;
      let after = 0;
      for (;;) {
        const rows = this.database.all(
          'select id, json from entries where id > ? order by id limit ?',
          after,
          REBUILD_BATCH,
        );
        if (rows.length === 0) return indexed;
        for (const row of rows) {
          after = Number(row.id);
          const body = parse<{ text?: unknown }>(row.json).text;
          if (typeof body === 'string' && body !== '') indexed += 1;
          this.index(after, body);
        }
      }
    });
  }
}
