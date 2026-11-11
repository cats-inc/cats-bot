# ADR-021: Keep Each Bot's State in a SQLite Database

> Replace the per-file JSON/JSONL store with one database per bot, keeping the
> single-writer and upgrade rules of ADR-001 §6.

## Status

Accepted, 2026-11-11. The owner chose the proposed decision. The work is
[PLAN-014](../plans/PLAN-014-bot-state-database-and-memory.md) P1 and is in progress: the store
is being built beside the files, and nothing in the core uses it yet.

When P1 lands, this replaces the storage mechanics of
[ADR-001](001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md) §6
and the layout and write rules of
[SPEC-001](../specs/SPEC-001-resident-bot-core-and-global-execution.md) FR-2 and FR-3. Both
carry a pending-change note.

## Context

Bot stores a conversation as several files:

- `transcripts/<id>.jsonl` holds the bubbles;
- `presentations/<id>.json` (plus `.bak`) holds each reply's block structure;
- `conversations/<id>.json` holds the attachment;
- `journal.jsonl` holds every work-item and schedule transition.

JSONL is a sound log format: append-only, a torn last line is skippable, and it is readable.
The problems come from using it as the database
([survey](../research/2026-11-11-agent-memory-architecture-survey.md)):

- `transcript(id)` reads and parses the whole file on every call, several times per turn.
- `savePresentation` rereads and rewrites the whole presentation file and its backup up to
  every 100 ms while a reply streams. The file holds every reply ever made.
- The journal re-appends the whole work item per transition and is replayed at every
  start, with no compaction. One mostly idle development bot reached 347 KB in 8.5 days,
  then added 23 KB in five hours.
- There is no index. Memory and recall
  ([ADR-022](022-give-each-bot-layered-memory-it-consolidates-while-asleep.md)) need
  full-text search, including Chinese.

OpenClaw and Hermes Agent moved queryable history from JSONL to SQLite; Paperclip keeps it
in PostgreSQL. The shipped Electron 41.2.0 includes Node 24.14.0's `node:sqlite` with SQLite
3.51.2, FTS5 and the trigram tokenizer, so no native module is needed. A file-backed WAL
database behaved correctly on Windows.

## Decision

The following is proposed.

1. **One database per bot**, `<bot root>/bot.db`.
   - Mode: WAL, `synchronous=NORMAL`, a busy timeout.
   - The core holding the instance lock is the only writer. Hosts and the `cats-bot` CLI
     keep reaching data through `BotHostApi`, not the file.
   - Proposed clarification, 2026-11-11, waiting for the owner (SPEC-014 Open Questions): a
     core opened without the lock, as the CLI's read commands open one, reads the database
     through a reader connection that accepts only queries and never creates the file.
2. **Moved into the database**: conversation records and attachments, transcript entries,
   reply presentations, work items, their transitions, and schedules.
   - Small separately owned files stay files: `profile.json` (only its schema version is
     raised, item 7), secrets, locks, `life.json`, shell state and Telegram state.
3. **Write rules.**
   - Transcript entries are evidence: appended with a per-conversation `seq`, never updated.
     They are removed only when their conversation is deleted.
   - A presentation is one row per reply, upserted.
   - A work item is one current-state row plus an appended transition row, written in one
     transaction.
   - Startup reads current rows instead of replaying history.
4. **A full-text index** is part of the store. Han, Kana and Hangul runs are indexed as
   overlapping bigrams beside the normal text, because trigram and unicode61 miss
   2-character Chinese words. SPEC-014 defines it.
   - Proposed clarification, 2026-11-11, waiting for the owner (SPEC-014 Open Questions):
     one rewritten form of the text is indexed, not the normal text with a second form
     beside it, and a single character is found through the index as well.
5. **Engine.** `node:sqlite` sits behind a small adapter module, because the API is still
   experimental in Node 24. `better-sqlite3` is the fallback if acceptance fails, at the
   cost of an Electron-ABI native build.
6. **One-time migration** by the lock holder on first start of the new version:
   - back up the version-1 files;
   - import them;
   - verify every entry, presentation, work item and schedule against the source;
   - commit a completion marker;
   - move the originals to an archive (never delete them).

   - **Failure**: the version-1 files remain authoritative, the core refuses to start with a
     report, and restoring needs the bot to be stopped.
   - **Crash after the marker**: the database is authoritative. Any version-1 files still in
     place are never read again; the next start finishes moving them to the archive.

   The shape follows OpenClaw's verified import and Bot's own `profile.json.v1.bak`
   precedent.
7. **Version boundary.** This is a persisted-data change, so it ships in the next minor
   version, with release and migration notes in the bump.
   - An older binary cannot read `bot.db`. Left alone, it would start a blank bot on the
     migrated root.
   - So the migration also raises `profile.json`'s schema version, which older binaries
     already refuse to load. They stop instead.
   - Returning to an older version means restoring the archive while stopped.
8. **No automatic deletion of evidence.** A JSONL export of a conversation stays available
   for portability.

## Consequences

### Positive

- Appends, latest-N reads and paging stay cheap as history grows. Startup no longer
  replays the journal.
- Streaming no longer rewrites the whole presentation history.
- Full-text recall, including Chinese, becomes possible for ADR-022.
- One transaction covers what now spans several files.

### Negative

- The store becomes a binary file. Hand inspection needs SQLite tooling or the export.
- `node:sqlite` is experimental, so the adapter must absorb API changes.
- Migration is a risky one-time step, and older binaries cannot read the new store.
- WAL adds `-wal`/`-shm` files beside the database. Backup tools must copy them, or use the
  store's own snapshot.

### Neutral

- Runtime's own session history and the provider CLIs' files are unchanged (Runtime ADR-012).
- `BotHostApi` stays the only access path for hosts. Paging is an additive capability.

## Alternatives Considered

### Keep JSONL and add a rebuildable SQLite index

- **Pros**: smallest change; files stay human-readable.
- **Cons**: whole-file presentation rewrites, journal replay and per-call full reads remain;
  two stores can disagree.
- **Why rejected**: it fixes search but not the access patterns.

### One database per conversation

- **Pros**: deleting a conversation is deleting a file.
- **Cons**: cross-conversation recall and work items need every file open; more handles
  and migrations.
- **Why rejected**: recall and the journal are bot-wide.

### Embedded PostgreSQL or another engine

- **Pros**: richer full-text search (`pg_trgm`), as Paperclip uses.
- **Cons**: a separate server process per bot, a large footprint, and more failure modes
  for a resident desktop bot.
- **Why rejected**: disproportionate for one owner's data.

## References

- [Agent memory architecture survey](../research/2026-11-11-agent-memory-architecture-survey.md)
- [SPEC-014: Bot state database and migration](../specs/SPEC-014-bot-state-database-and-migration.md)
- [PLAN-014: Bot state database and memory](../plans/PLAN-014-bot-state-database-and-memory.md)
- [ADR-001 §6](001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md)
- Runtime [ADR-012](https://github.com/cats-inc/cats-runtime/blob/main/docs/decisions/012-separate-evidence-memory-and-retrieval-layers.md)

---

*Decision made: 2026-11-11*
*Decision makers: owner (chose the proposed decision); drafted by Claude*
