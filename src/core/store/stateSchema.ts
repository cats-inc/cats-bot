/**
 * SPEC-014 FR-3: the tables of a bot's state database.
 *
 * No release has shipped a version yet. Version 1 was made by builds of `main` from the
 * cutover (PLAN-014) on; version 2 adds `responses.covers` and the indexes a page of the note
 * reads by (FR-10). A writer brings a version-1 database to version 2 when it opens it, in
 * one transaction (`STATE_SCHEMA_UPGRADES`), and a build that knows only version 1 refuses a
 * database of version 2.
 *
 * Every table keeps its record as JSON text. The other columns are derived from it to find
 * and order records, and may be null when a record lacks the field: the driver the app ships
 * cuts a raw TEXT value at a NUL character, which JSON escapes, and a record with fields this
 * version does not know must come back unchanged. A column is here only when a query or an
 * accepted requirement uses it.
 */

export const STATE_SCHEMA_VERSION = 2;

/** "CBOT": marks a SQLite file as a Cats Bot state database. */
export const STATE_APPLICATION_ID = 0x43424f54;

/**
 * FR-10: a page reads a conversation's presentations by `seq`, and finds those that reach
 * into it by the longest any of them covers (`covers - seq`) and then by `seq`.
 */
const RESPONSES_INDEXES = `create index responses_by_seq on responses(conversation_id, seq, covers);
create index responses_by_span on responses(conversation_id, (covers - seq));`;

/**
 * FR-10: whether a work item has a bot entry from a `seq` on, for a presentation that never
 * bound its final entry. The work item is read as `BOT_ENTRY_WORK_ITEM` reads it, which a
 * record that is not JSON leaves null instead of failing the write.
 */
export const BOT_ENTRY_WORK_ITEM = `(case when json_valid(json) then json_extract(json, '$.workItemId') end)`;
const ENTRIES_INDEXES = `create index entries_bot_by_work_item on entries(conversation_id, ${BOT_ENTRY_WORK_ITEM}, seq) where kind = 'bot';`;

export const STATE_SCHEMA_SQL = `
create table meta(
  key text primary key not null,
  value text not null
) strict, without rowid;

create table conversations(
  id text primary key not null,
  json text not null
) strict;

-- Evidence: inserted with the next seq and never updated (FR-5). The row id is never reused,
-- so an index row or a later reference cannot come to mean a different entry.
create table entries(
  id integer primary key autoincrement,
  conversation_id text not null,
  seq integer not null,
  kind text,
  origin text,
  at text,
  json text not null,
  unique(conversation_id, seq)
) strict;

-- One row per reply presentation, replaced at each checkpoint (FR-6). covers is the highest
-- seq it covers (responseCovers), so that a page of the note finds the presentations that
-- reach into it without reading them (FR-10).
create table responses(
  conversation_id text not null,
  presentation_id text not null,
  seq integer,
  revision integer,
  phase text,
  covers integer,
  json text not null,
  primary key(conversation_id, presentation_id)
) strict;
${RESPONSES_INDEXES}

-- The current state of each work item and schedule (FR-7). A row keeps the place it was
-- first given, which is the order the journal first named it in.
create table work_items(
  id text primary key not null,
  conversation_id text,
  state text,
  updated_at text,
  json text not null
) strict;
create index work_items_by_conversation on work_items(conversation_id);

create table schedules(
  id text primary key not null,
  conversation_id text,
  json text not null
) strict;

-- What is kept of a work item when its conversation is deleted (FR-7): no prompt, text or
-- reply, only what tells a delivery already handled from a new one and lets the hub be
-- answered about it.
create table deleted_work(
  id text primary key not null,
  source_ref text,
  delivery_id text
) strict;
create index deleted_work_by_source on deleted_work(source_ref) where source_ref is not null;
create index deleted_work_by_delivery on deleted_work(delivery_id) where delivery_id is not null;

-- Every line the journal holds, in the order it was written: each state of a work item or a
-- schedule, and presence, runtime, heartbeat, configuration and Boss Cat tool calls. ref is
-- the work item or schedule a line is about. Appended only; an id is never reused.
create table journal(
  id integer primary key autoincrement,
  at text,
  type text,
  ref text,
  json text not null
) strict;
create index journal_by_ref on journal(ref) where ref is not null;

-- FR-8: each entry's text as the store rewrites it for searching. Contentless: the index
-- stores no copy of the text and is rebuilt from the entries' JSON.
create virtual table entries_fts using fts5(terms, content='', contentless_delete=1);
${ENTRIES_INDEXES}
`;

/**
 * Version 1 to 2 (FR-10): the column and the indexes. The writer fills `covers` from each
 * presentation's JSON in the same transaction.
 */
export const STATE_SCHEMA_UPGRADES: Readonly<Record<number, string>> = {
  1: `alter table responses add column covers integer;
${RESPONSES_INDEXES}
${ENTRIES_INDEXES}`,
};

/**
 * FR-10: the highest `seq` a reply presentation covers: its own, those of the entries it
 * stands for, and its final entry's. Null when it has no `seq` of its own. What is not a
 * whole number is passed over, as the projection never matches it.
 */
export function responseCovers(response: unknown): number | null {
  if (typeof response !== 'object' || response === null) return null;
  const { seq, presentationSeqs, presentationTerminalSeq } = response as Record<string, unknown>;
  if (!Number.isSafeInteger(seq)) return null;
  let covers = seq as number;
  if (
    Number.isSafeInteger(presentationTerminalSeq) &&
    (presentationTerminalSeq as number) > covers
  ) {
    covers = presentationTerminalSeq as number;
  }
  // A loop: a long turn covers more seqs than a spread passes as arguments.
  if (Array.isArray(presentationSeqs)) {
    for (const covered of presentationSeqs) {
      if (Number.isSafeInteger(covered) && (covered as number) > covers) covers = covered as number;
    }
  }
  return covers;
}
