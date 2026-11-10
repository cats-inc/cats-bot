# SPEC-014: Bot State Database and Migration

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Approved by the owner on 2026-11-11 with [ADR-021](../decisions/021-keep-each-bots-state-in-a-sqlite-database.md) and the proposed answers to its open questions. Not implemented ([PLAN-014](../plans/PLAN-014-bot-state-database-and-memory.md) P1) |
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

1. FR-1: The database is `<bot root>/bot.db`, opened in WAL mode with `synchronous=NORMAL`
   and a busy timeout. Only the core holding the instance lock opens it for writing. Other
   processes reach data through `BotHostApi`. The restore command (FR-12) runs only while
   the bot is stopped.
2. FR-2: All access goes through one adapter module that wraps `node:sqlite`. No other module
   imports the driver, so `better-sqlite3` can replace it if acceptance fails. The adapter
   records the driver and SQLite versions in `meta`.
3. FR-3: Tables (conceptual; exact columns are a PLAN-014 decision):
   - `meta`: schema version, migration record, driver versions;
   - `conversations`: the conversation record and its attachment (today's
     `conversations/<id>.json`);
   - `entries`: transcript entries keyed by (conversation id, seq), with kind, origin, time,
     text and the existing optional fields;
   - `responses`: one row per reply presentation, keyed by presentation id, with revision
     and phase;
   - `work_items`: the current state of each work item, and `work_events`: its transitions;
   - `schedules`: the current state of each schedule;
   - `entries_fts`: the full-text index of FR-8.
4. FR-4: Every table carries the schema version through `meta`. An unknown newer version
   stops the core with a clear error and changes nothing.

#### Writes

5. FR-5: Entries are evidence.
   - They are inserted with the next `seq` and never updated.
   - Deleting a conversation (SPEC-001 FR-14) deletes its rows, presentations and index
     rows in one transaction, after Runtime's close and delete.
6. FR-6: A presentation checkpoint upserts its one `responses` row. Throttling stays as
   today (100 ms), and the cost no longer grows with the number of past replies.
7. FR-7: A work-item transition updates `work_items` and appends `work_events` in one
   transaction. Startup reads `work_items` and `schedules` directly.
   - For items completed more than 30 days ago, all but the last transition row may be
     pruned.
   - The `work_items` row itself is never deleted, except with its conversation (FR-5).

#### Search

8. FR-8: Every entry's text is indexed twice in an external-content FTS5 table:
   - as written, with `unicode61`;
   - with each Han, Kana and Hangul run rewritten as overlapping 2-character tokens.

   Queries build the bigram form the same way and rank with BM25. A query made only of
   single CJK characters uses `LIKE`. Results carry kind and origin, so callers can drop
   tool output and other bots' messages (SPEC-015 trust levels).
9. FR-9: The index is maintained in the same transaction as the entry. Rebuilding it from
   `entries` is a supported maintenance command.

#### Reads

10. FR-10: `BotHostApi` keeps `conversationTranscript` with its 4 MB budget, and adds a paged
    read: newest N, or N before a `seq`. The note loads the newest page and pages back on
    scroll. Existing callers keep working.

#### Migration

11. FR-11: On the first start of the new version, the lock holder migrates a version-1 data
    root:
    - It copies the version-1 files into `migration-backup/<timestamp>/`.
    - It imports conversations, transcripts (keeping `seq`), presentations and the journal.
      The journal is imported as current rows plus transitions.
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

- `node:sqlite` in Electron 41 (Node 24.14, experimental), FTS5 and the trigram tokenizer
  (SQLite 3.51.2).
- [ADR-021](../decisions/021-keep-each-bots-state-in-a-sqlite-database.md),
  [PLAN-014](../plans/PLAN-014-bot-state-database-and-memory.md) P1.

## Open Questions

All were answered on 2026-11-11 with the proposed options:

- [x] ADR-021: accepted.
- [x] Engine: `node:sqlite` behind an adapter; `better-sqlite3` only if acceptance fails.
- [x] Completed work-item transitions are pruned to their last row after 30 days (FR-7).
- [x] No archiving of old conversations until a size problem is observed (FR-15).

## References

- [Agent memory architecture survey](../research/2026-11-11-agent-memory-architecture-survey.md)
- [SPEC-001](SPEC-001-resident-bot-core-and-global-execution.md) FR-2, FR-12, FR-14

---

*Created: 2026-11-11*
*Author: Claude*
*Related Plan: [PLAN-014](../plans/PLAN-014-bot-state-database-and-memory.md)*
