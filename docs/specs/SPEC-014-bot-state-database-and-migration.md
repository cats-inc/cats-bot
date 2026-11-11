# SPEC-014: Bot State Database and Migration

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Approved by the owner on 2026-11-11 with [ADR-021](../decisions/021-keep-each-bots-state-in-a-sqlite-database.md) and the proposed answers to its open questions. Amendments to FR-1 to FR-4, FR-7 to FR-9, FR-11 and the dependencies, from what building P1 found, were accepted by the owner the same day: each amended requirement is marked, and Open Questions lists them all. In progress: the driver, adapter, schema, store and search exist and nothing uses them yet ([PLAN-014](../plans/PLAN-014-bot-state-database-and-memory.md) P1) |
| **Owner** | Bot core store |
| **Reviewer** | Owner; independent review of the migration before release |
| **Updates when implemented** | SPEC-001 FR-2 (data layout), FR-3 (write mechanics), FR-12 (transcript storage), FR-14 (deletion); ADR-001 §6 mechanics |

## Summary

Each bot keeps its conversations, reply presentations, work items and schedules in one
SQLite database instead of JSON and JSONL files. Evidence is appended, current state is
updated in place, and a full-text index covers Chinese as well as English. A one-time,
verified migration moves existing bots over without losing or rewriting their history.

## Goals

- Appending an entry, reading the newest entries and paging back stay cheap as history
  grows.
- No whole-file rewrite while a reply streams, and no journal replay at startup.
- Full-text search over transcript entries, including 2-character Chinese words.
- Existing bots migrate once, with verification, a backup and a restore path.

## Non-Goals

- Changing secrets, locks, `life.json`, shell or Telegram state files, or `profile.json`
  beyond the schema-version raise of FR-11.
- Changing Runtime's session history or provider CLI files.
- Memory records and consolidation ([SPEC-015](SPEC-015-bot-memory-layers-recall-and-consolidation.md)).
- Embeddings or vector search.

## Requirements

### Functional Requirements

#### Database

1. FR-1 *(amended 2026-11-11 and accepted by the owner; see Open Questions)*: The database is `<bot root>/bot.db`, opened in WAL mode with
   `synchronous=NORMAL` and a busy timeout.
   - Only the core holding the instance lock opens it for writing, and only it changes rows.
     A host that takes the lock for one write while the bot is stopped (the CLI's
     `schedule add` and `schedule cancel`) is that writer for as long as it holds the lock.
   - Other processes reach data through `BotHostApi`. A core opened without the lock, which
     is how the CLI's `status`, `conversations` and `schedule list` read today, reads
     through a **reader connection**: it never creates the file, accepts only queries, and
     is closed as soon as the read is done.
   - A reader changes no row. SQLite may finish a pending checkpoint when a reader is the
     last connection to close.
   - Every host closes its connection before a bot root is renamed or removed; Windows
     refuses both while one is open.
   - The restore command (FR-12) runs only while the bot is stopped.
2. FR-2 *(amended 2026-11-11 and accepted by the owner; see Open Questions)*: All access goes through one adapter module, built on a driver module
   that is the only one to name `node:sqlite`, so `better-sqlite3` can replace it if
   acceptance fails. No module outside the store reaches either of them. The adapter
   records the Node.js, Electron, SQLite and Unicode versions of the last writer in
   `meta`.
3. FR-3 *(amended 2026-11-11 and accepted by the owner; see Open Questions)*: Tables (conceptual; exact columns are a PLAN-014 decision). Each table
   keeps its record as JSON text; the other columns are derived from it for lookups and
   may be empty.
   - `meta`: schema version, migration record, the versions of FR-2, and the number of
     the way text is indexed (FR-9);
   - `conversations`: the conversation record and its attachment (today's
     `conversations/<id>.json`);
   - `entries`: transcript entries keyed by (conversation id, seq), with kind, origin, time,
     text and the existing optional fields. An entry's row id is never reused;
   - `responses`: one row per reply presentation, keyed by conversation and presentation
     id, with revision and phase;
   - `work_items` and `schedules`: the current state of each work item and schedule;
   - `journal`: every line of today's journal, in the order it was written: each state a
     work item or a schedule went through, and presence, runtime, heartbeat,
     configuration and Boss Cat tool calls. A line is never changed; it leaves only by
     FR-7's pruning or with its conversation;
   - `entries_fts`: the full-text index of FR-8.
4. FR-4 *(amended 2026-11-11 and accepted by the owner; see Open Questions)*: Every table carries the schema version through `meta`. An unknown newer
   version stops the core with a clear error and changes no row, table or setting. A file
   that is not a bot state database is refused the same way.

#### Writes

5. FR-5: Entries are evidence.
   - They are inserted with the next `seq` and never updated.
   - Deleting a conversation (SPEC-001 FR-14) deletes its rows, presentations and index
     rows in one transaction, after Runtime's close and delete.
6. FR-6: A presentation checkpoint upserts its one `responses` row. Throttling stays as
   today (100 ms), and the cost no longer grows with the number of past replies.
7. FR-7 *(amended 2026-11-11 and accepted by the owner; see Open Questions)*: A work-item transition updates `work_items` and appends its line to
   `journal` in one transaction, and a schedule change does the same with `schedules`.
   Startup reads `work_items` and `schedules` directly.
   - For items completed more than 30 days ago, all but the last of an item's journal
     lines may be pruned.
   - The `work_items` row itself is never deleted, except with its conversation (FR-5).

#### Search

8. FR-8 *(amended 2026-11-11 and accepted by the owner; see Open Questions)*: Every entry's text is indexed in a contentless FTS5 table
   (`contentless_delete`), keyed by the entry's row id. Before it is indexed the text is
   rewritten:
   - characters that are never shown are dropped, and so is the dot Chinese writes
     between the parts of a name inside a CJK run; a byte-order mark is a space;
   - a symbol, or a number that is neither a plain digit nor raised or lowered, stands
     apart from the words beside it;
   - compatibility forms are folded together (NFKC), except the Hangul letters people
     type on their own, and letters are lower-cased;
   - whatever is then not a letter, a number or a mark is a space, and a mark with no
     letter to sit on is dropped;
   - each Han, Kana, Hangul and Bopomofo run becomes its overlapping 2-character tokens,
     followed by its last character.

   A query is rewritten the same way and ranks with BM25. Every word typed must be
   present, each as one phrase; CJK punctuation, and any punctuation next to a CJK run,
   parts two words as a space does. A single CJK character is found through the index too: it is the first character
   of a token or the last character of its run. A query of more than 200 characters or
   12 different words is refused. Results carry kind and origin, so callers can drop tool
   output and other bots' messages (SPEC-015 trust levels).
9. FR-9 *(amended 2026-11-11 and accepted by the owner; see Open Questions)*: The index is maintained in the same transaction as the entry. Rebuilding
   it from the entries' JSON records is a supported maintenance command. It does not read
   the index, so it repairs a damaged one. A writer runs it by itself when the way text
   is rewritten has changed since the index was made, and a reader that finds such an
   index refuses to search it.

#### Reads

10. FR-10: `BotHostApi` keeps `conversationTranscript` with its 4 MB budget, and adds a paged
    read: newest N, or N before a `seq`. The note loads the newest page and pages back on
    scroll. Existing callers keep working.

#### Migration

11. FR-11 *(amended 2026-11-11 and accepted by the owner; see Open Questions)*: On the first start of the new version, the lock holder migrates a
    version-1 data root:
    - It copies the version-1 files into `migration-backup/<timestamp>/`.
    - It imports conversations, transcripts (keeping `seq`), presentations and the journal.
      The journal is imported line by line, in its order, and the last state of each work
      item and schedule becomes its current row.
    - It verifies the import:
      - every source entry, presentation, work item and schedule is present and equal;
      - counts match per conversation;
      - torn or corrupt source lines are counted and reported, never dropped silently.
    - It writes the completion marker in `meta` in the same transaction as the last import
      batch, with `synchronous=FULL` for that commit.
    - It raises `profile.json`'s schema version through the existing validated, backed-up
      replacement. Older binaries already refuse an unknown profile schema, so they stop
      instead of starting a blank bot on the migrated root.
    - It then moves the version-1 files to `archive/v1/`.
    - **Crash before the marker**: the version-1 files stay authoritative, and the next start
      repeats the migration from a fresh database.
    - **Crash after the marker**: the database is authoritative and version-1 files are never
      read again. The next start finishes the profile raise and the archive move,
      idempotently.
12. FR-12: If the import or verification fails:
    - the core writes a JSON and Markdown report beside the backup;
    - the core does not start;
    - `bot.db` is removed;
    - the version-1 files stay untouched.

    A `cats-bot restore` command, run while the bot is stopped, puts back the version-1 files
    from the backup or archive, for a failed migration or a downgrade. Data written after a
    successful migration is not visible to an older binary; the notes say so.

#### Safety and export

13. FR-13: Once a day, while idle, the core writes a consistent snapshot with
    `VACUUM INTO` to `backups/` and keeps the last three. Startup runs `PRAGMA quick_check`.
    A failure stops the core with a report and the newest snapshot's path.
14. FR-14: `cats-bot export <conversation>` writes the conversation as JSONL entries plus
    presentations, for portability and inspection.
15. FR-15: No automatic deletion of evidence. Retention beyond conversation deletion is a
    later decision.

### Non-Functional Requirements

- **Performance**: on the reference Windows machine, with 1,000,000 entries:
  - append ≤ 5 ms at p95;
  - newest 50 entries ≤ 20 ms;
  - a 2-character Chinese query over the index ≤ 100 ms.
  - A 20,000-row probe returned the newest 50 in 0.33 ms.
- **Durability**: with WAL and `synchronous=NORMAL`, a power loss may roll back the most
  recent commits since the last sync, but never corrupts the database or leaves a
  half-applied transaction. This is no weaker than today's appends without fsync. The
  migration commit uses `synchronous=FULL`.
- **Compatibility**: this is a persisted-data change and ships in the next minor version,
  with release and migration notes in the bump. No bump is part of this spec.
- **Portability**: Windows, macOS and Linux, under the shipped Electron's Node with
  `ELECTRON_RUN_AS_NODE`.

## Acceptance

- Migration of a copy of a real version-1 data root, with byte-for-byte equal exports
  before and after.
- Crash injection at each migration step, with the version-1 files intact and the next start
  succeeding.
- Corrupt-line handling, and an unknown schema version stopping the core.
- Deletion removing rows and index rows.
- Paging in the note.
- Chinese 1-, 2- and 3-character queries and an English query against a fixture
  conversation.
- WAL behaviour with a reader while a reply streams.
- `quick_check` failure and snapshot restore.
- The performance targets on the three platforms.

## Dependencies

- *(amended 2026-11-11 and accepted by the owner; see Open Questions)* `node:sqlite` in Electron 41 (Node 24.14, experimental), and FTS5 with
  `contentless_delete`, which needs SQLite 3.43 or later (Electron 41 has 3.51.2).
- [ADR-021](../decisions/021-keep-each-bots-state-in-a-sqlite-database.md),
  [PLAN-014](../plans/PLAN-014-bot-state-database-and-memory.md) P1.

## Open Questions

All were answered on 2026-11-11 with the proposed options:

- [x] ADR-021: accepted.
- [x] Engine: `node:sqlite` behind an adapter; `better-sqlite3` only if acceptance fails.
- [x] Completed work-item transitions are pruned to their last row after 30 days (FR-7).
- [x] No archiving of old conversations until a size problem is observed (FR-15).

Proposed on 2026-11-11, from what building PLAN-014 task 1.1 to 1.3 found, and accepted
by the owner the same day. The text above carries every one of them, marked at its
requirement.

Changes of design:

- [x] FR-1: a core opened without the lock reads through a reader connection. Accepted.
  - Why: such a core reads the files directly today, and the driver's own read-only open
    leaves `-shm` and `-wal` files beside a stopped bot on all three platforms.
  - The other option routes those reads through the running core's channel. It still
    needs the reader connection while the bot is stopped.
  - ADR-021 decision 1 gets the same clarification.
- [x] FR-3, with FR-7 and FR-11: JSON text as the record in every table, and one `journal`
  table holding every line of today's journal in order, in place of a `work_events`
  table for work-item transitions alone. Accepted.
  - Why JSON: the Node.js 24.14 driver in Electron 41 returns a TEXT value only up to its
    first NUL character, which JSON escapes; and a record keeps fields this version does
    not know.
  - Why one journal: the journal's other lines had no home; a schedule's history would
    have been dropped; and lines split over several tables could only be put back in
    order by their time, to the millisecond.
- [x] FR-8 and FR-9: a contentless index rebuilt from the JSON records, in place of an
  external-content one; one rewritten form of the text in place of the text as written
  beside a second form; and single characters found through the index, in place of
  `LIKE`. Accepted.
  - Why contentless: the indexed form of the text is produced in JavaScript and kept
    nowhere else. An external-content index needs a column that holds what it indexes,
    which would store every entry's text a second time, rewritten.
  - Why one rewritten form: `unicode61` splits on the punctuation of an old Unicode
    version only. It reads a CJK run and a Latin word written against it as one token, so
    `用iPhone拍照` could not be found by `iPhone`; an emoji written against a word became
    part of the word; and full-width or decomposed forms were different words. In every
    case tried, the rewritten form found what the as-written form found, and these as
    well.
  - Why no `LIKE`: it reads every entry. An independent review measured four minutes for
    one character in one conversation of 49,600 entries. With the last character of each
    run as a token, a single character is a prefix query on the index, and a phrase can
    no longer match across the punctuation between two runs.

Changes of wording that follow from the code, with no other decision in them:

- [x] FR-1 also names the writer the CLI is while it holds the lock for `schedule add` and
  `schedule cancel`, as today, and has every host close its connection before a bot root
  is moved.
- [x] FR-2: a driver module and an adapter module instead of one module, neither reachable
  from outside the store; `meta` records the Node.js, Electron, SQLite and Unicode
  versions.
- [x] FR-3: an entry's row id is never reused, and a presentation is keyed by its
  conversation as well as its id.
- [x] FR-4: "changes nothing" became "changes no row, table or setting". Opening a database
  that still has a write-ahead log makes SQLite fold that log into the file, even when
  the open is then refused, so the file's bytes can change while its content does not.
  A file that is not a bot state database is refused the same way.
- [x] Dependencies: no trigram tokenizer is used; `contentless_delete` needs SQLite 3.43.

## References

- [Agent memory architecture survey](../research/2026-11-11-agent-memory-architecture-survey.md)
- [SPEC-001](SPEC-001-resident-bot-core-and-global-execution.md) FR-2, FR-12, FR-14

---

*Created: 2026-11-11*
*Author: Claude*
*Related Plan: [PLAN-014](../plans/PLAN-014-bot-state-database-and-memory.md)*
