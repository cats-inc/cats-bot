/**
 * SPEC-014 FR-3: the tables of a bot's state database.
 *
 * Version 1 is provisional until a release ships it: no database exists outside tests, so a
 * change here needs no upgrade step yet.
 *
 * Every table keeps its record as JSON text. The other columns are derived from it to find
 * and order records, and may be null when a record lacks the field: the driver the app ships
 * cuts a raw TEXT value at a NUL character, which JSON escapes, and a record with fields this
 * version does not know must come back unchanged. A column is here only when a query or an
 * accepted requirement uses it.
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

-- One row per reply presentation, replaced at each checkpoint (FR-6).
create table responses(
  conversation_id text not null,
  presentation_id text not null,
  seq integer,
  revision integer,
  phase text,
  json text not null,
  primary key(conversation_id, presentation_id)
) strict;

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
`;
