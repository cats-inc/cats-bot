/**
 * SPEC-014 FR-3: the tables of a bot's state database.
 *
 * Version 1 is provisional until a release ships it: no database exists outside tests, so a
 * change here needs no upgrade step yet.
 *
 * Every table keeps its record as JSON text. The other columns are derived from it for
 * lookups and ordering, and may be null when a record lacks the field: the driver the app
 * ships cuts a raw TEXT value at a NUL character, which JSON escapes, and a record with
 * fields this version does not know must come back unchanged.
 */

export const STATE_SCHEMA_VERSION = 1;

/** "CBOT": marks a SQLite file as a Cats Bot state database. */
export const STATE_APPLICATION_ID = 0x43424f54;

export const STATE_SCHEMA_SQL = `
create table meta(
  key text primary key not null,
  value text not null
) strict, without rowid;

create table conversations(
  id text primary key not null,
  role text,
  updated_at text,
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
  work_item_id text,
  json text not null,
  unique(conversation_id, seq)
) strict;

-- One row per reply presentation, replaced at each checkpoint (FR-6).
create table responses(
  conversation_id text not null,
  presentation_id text not null,
  seq integer,
  work_item_id text,
  revision integer,
  phase text,
  json text not null,
  primary key(conversation_id, presentation_id)
) strict;

-- The current state of each work item, and its transitions (FR-7).
create table work_items(
  id text primary key not null,
  conversation_id text,
  kind text,
  state text,
  created_at text,
  updated_at text,
  source_ref text,
  json text not null
) strict;
create index work_items_by_conversation on work_items(conversation_id, created_at);
create index work_items_by_source_ref on work_items(source_ref) where source_ref is not null;

create table work_events(
  id integer primary key,
  work_item_id text not null,
  at text,
  state text,
  json text not null
) strict;
create index work_events_by_item on work_events(work_item_id, id);

create table schedules(
  id text primary key not null,
  conversation_id text,
  state text,
  next_at text,
  json text not null
) strict;

-- What the journal recorded besides work items and schedules: presence, runtime, heartbeat,
-- configuration and Boss Cat tool calls. Appended, and read by nothing in the core.
create table events(
  id integer primary key,
  at text,
  type text,
  json text not null
) strict;

-- FR-8: the text as written, and the same text with each CJK run as two-character tokens.
-- Contentless: the index stores no copy of the text and is rebuilt from the entries' JSON.
create virtual table entries_fts using fts5(text, grams, content='', contentless_delete=1);
`;
