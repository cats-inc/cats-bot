# PLAN-014: Bot State Database and Memory

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Approved, 2026-11-11, with ADR-021 and ADR-022. P1 started 2026-11-11 with the driver acceptance of task 1.1; nothing is wired into the core yet. P2 onward wait for the security review and the Runtime prerequisites in P0 |
| **Owner** | Bot core store and memory |
| **Assigned To** | Unassigned |
| **Reviewer** | Owner; independent review per phase; independent security review before P2 |

## Related Spec

- [SPEC-014: Bot state database and migration](../specs/SPEC-014-bot-state-database-and-migration.md)
- [SPEC-015: Bot memory: layers, recall and consolidation](../specs/SPEC-015-bot-memory-layers-recall-and-consolidation.md)
- Decisions: [ADR-021](../decisions/021-keep-each-bots-state-in-a-sqlite-database.md),
  [ADR-022](../decisions/022-give-each-bot-layered-memory-it-consolidates-while-asleep.md)
- Evidence: [agent memory architecture survey](../research/2026-11-11-agent-memory-architecture-survey.md)

## Overview

The store comes first, because memory and recall need it, and it is useful on its own. Recall
tools come before anything automatic. Core memory and owner controls come before the bot
writes on its own. Consolidation and summaries wait for a Runtime capability and the
security review. Embeddings come only if the evaluation asks for them.

## Implementation Phases

### P0: Decisions and prerequisites

- [x] Owner decided ADR-021, which unblocks P1 (2026-11-11).
- [x] Owner chose ADR-022's proposed defaults (2026-11-11).
- [x] Owner accepted the amendments to SPEC-014 and ADR-021 that building P1 found: a
      reader connection for a core opened without the lock, JSON records and one
      `journal` table, and the search index of FR-8 and FR-9 (2026-11-11).
- [x] Owner: the next release from `main` is 0.6, the next minor line, so the cutover
      (1.6) may land on `main` when it is ready. The version bump and the publication
      still need the owner's release authorization (2026-11-11).
- [x] Owner: a slice nothing in the core uses yet merges once an independent review
      finds nothing that blocks it and CI passes on the three platforms. The cutover
      pull request waits for the owner's go, because it carries decisions of its own
      (2026-11-11).
- [ ] Independent security review of SPEC-015, before P2.
- [ ] Measure what session instructions cost per turn on each provider Bot supports. Every
      adapter composes them into every turn. The result sets SPEC-015 FR-5's final budget.
- [ ] Runtime: a **turn-scoped context** field, delivered for one execution and not persisted.
  - Specified in Runtime
    [SPEC-042](https://github.com/cats-inc/cats-runtime/blob/main/docs/specs/SPEC-042-turn-scoped-context.md)
    (approved 2026-11-11, not implemented).
  - Today a send's `instructions` replaces the session's.
  - It blocks P2.2, P3.2's live delta and P5.2's one-time handoff.
  - Bot must check the `turnContext` capability before using it, and keep each turn within
    the size Runtime reports for the target.
- [ ] Runtime: a **text-only session** on the providers bots use (SPEC-012 FR-13).
  - Specified in Runtime
    [SPEC-043](https://github.com/cats-inc/cats-runtime/blob/main/docs/specs/SPEC-043-text-only-sessions.md)
    (approved 2026-11-11, not implemented).
  - It has no tools, no MCP, no handoff and no provider-native memory, keeps no resumable
    native conversation, and is deletable with its content.
  - It blocks P4 and P5, and is shared with SPEC-012 Phase 2.
  - No CLI adapter qualifies yet. Runtime's first phase is per-provider research; API
    backends and claude are the first candidates, and codex and grok have no known
    mechanism.
  - Bot must check the `textOnly` capability and the create readback before it sends
    anything. An older Runtime would return an ordinary session.
- [ ] Runtime: **credentials stay out of the processes Runtime starts.**
  - Today a tool-capable process started by Runtime can read Runtime's environment. With
    Runtime's own API key it can also reach every target through the loopback API.
  - Runtime must keep its own key and backend credentials out of every child process, and
    let an instance admit only text-only sessions.
  - Specified in Runtime SPEC-043 R10 (accepted 2026-11-11, not implemented). It needs
    Runtime's next minor line.
  - It blocks P4.6 only.

### P1: State database (SPEC-014), depends only on ADR-021

- [x] 1.1 Storage adapter over `node:sqlite`, schema, and `meta` with versions; driver
      acceptance on Windows, macOS and Linux under the shipped Electron.
  - [x] Driver module and acceptance test: `src/core/store/sqliteDriver.ts` and
        `tests/core/sqliteDriver.test.ts`. CI runs the test under Node.js 24 and again
        inside Electron on the three platforms. Nothing uses the driver yet.
  - [x] Adapter, schema and `meta`: `src/core/store/stateDatabase.ts` and
        `stateSchema.ts`, with `tests/core/stateDatabase.test.ts`. `npm run test:electron`
        runs the store's tests inside Electron, and CI does so on the three platforms.
        Nothing uses the adapter yet.
    - Schema version 1 is provisional until a release ships it. No database exists
      outside tests, so a change needs no upgrade step yet.
    - Only the key columns and the JSON record are required. The derived index columns
      may be empty, so that a version-1 record lacking a field still imports unchanged.
    - Open for the importer (1.5): a version-1 transcript with a repeated `seq`. The
      schema keeps `(conversation, seq)` unique; one local data root had no repeat, gap
      or unreadable line, which is not proof that none exists elsewhere.
  - What the acceptance run found, and the defaults it proposed for the adapter. The ones
    that change SPEC-014 are in its Open Questions, accepted by the owner on 2026-11-11.
    - **Hosts that only read.** Today `BotCore.open` reads the files in its own process,
      without the lock (the CLI's `status`, `conversations` and `schedule list`). Accepted:
      such a host opens the database with `mode=rw` and `query_only`, reads, and closes.
      - The same host also writes while the bot is stopped: `schedule add` and
        `schedule cancel` take the instance lock for the write. The adapter has to give
        it a writer connection for as long as it holds the lock.
      - `query_only` rejects statements that change rows or the schema. It is not a
        read-only handle: SQLite still lets it run a checkpoint or change the journal
        mode, and a reader that closes last checkpoints the write-ahead log into `bot.db`
        and removes the `-wal` and `-shm` files. Rows never change. The adapter must not
        hand out a reader that accepts arbitrary statements.
      - The driver's read-only open left `-shm` and `-wal` files beside a cleanly stopped
        bot. An immutable open does no locking or change detection, which is unsafe when
        a writer may start at any time.
      - This amended SPEC-014 FR-1 and ADR-021 decision 1, which said other hosts reach
        data through `BotHostApi` and not the file.
    - **The record is JSON text**, and other columns only index it. JSON escapes NUL
      characters and lone surrogates. As raw TEXT, the Node.js 24.14 driver in Electron 41
      returns a value only up to its first NUL, and a lone surrogate is stored as U+FFFD.
      The index is rebuilt from the JSON, not from an indexed column.
    - **The index** is a contentless FTS5 table with `contentless_delete`, keyed by the
      entry's row id, over one rewritten form of the text. `unicode61` reads a CJK run
      and a Latin word written against it as one token, so indexing the text as written
      too adds nothing. SPEC-014 FR-8 said external-content and two forms.
    - **Changes read big integers.** After some deletes from the index, the last row id
      SQLite reports is one of the index's own, beyond 2^53. With the driver's default a
      statement that ran then throws on Node.js 26 and returns a number outside the
      safe range on Node.js 24. The adapter runs every change with big integers on and returns the
      number of rows changed; an insert's row id is a separate call.
    - **A snapshot starts at its first read**, not at `begin`, so the adapter reads once
      before it runs the work. A snapshot opened on its own is for reading and takes no
      change.
    - **Nested work fails the whole transaction only when it had changed rows.** Half of
      a change must not be kept by a caller that catches the error and carries on, while
      a read that failed, or a check that refused before anything was written, is the
      caller's to handle.
    - **The journal is one table**, every line in the order it was written, with the
      work item or schedule it is about. Work items and schedules keep a current row
      each, in the order they first appeared, which is the order today's replay gives.
      A column is in the schema only when a query or an accepted requirement uses it.
    - **SQLite can end a transaction by itself**, after a full disk or an `or rollback`
      conflict. Statements run after that would be committed one by one, so inside a
      transaction the adapter refuses them and reports the transaction as lost.
    - **The driver compiles only the first statement of a text** and says nothing about
      the rest, so the adapter takes one statement at a time.
    - **SQLite counts changed rows for an insert, an update or a delete only**, and keeps
      the last count through every other statement. The adapter's `run` therefore takes
      those three and nothing else; a pragma, a `create` or a `vacuum` gets a call of its
      own when a later task needs one.
    - **A pragma named with nothing after it is not always a read.** `optimize` writes
      statistics, also when a query calls it as a table, and `wal_checkpoint` moves the
      log into the file. The adapter's `get` and `all` read three settings by name, and
      refuse a query that holds an insert, an update, a delete or a pragma called as a
      table.
    - **The adapter's statement rules read text, and are not a parser.** They catch a
      statement given to the wrong call in the store's own source, where every
      statement is a constant with its values bound. The fourth review of the store got
      eleven statements past `get` and `all` on a writer, each written to do so: a
      comment between `replace` and `into`, a parameter written `$a(--)` before a
      `delete`, and a quoted `"pragma_optimize"`. A reader refused every one. `run`
      likewise took a query that only names a change, through a parameter called
      `:update`, and returned an earlier statement's count; and `or/**/fail` passed.
      - A later pull request, with its own review, can replace the rules with the
        driver's authorizer (`setAuthorizer`, present on both runtimes), which judges
        what SQLite compiled instead of the text. The review found that its allow-list
        has to let FTS5 run `pragma data_version`; the store's tests have not run
        under it.
    - **Snapshots.** `VACUUM INTO` does not replace an existing database, but it accepts an
      existing empty file and can leave a partial file when interrupted. A snapshot is
      written under a new name and renamed when complete.
    - **Windows handles.** An open connection blocks renaming or removing the bot root.
      Every host closes its connection before a root is moved, and a host that only reads
      holds one no longer than a read takes.
    - **UNC roots.** `pathToFileURL` gives a `file:` URL with a host, which SQLite rejects,
      so the adapter builds the URI for such a path by hand, and a stopped bot's database
      opens through one. That is all it shows. SQLite does not support WAL on a network
      file system, and on one machine a reader that opened the database through
      `\\localhost\C$` did not see what a writer on the local path committed afterwards.
      Open for the cutover: refuse a bot root on a UNC path, or give it another journal
      mode. Version-1 files work there today.
    - The test prints what each runtime does with a raw NUL and a read-only open in its
      `sqlite-driver runtime` line, in the CI log of every platform.
- [ ] 1.2 Move writers and readers:
  - conversations and attachments;
  - transcript entries (append-only `seq`);
  - presentations (row upsert, existing 100 ms throttle);
  - work items and transitions; schedules;
  - startup without journal replay.
  - [x] The store they move to: `src/core/store/stateStore.ts`, with
        `tests/core/stateStore.test.ts`. It keeps and returns every record as the JSON it
        was given, and checks nothing on the way out: the caller validates a conversation
        record or a reply presentation as it validates the file it reads today. Nothing in
        the core uses it yet.
    - An entry and its index row are written in one transaction, and a caller can put the
      conversation's own change in the same one. An entry or a presentation needs its
      conversation to exist, as `ConversationStore` requires today.
    - `appendJournal` takes a journal line as `appendJournal` in `journal.ts` does. A work
      item's or a schedule's line also becomes its current row in the same transaction.
    - Deleting a conversation also deletes its work items and their journal lines, which
      hold the owner's prompts (SPEC-014 FR-7). Today's journal keeps them. Schedules
      stay, for the caller to cancel as it does now.
    - It also answers what callers today read a whole transcript for: the last `seq`, and
      the entries after a `seq`.
  - [ ] The cutover: `ConversationStore`, the presentation store and the journal use it.
    Open for it, each needing the owner:
    - A turn that ends after its conversation was deleted still records its work item
      today. With the store that would bring back a row holding the prompt, which
      nothing deletes again.
    - Telling a delivery already handled from a new one, and answering the hub about a
      delivery, both read work items that outlive their conversation. FR-7 deletes them
      with it.
    - A cancelled schedule keeps its prompt for good, in its current row and in each of
      its journal lines, while a deleted conversation's work items lose theirs.
    - Startup reads every work item: 2.2 to 2.7 s for 287,000 of them. Today it replays
      the whole journal. The store has no way to ask for the unfinished ones alone.
    - Deleting a conversation is one transaction and takes seconds when it is large (see
      1.7); today it removes three files.
    - A record that cannot be read: a search still returns the entries of a conversation
      whose own record cannot be read, and a work item whose current row cannot be read
      is missing from the list while its journal lines remain. The import's check has to
      count any such warning as a failure.
    - Filling a page or a search past records that cannot be read asks again from the
      start for twice as many rows each time. In the fourth review a page of one entry
      took 1.2 s when all 20,000 entries of its conversation were unreadable, and a
      search took 0.45 s instead of 0.05 s when its newest 100 hits were.
    - A search across all conversations stops early when the index holds a row whose
      entry is gone. The store never leaves one; a damaged file can, and a rebuild of
      the index removes it.
    - A bot root on a UNC path (see 1.1).
    - What the import does with what it finds (proposed defaults; each one decides
      whether a bot starts on 0.6). The rule proposed: it stops only where a record
      shown today would be lost or changed, and reports everything else, whose files
      stay with the version-1 files.
      - Stops: an entry whose `seq` does not come after the one before it. The core never
        writes one; a hand edit or a second writer can, and the database keeps one entry
        for each `seq`. The other way would renumber, or keep the first.
      - Stops: a conversation file that is not a record with an id. Today it is skipped
        with a warning and stays on disk; after the import its transcript would never be
        read again. Today's writes are not synced to the disk, so a power cut can leave
        such a file, empty or zeroed, and today the bot then starts without that
        conversation. The other way would import the rest and report it.
      - Stops: two files holding one conversation id. Today the later one wins.
      - Stops: a transcript line that is JSON but no entry with a whole `seq` of 1 or
        more. Today's reader returns it and the note shows it, and the core numbers the
        next entry after it (`2.5` is followed by `3.5`, `"2"` by `"21"`), so the
        entries after one are no entries either.
      - Stops: a transcript or the journal that exists and cannot be read: a directory in
        its place, a file the account may not read, or one too long for a string
        (about 512 MB). Today's readers fail on it as well, though for a transcript only
        that conversation fails. A file held for a moment by a virus scanner or a backup
        tool stops it too; the next start tries again.
      - Stops: a presentation sidecar whose version is not 1, or whose backup is one when
        the sidecar cannot be read. Today's reader refuses both, so that it never hides
        a later format behind an older backup.
      - Reported: a line that is not JSON, as a crash leaves the line it was writing. A
        line written after such a cut joins it, and today's reader loses both as well.
      - Reported: a transcript or a sidecar of no conversation, as a crash during a delete
        leaves (its record goes first). A file named in another case is the
        conversation's own where the conversation's path reaches it, which the file
        system decides; most directories on Windows and macOS ignore case, some do not.
      - Reported: a sidecar that cannot be read; its backup is imported when it can be
        read, as today. When neither can be, today the conversation's view fails, and the
        transcript is imported without the sidecar.
      - Reported: a file no reader of today reads, such as `conversations/.backup/`, or a
        sidecar's backup of another version beside a sidecar that is read.
      - Imported, and counted: work items of conversations deleted in version 1, which
        today's journal keeps. They stay until the FR-7 point above is decided.
      - Not the import's to decide, but changed by the store: two presentations with the
        same `seq` come back ordered by their id, where today they keep the order of the
        sidecar, which moves a presentation to its end each time it is saved.
      - Found by the import's last review and not changed: a conversation id holding a
        colon reaches an NTFS alternate stream of another file, which is then taken as
        that conversation's own; a hard link's second name is taken as the
        conversation's own (its content is imported); the file identity checks add about
        17 s per 20,000 conversations on the reviewer's machine.
    - What the migration does around the import (proposed defaults):
      - A profile raise that fails stops the start; an archive move that fails does not,
        and is tried again at the next start.
      - FR-11's order leaves a moment between the marker and the profile raise. An older
        Bot started then still runs on the version-1 files, and what it writes there is
        archived without being read.
      - A database without the marker is removed with its `-wal` and `-shm` and made
        again; a newer one, or a file that is not one, stops the start and is kept. That
        is only safe while nothing else makes `bot.db`: the cutover makes the migration
        the only maker, a new bot's first start included.
      - Restoring sets the database aside under a new name rather than removing it, and
        keeps the raised profile beside the lowered one.
- [ ] 1.3 Full-text index, query builder and a rebuild command. First planned with a
      bigram column and a LIKE path for single characters; the notes below say what
      replaced them.
  - [x] `src/core/store/searchText.ts` rewrites an entry's text and a person's query, and
        the store's `search` and `rebuildIndex` use it; `tests/core/searchText.test.ts`.
    - There is no bigram column and no `LIKE` path any more: one rewritten form of the
      text is indexed, and a single character is a prefix query on it. SPEC-014 FR-8
      carries both, accepted by the owner on 2026-11-11.
    - `meta` holds a number for the way text is rewritten. A writer that finds another
      number rebuilds the index, so the rewriting can change later without a migration.
    - The rewriting depends on the Unicode version of the runtime, which `meta` records.
      Electron 41 has 16 and Node.js 26 has 17, so a character new in 17 is a letter to
      one and a separator to the other.
    - A symbol, and a number that is neither a plain digit nor raised or lowered, stand
      apart from the words beside them, so `iPhone™` holds `iphone` and `①apple` holds
      `apple`. A raised or lowered digit stays with its word: `CO₂` is `co2`, at the
      price of `E=mc²` not holding `mc`.
    - The dot Chinese writes inside a name (`馬克·吐溫`) is dropped, so the name is found
      with it and without it. The dot Japanese writes between the items of a list is
      another character and parts them. Hangul letters typed on their own (`ㅋㅋㅋㅠㅠ`)
      are kept as they are.
    - CJK punctuation parts two words wherever it stands (`LINE、Telegram`), as a space
      does; other punctuation parts them next to a CJK run and keeps a Latin word
      together (`v1.2.3`).
    - Full-width punctuation is CJK punctuation, so between Latin letters or digits it
      parts a query where the half-width form keeps one phrase: `３．５公斤` asks for `3`
      and `5 公斤`, and also finds an entry holding both apart. Such a query finds more,
      never less.
    - A search takes at most 200 characters and 12 different words, and refuses more.
      That bounds the text, not the time: a word found in a large share of the entries
      takes seconds, on the core's own connection (see 1.7).
    - A reader that finds an index made the way another version searches refuses to
      search it, instead of returning part of the answer.
    - A record whose JSON cannot be read is left out of what a read returns and of the
      index, and reported through the store's `warn`, as an unreadable line is today.
    - Not offered: a prefix of a Latin word (`kett` for `kettle`), word forms, Traditional
      for Simplified, and a Chinese word broken by a line end.
  - [ ] The `cats-bot` command that rebuilds the index.
- [ ] 1.4 `BotHostApi` paged transcript read and note paging. `conversationTranscript` keeps
      working.
- [ ] 1.5 Migration (backup, import, verify, marker, profile schema raise, archive), failure
      report and `cats-bot restore`.
  - [x] The import, its check and the marker: `src/core/store/version1Import.ts`, with
        `tests/core/version1Import.test.ts`. Nothing calls it yet.
    - It reads a version-1 data root and writes a new database: the conversation records,
      then each transcript in batches of 2,000 entries keeping every `seq`, then its
      presentations. The journal goes in the last transaction, which is durable
      (`synchronous=FULL`, set before it begins, since SQLite refuses to change it inside
      one). In that transaction the import reads the files and lists the directories
      again, compares every record with what the store reads back, counts a record the
      store cannot read or a number JSON cannot keep (`1e999`) as a difference, and only
      then writes the marker.
    - Records are kept as their files hold them: a conversation before today's loader
      fills in its fields or upgrades a contact note, a presentation sidecar before its
      blocks are checked, every line in its own field order. Today's readers then run on
      them unchanged. The tests compare with `readTranscript`, `readJournal` and
      `ConversationStore`.
    - It refuses a database that holds any record or a marker. It reports problems by
      file and line number, never by what a line holds. What it does with each kind is
      below, under the cutover; the ones marked as stopping it are proposed defaults.
  - [x] The migration around it: `src/core/store/version1Migration.ts`, with
        `tests/core/version1Migration.test.ts`. Nothing calls it yet.
    - `migrateVersion1` needs the bot's lock held by its own process and decides what to
      do from the database's marker, never from which directories exist, since today's
      code makes them again. Without a marker it removes an unfinished database, copies
      the version-1 files and the profile to `migration-backup/<time>/` (marked as in
      progress until a manifest of every file's size and SHA-256 is written last), and
      imports. When the import does not finish, it writes `report.json` and `report.md`
      beside the copy and removes the database; the version-1 files stay as they were.
      With the marker it raises the profile's schema version, after a copy of the
      profile, and moves the version-1 files to `archive/v1/` one by one. Each step is
      repeated at the next start until it is done.
    - `restoreVersion1` takes the lock itself and, in this order, puts the files back,
      sets the database aside under a new name and lowers the profile, so that a crash
      on the way leaves a root one of the two versions starts on.
    - Left for the cutover, since both change what runs today: the profile schema
      version the core writes (every save writes it, so raising it before the cutover
      would raise every bot's profile with nothing migrated), and the `cats-bot restore`
      command. The tests already show that today's `loadProfile`, the rule an older Bot
      keeps, refuses the raised profile.
    - A new database does not replay a log left beside a deleted `bot.db`, on both
      runtimes; the migration removes such a log anyway.
    - `fs.cpSync` ends the process in Electron 41 (Node.js 24.14) on Windows when it copies
      a directory whose path holds a character outside ASCII, as a bot root under a
      user's profile can; Node.js 26 copies it. The copy is made file by file instead. The
      tests run in a directory with CJK characters in its name, inside Electron as well.
    - Measured on Windows: 9 s for 100,000 made-up entries and 25,000 journal lines, on
      Node.js 26 and inside Electron 41 alike, whatever the batch size between 500 and
      10,000; a million entries would take about a minute and a half. A copy of one local
      data root imported and checked with no problem.
    - Measured by the review, on a loaded machine: one transcript of 1,000,000 entries
      (269 MB) in 200 to 240 s with 1.6 to 1.9 GB of memory; 100,000 conversations of
      one entry each in 800 s, mostly reading files. A journal of 400 MB used 3 GB while
      it was checked, three times what today's reader holds; letting go of the import's
      first copy saves a tenth, since the current work items stay held. Above about 512 MB a transcript or the journal
      cannot be read into one string, by today's readers or the import. Each of these is
      for 1.7 to bound, or for the migration to report.
    - A failure other than these, such as a full disk, is thrown and leaves no marker; the
      migration writes the report from it. A number JSON cannot keep (`1e999`) shows only
      as a difference naming its record.
  - `appendJournal` keeps a line whatever it holds, and makes a current row only of a
    work item or a schedule with a text id, as today's replay does.
  - Fixtures for the cutover still to come: a crash of the real start at each step, and
    an older build of Bot itself, not only its rule, refusing the raised profile.
- [ ] 1.6 Daily `VACUUM INTO` snapshot, startup `quick_check`, and `cats-bot export`.
- [ ] 1.7 Performance targets of SPEC-014 on the three platforms.
  - Measured by the independent review on Windows inside Electron 41 (SQLite 3.51.2),
    with 1,000,010 made-up entries, 286,894 work items and 861,732 journal lines
    (1,376 MB). Medians of three to five runs, except where one run is said. Every
    number is from before the last changes to how text is rewritten. Those leave the
    rewriting of 2 MB of Latin text at about 0.07 s, where it took 0.06 s, and that of
    2 MB of mixed text at 0.4 s, where it took 0.2 s.
    - Within the targets: append 0.3 ms, 0.8 ms at the 95th percentile; newest 50 entries
      of a 600,000-entry conversation 0.2 ms; a word or a character found in few
      entries 0.2 to 0.5 ms, 2.7 ms at worst, in one conversation or in all.
    - Missed when a large share of the entries match: a two-character word found in 15%
      of them takes 0.34 s, and 0.9 to 1.3 s within one conversation, whatever its size.
      The commonest character takes 1.7 s, and 2.5 to 3.4 s within one conversation.
      Ranking reads every match, and a search within one conversation fetches every
      match's entry to learn its conversation.
    - Several common words together take longer still: eight of them 1.5 s. The limits
      on a query bound its text, not this.
    - One entry of 2 MB takes 0.4 to 1 s to store and index, one of 4 MB 1 to 2 s, on a
      connection that blocks the core meanwhile. These and the eight words were measured
      with 935,000 entries left, after two conversations had been deleted.
    - Rebuilding the index: 97 s for 935,000 entries, as one transaction with a 206 MB
      write-ahead log (one run). A writer that finds the index made another way does
      this when it opens.
    - Deleting a conversation of 17,600 entries: 7.3 s. One of 49,600 entries with a
      work item each: 19.6 s (one run each).
    - Reading every work item: 2.2 to 2.7 s. Reading the whole journal: 9.2 s.
  - Ways to meet the search target: a token for the conversation in the index, so the
    index itself narrows to it; a limit on how many matches are ranked; and searching on
    a reader connection off the core's thread. Open as well: whether to cap how much of
    one entry is indexed.
- [ ] 1.8 Release and migration notes for the next minor version, prepared in the bump PR.
      No bump is part of this plan.

**Deliverables**: every bot runs on `bot.db`; the version-1 files are archived; older
binaries stop instead of starting blank; search is available to the core.

### P2: Recall (SPEC-015 FR-10–FR-12, FR-24–FR-27), after the security review

- [ ] 2.1 Recall service over evidence, with scope and trust filters and fenced rendering
      with dates. `memory_search` / `memory_get` MCP tools for providers that accept session
      MCP; not offered in contact notes.
- [ ] 2.2 Recall-intent detection (zh-TW and English) and core-side injection as
      turn-scoped context. Blocked on P0's Runtime field.
- [ ] 2.3 Evaluation set v1 from fixture conversations, and its runner.

**Deliverables**: tool-capable bots can find specifics past the handoff pack; every bot can,
once 2.2 lands.

### P3: Core memory and owner controls (SPEC-015 FR-1–FR-7, FR-21–FR-23, FR-28)

- [ ] 3.1 Records, versions, scope and derived trust; deletion rules (FR-4).
- [ ] 3.2 Core-memory snapshot in session instructions. The live-session delta follows when
      P0's Runtime field exists.
- [ ] 3.3 `remember` / `forget` MCP tools as validated proposals (FR-28), with the budget
      refusal.
- [ ] 3.4 Settings Memory section: list, search, edit, retire, evidence, versions, restore,
      approval queue, switches and export.

**Deliverables**: the owner and tool-capable bots can maintain core memory, and the owner
controls all of it.

### P4: Consolidation (SPEC-015 FR-13–FR-20), blocked on P0's tool-free session

- [ ] 4.1 Consolidation work item, scheduling after the direct message sleeps (SPEC-011),
      the heartbeat-off schedule, and per-conversation watermarks.
- [ ] 4.2 Input builder:
  - token-bounded, single-scope batches;
  - owner and bot lines only;
  - contact notes excluded.
- [ ] 4.3 Proposal schema, validation with derived trust and the day rule, loss guard,
      automatic additions and the approval queue.
- [ ] 4.4 Token caps per run and per day, usage records, batch halving and skip listing.
- [ ] 4.5 Optional dream diary, off by default.
- [ ] 4.6 Separate consolidation target (SPEC-015 FR-19), blocked on P0's credential
      prerequisite:
  - an optional profile field, normalized field by field;
  - try first, end to end, a private Runtime that runs a CLI target and an API or local
    target together;
  - the private Runtime's generated configuration with the second target, marked as
    admitting only text-only sessions, with a literal endpoint for a local model, and the
    restart rules when it changes;
  - the key in `secrets.json`:
    - a write that fails without a cipher backed by the operating system's credential
      store, and a read that refuses an unencrypted entry;
    - placed only in the environment the supervisor builds for the Runtime process, under a
      Cats-private name;
    - deleted when the target is removed;
  - settings with the provider named, the consent text, the loopback or remote note for a
    local model, and the reason when consolidation is off;
  - acceptance against a Runtime API-backend target, which needs Runtime SPEC-043 R7 and
    R10.

**Deliverables**: bots improve their memory overnight within a known cost, and no batch can
stall them.

### P5: Working summaries and handoff (SPEC-015 FR-8–FR-9), after P4

- [ ] 5.1 Consolidation maintains one working summary per conversation (none for contact
      notes).
- [ ] 5.2 The summary replaces the clipped digest in today's pack. With P0's Runtime field,
      the handoff goes once, on the first turn: summary first, recent entries, stale marker,
      tool pointer, and a budget scaled to the model's context.
- [ ] 5.3 The assist-heartbeat review (SPEC-011 FR-13) may use working summaries.
      Independently, it should stop rendering error lines. That is a small fix that can land
      at any time.

**Deliverables**: replacement sessions start from a summary, not from clipped lines.

### P6: Evaluation and the embeddings decision

- [ ] 6.1 Run the evaluation on recall and on post-consolidation memory, and record misses.
- [ ] 6.2 Owner decision on embeddings (local first) from the results. Nothing is built
      without it.

## Files to Create/Modify

- **Create**:
  - in `src/core/store/`: `sqliteDriver.ts`, `stateDatabase.ts` (adapter),
    `stateSchema.ts`, `stateStore.ts`, `searchText.ts`, and the migration;
  - `src/core/memory/*` (records, recall, consolidation, rendering);
  - tests under `tests/core/` (the store's run inside Electron too) and
    `tests/core/memory/`;
  - fixtures of a version-1 data root.
- **Modify**:
  - `src/core/conversations/store.ts`, `src/core/store/journal.ts`,
    `src/core/store/presentation.ts`, `src/core/profile/profile.ts` (schema raise),
    `src/core/bot.ts`, `src/core/conversations/binder.ts` and `handoff.ts`,
    `src/core/queue/turnRunner.ts`;
  - `src/core/host-api/commands.ts`, `src/cli/main.ts`;
  - the settings renderer;
  - `docs/architecture.md`, SPEC-001 FR-2, FR-3 and FR-12 when P1 lands, `docs/testing.md`.

## Technical Decisions

- **Index design.** Two-character tokens were chosen because trigram and unicode61 both
  miss 2-character Chinese words; the survey's probe covered this. How the text is
  rewritten into them is SPEC-014 FR-8, as amended and accepted on 2026-11-11 (task 1.3).
  It is re-checked with the P2 evaluation set.
- **Store before memory.** The store change is independently valuable and independently
  reversible through `cats-bot restore`.
- **One-turn context needs a Runtime field.** Turn `instructions` are persisted by Runtime,
  so recall, deltas and a one-time handoff wait for the new field. Core memory and MCP tools
  do not.
- **Not in this plan**, follow-ups:
  - Consider hosted grok so that Bot tools reach it.
  - Consider proactive rotation for providers whose native context management is unknown,
    as Paperclip does.
  - Record completed actions so that a re-sent turn cannot repeat side effects (Paperclip's
    receipts).

---

*Created: 2026-11-11*
*Author: Claude*
