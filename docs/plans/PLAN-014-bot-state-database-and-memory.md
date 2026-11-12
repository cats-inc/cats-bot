# PLAN-014: Bot State Database and Memory

## Metadata

| Field | Value |
|-------|-------|
| **Status** | P1 finished on `main` and withdrawn from Cats Bot on 2026-11-12, before release (ADR-021); kept at the tag [`state-db-p1`](https://github.com/cats-inc/cats-bot/tree/state-db-p1). P2 onward wait on Cats Desktop's pilot of a state database ([cats-platform ADR-152](https://github.com/cats-inc/cats-platform/blob/main/docs/decisions/152-pilot-a-state-database-in-cats-desktop-before-cats-bot.md)). As it stood: Approved, 2026-11-11, with ADR-021 and ADR-022. P1 started 2026-11-11 with the driver acceptance of task 1.1; nothing is wired into the core yet. P2 onward wait for the security review and the Runtime prerequisites in P0 |
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
- [x] Owner, 2026-11-12: "all as recommended; take it to the end", with P1 finished
      before the next stop so that the owner can bump 0.6. Read as:
      - every default this plan proposed before that message stands as the owner's
        choice: the import's stopping rules and reports (1.5), and the migration's
        defaults (profile checked first, a raised profile with no finished database
        stopping the start, a failed raise stopping it and a failed archive move not,
        a copy used again, a restore setting the database aside after folding its log);
      - the go for the cutover, which merges like the slices before it, after an
        independent review with nothing blocking and CI on the three platforms;
      - the defaults chosen after that message, under it, are listed under the cutover
        as they are made, each marked "chosen 2026-11-12", so that the owner can read
        them before bumping;
      - the bump, the release notes' exact pins and the publication stay the owner's.
- [x] Done before the owner bumps 0.6 (2026-11-12): tasks 1.4 to 1.7 and the cutover
      merged; SPEC-014's acceptance list checked; SPEC-001 FR-2, FR-3, FR-12 and FR-14,
      ADR-001 section 6 and `docs/architecture.md` updated as SPEC-014 says; a draft of
      1.8's release and migration notes ready for the bump; `main` green on the three
      platforms with no open pull request or worktree of this plan.
  - Done 2026-11-12: #169 (the cutover), #170 (1.4), #171 (1.7), #172 (1.6) and #173 (its
    review's follow-up) merged, each after an independent review with no blocker left and
    CI on the three platforms; `main` 1dc4733 green; 1.8's draft is under 1.8. What each
    review left is listed under its task as known.
- [x] Owner, 2026-11-12, after P1 was done: withdraw it from Cats Bot before any release.
      Bot is light and one-to-one, and its readable files have a value of their own; Cats
      Desktop tries a state database first ([cats-platform ADR-152](https://github.com/cats-inc/cats-platform/blob/main/docs/decisions/152-pilot-a-state-database-in-cats-desktop-before-cats-bot.md)), and Bot decides after that has been
      tested. `main` was reverted to the 0.5.9 base with #164 and #167 kept; P1 stays at the
      tag [`state-db-p1`](https://github.com/cats-inc/cats-bot/tree/state-db-p1). The next Bot version number is the owner's to choose again, since no
      persisted-data change remains.
  - Recorded, not built (the owner did not choose them): three fixes the version-1 files
    could have, which P1 made unneeded: compact the journal to its current state, so that
    a start does not read it from its beginning; remove a deleted conversation's prompts
    from the journal; read a page from the end of a transcript instead of the whole file.
  - Also recorded, not built: fixes that came with P1 and went with the revert, though they
    do not depend on the database: each interrupted work item recovered on its own, so one
    that fails holds back no other; a core whose start failed refuses a second start; the
    hub ending a core that is still starting when the bot is stopped or the hub quits, and
    starting it again cleanly when Start follows Stop; a turn that ends after its
    conversation was deleted keeping no work item in memory.
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
- [x] 1.2 Move writers and readers (the cutover, #169):
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
  - [x] The cutover: `ConversationStore`, the presentation store and the journal use it;
        `tests/core/stateCutover.test.ts`.
    - The core opens the database for writing under the lock, after migrating: at start,
      and for a write a host makes while the bot is stopped (`schedule add`, `schedule
      cancel`, `approve`, profile changes). A host without the lock reads one snapshot
      through a reader and closes it. Profiles are written at schema 3; `cats-bot init`
      makes a new bot's database first. `cats-bot restore` is the restore command.
    - An architecture test keeps every module outside the store from the version-1
      files' modules and paths.
    - Checked by hand on a copy of one local bot root through the CLI (status, a
      stopped write that migrates, restore), and with the 0.5.9 release's own CLI: it
      reads a bot it made, refuses it once migrated ("Unsupported profile schema"), and
      reads it again after a restore, without what was written in between.
    - Chosen 2026-11-12, under the owner's instruction of that day:
      - A turn that ends after its conversation was deleted: a work item whose
        conversation no longer exists is not written (SPEC-014 FR-7).
      - Deliveries of a deleted conversation: a deleted work item leaves its id, source
        reference and delivery id in `deleted_work`; a delivery found there is not
        admitted again, and the hub is told it was cancelled because its conversation was
        deleted (SPEC-014 FR-3, FR-7).
      - A cancelled schedule keeps its prompt, as today's journal does (FR-15).
      - Startup reads every work item, and deleting a large conversation takes seconds:
        accepted as measured.
      - A host without the lock shows nothing of a bot not migrated yet, until its first
        start or write; the hub starts its bots, so this is a CLI-only moment.
      - A bot root on a network share is not supported once it is a database: SQLite
        does not support WAL there. The release notes say to keep `CATS_BOT_HOME` on a
        local disk; nothing refuses one.
      - Two presentations with the same `seq` come back ordered by their id.
      - From the first review of the cutover, each with a test that fails without it:
        - The hub waits an hour, not a minute, for a core whose bot migrates first; a
          large bot's migration took longer than the minute.
        - Work items 0.5 kept for deleted conversations are deleted at every open for
          writing, as a deletion would; otherwise the recovery at start asked the owner
          about them, and they held the bot back from expiring work.
        - Deleting a conversation removes its work items from the core at once.
        - A host without the lock reports a database it cannot read, instead of showing
          nothing; only a missing one is a bot not migrated yet.
        - A migration that does not finish is written to `core.log` with its report's
          path; a core whose start failed refuses a second start.
        - `cats-bot init` in a folder with version-1 files leaves them for the first
          start to migrate; `cats-bot restore` sets a database it cannot open aside whole
          and says when there is nothing to restore, and a migration stopped by an
          unfinished restore says to run it again.
        - A work item whose record is not JSON never stops its conversation from being
          deleted.
        - The architecture rule names each way of reaching a version-1 file (namespace,
          default and dynamic imports, every import statement, `journal.jsonl`,
          `botPathsFor(...)` and destructuring), and the cutover's tests also run inside
          Electron.
      - From the second review of the cutover, each with a test that fails without it:
        - `cats-bot restore` looks for the version-1 files before it sets a database
          aside; on a bot 0.6 made, it moved the database and then said nothing was
          restored, and every later restore said the same.
        - A migration that finished writes its report when its import found anything,
          and `core.log` names it (FR-11: reported, never dropped).
        - Quit or a stop ends a core that is still migrating instead of waiting for it,
          and a bot that migrates starts beside the others.
        - The home conversation's work items are never forgotten as a deleted
          conversation's, and a work item whose conversation was deleted during its
          turn is not kept in memory.
        - Recovery and the expiry of approvals go on past an item they cannot handle.
        - `restore --json` says `restored: false` when nothing changed.
      - From the third review, which found nothing that blocks, fixed with PLAN-014 1.6:
        a start asked for right after a stop follows the stopped one instead of counting
        as a failure, and a copy reused from a migration that did not finish loses that
        run's report when the next one finishes without anything to report.
      - Left as they are, from the same review: the architecture rule still misses a
        version-1 path reached through a variable not named `paths`, an index by string,
        a re-export from another store module, a template string, or `join` with a
        variable; reviews and the tests of each module are what find those. A bot whose
        `conversations/home.json` was removed by hand imports without its home
        transcript, which stays in the copy and in `archive/v1/`.
      - For the release notes (1.8): the copies in `migration-backup/` and `archive/v1/`
        keep what the bot held before, deleted conversations' prompts included, until the
        owner removes them; a bot root on a network share is not supported; the hub shows
        a migrating bot as starting, and a migration that failed only as a bot that did
        not start, with the reason in `core.log`; Quit during a migration ends it, and the
        next start does it again from the start.
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
      - The profile is checked before anything is imported: readable as today's Bot reads
        it, at the version the raise starts from, and writable. A profile that fails any
        of these stops the start before the import.
      - A profile already raised with no finished database means the database is gone;
        the start stops rather than import the archived root again.
      - A profile raise that fails after the import stops the start; an archive move
        that fails does not, and is tried again at the next start.
      - FR-11's order leaves a time between the marker and the profile raise, as long as
        the raise keeps failing. An older Bot started then still runs on the version-1
        files, and what it writes there is archived without being read. Checking the
        profile first leaves only a failure of the raise itself, such as a full disk.
      - An import that does not finish uses the newest copy again when the files have not
        changed, instead of adding a copy at every start.
      - A database without the marker is removed with its `-wal` and `-shm` and made
        again; a newer one, or a file that is not one, stops the start and is kept. That
        is only safe while nothing else makes `bot.db`: the cutover makes the migration
        the only maker, a new bot's first start included.
      - Restoring sets the database aside under a new name rather than removing it, and
        keeps the raised profile beside the lowered one. It folds the log into the
        database first and stops while another program holds it; it stops when neither
        the root nor `archive/v1/` holds the version-1 files, and names what it leaves in
        the archive. It reads only `archive/v1/`; putting files back from a copy in
        `migration-backup/` is for `cats-bot restore` at the cutover.
- [x] 1.3 Full-text index, query builder and a rebuild command (#165, #171, #172). First planned with a
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
  - [x] The `cats-bot` command that rebuilds the index: `cats-bot reindex`, while the bot
        is stopped; `tests/core/migrationAtStart.test.ts`.
- [x] 1.4 `BotHostApi` paged transcript read and note paging. `conversationTranscript` keeps
      working.
  - `conversationTranscriptPage(conversationId, { limit?, beforeSeq? })` returns
    `{ entries, olderBeforeSeq }`, from `BotCore` through the host commands
    (`src/core/host-api/commands.ts`), the note-only IPC list (`src/shell/electron/ipc.ts`)
    and the bridge (`src/renderer/bridge.ts`). `ConversationStore.presentationPage` makes a
    page from the store's indexed reads: its window of entries, the presentations reaching
    into it (`presentationReach`, from `responses.covers`), its own presentations, and
    whether a bot entry of a work item comes after it (`hasBotEntryOf`).
    `tests/core/transcriptPaging.test.ts` reads pages of every size and budget back to the
    start of a conversation with every shape of reply and checks they are the whole
    conversation as `conversationTranscript` shows it.
  - Schema version 2 (`src/core/store/stateSchema.ts`) adds `responses.covers` and three
    indexes; a writer upgrades a version-1 database at open, in one transaction
    (`tests/core/stateSchemaUpgrade.test.ts`, also a failed upgrade leaving version 1).
    Raised rather than added to version 1, chosen 2026-11-12: builds of `main` since the
    cutover wrote version 1, and one of them would write presentations without `covers`
    into an upgraded database; with the version raised it refuses it.
  - The independent review of the first version measured, on Node.js 26 with 600,000
    entries and 60,000 presentations (320 MB of their JSON), the newest page at 15.9 to
    17.3 s, its halving for a presentation over 1 MB at 113.6 s, and a page holding a
    cancelled reply at 14.4 s: every page read and checked every presentation of the
    conversation, and the lookup of a later bot entry scanned to its end. After the
    rework, on the same build of that database (one run each, warm after the first): the
    newest page 7.8 ms, 4.0 ms again; a middle page 8.7 ms; a page holding a cancelled
    reply 6.6 ms; near the start 1.6 ms; 20 pages from the newest 220 ms; a presentation of
    1.31 MB as the newest page 31 to 39 ms, read once. With 60,000 entries: 6.3 ms, 2.0 ms
    again, 3.5 ms, 3.3 ms, 1.5 ms and 51 ms. The review's differential fuzz (300 seeds,
    pages of 1 to 25 entries, and with budgets) finds the pages equal to
    `conversationTranscript`, with damaged rows too; its sanity mode still finds the
    difference it plants.
  - Known, left as they are:
    - A page that reaches back over a presentation the projection leaves out (one saved
      before its final entry, with that entry after it) reads that presentation's entries
      to cut them to the budget: 357 ms for a turn of 9,000 lines of 2 KB, and each page
      over that turn reads them again (2.8 s for its 20 pages). The page itself stays
      within 1 MB, unless one entry is larger.
    - Pages read back to the start while a reply streams may lack a presentation that the
      whole view shows as it was a moment later; the note merges the live events and is not
      affected.
    - The note takes the highest `seq` it holds for the end of what it read without a gap.
    - The note checks whether its pages fill it when they change, not when it is resized.
    - A record whose JSON lost its `seq` is shown as the whole transcript shows it; only
      the page boundary is taken from its row (`entriesWindow`'s `firstSeq`).
    - `conversationTranscript` itself still projects the whole conversation: 19 s for
      60,000 entries in the review's database. The note no longer reads it.
  - The note (`src/renderer/note/NoteApp.tsx`) reads pages through `readNewestPages` and
    merges them with `mergeTranscriptEntries` (`src/renderer/note/transcript.ts`);
    `tests/renderer/transcriptPaging.test.ts` pages back while a reply streams.
  - Chosen 2026-11-12, under the owner's instruction of that day, and listed in SPEC-014's
    Open Questions: 100 entries a page, at most 500, 1 MB a page, cut to its newest part
    within it; a page reaches back to the start of a presentation that covers its first
    entry; the note pages back within 120 pixels of the top or while its pages do not fill
    it, and reads at most 20 newest pages after a turn; schema version 2.
  - The note no longer reads `conversationTranscript`; the command stays for other hosts.
- [x] 1.5 Migration (backup, import, verify, marker, profile schema raise, archive), failure
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
      code makes them again. Without a marker it checks the profile, removes an
      unfinished database, copies the version-1 files and the profile to
      `migration-backup/<time>/` (a copy counts once its manifest of every file's size
      and SHA-256 is written last, and any other is removed), and imports; the marker
      names the copy. When the import does not finish, it writes `report.json` and
      `report.md` beside the copy and removes the database; the version-1 files stay as
      they were. With the marker it raises the profile's schema version, after a copy of
      the profile, and moves the version-1 files to `archive/v1/` one by one. A profile
      a power cut left unreadable during the raise is raised from the copy the marker
      names. Each step is repeated at the next start until it is done.
    - `restoreVersion1` takes the lock itself and, in this order, puts the files back,
      folds the database's log into it and sets it aside whole under a new name, and
      lowers the profile. A crash between two steps leaves a root the new version starts
      on, or one it refuses to import again because the profile still says migrated;
      running the restore again finishes it.
    - Every removal goes through `removeTree`. Electron 41's `rmSync` fails on a read-only
      file, and ends the process under a path with characters outside the system's code
      page for older calls (Korean, an emoji or simplified Chinese on a Traditional
      Chinese Windows); a read-only file in the version-1 files is copied read-only.
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
      tests run in a directory with CJK characters in its name, one of them with Korean,
      an emoji and simplified Chinese, inside Electron as well.
    - Found by the first review and left for later: a run killed between making a copy's
      directory and its first file leaves an empty directory, which the next run
      removes; a temporary file of an interrupted profile write can stay beside the
      profile, as today; an error's message is written to the report as it is.
    - For the cutover, from the second review:
      - A new bot's first start: the migration stops on a profile already at the raised
        version with no finished database. Once the core writes the raised version,
        `cats-bot init` makes such a profile, so the cutover has to make a new bot's
        database at init, or tell a new bot from a migrated one, and raise a schema-1
        profile to 2 before the migration, not straight to 3.
      - A restore stopped before it lowers the profile leaves the new version refusing
        to import again; its message should name the set-aside database, and say the
        files are back.
    - For `cats-bot restore`, from the second review: a newer or foreign `bot.db` makes
      the restore stop after it has put the files back, and no second run gets further;
      it should check the database first, and set such a one aside whole. A read-only
      `bot.db` is reported as held by another program.
    - Left as they are, from the second review: a copy used again is judged by its
      manifest, not by reading it again, so a copy someone emptied is used again and
      named by the marker; a file changed after it was copied, which only a writer that
      ignores the lock can do, leaves a copy one line short of what was imported; a
      profile another program holds open passes the writable check and fails the raise
      after the import, until that program lets it go.
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
  - [x] Fixtures for the cutover: a start stopped before each step of the migration and
        finished by the next start, through the core's own start
        (`tests/core/migrationAtStart.test.ts`). An older build of Bot itself refusing the
        raised profile was checked by hand with the 0.5.9 release's CLI (see the cutover
        above); its rule is pinned in `tests/core/version1Migration.test.ts`.
- [x] 1.6 Daily `VACUUM INTO` snapshot, startup `quick_check`, and `cats-bot export`:
      `src/core/store/stateMaintenance.ts` with its child process, `conversationExport.ts`, and the
      `export` and `reindex` commands; `tests/core/stateMaintenance.test.ts` and
      `tests/core/conversationExport.test.ts`.
  - Measured inside Electron 41 on Windows, on a 330 MB database of a million made-up
    entries: `quick_check` 15.5 to 17.4 s, `VACUUM INTO` 9.1 s (one run each). Both run
    on a read-only connection of their own, so the core goes on answering; a read-only
    connection checks and copies while the writer holds a transaction, and the copy has
    what was committed.
  - From the review of #172, which found nothing that blocks, fixed in the follow-up:
    - The check and the snapshot ran in a worker thread, which `terminate()` cannot stop
      inside a SQLite call: a stop waited 6 to 10 s on that database, and a Quit on a
      bot of more than about 600 MB would have been ended by force. They run in a child
      process now, which a stop ends in 0.1 to 2.7 s on an idle machine (6 s once under
      load), leaving no unfinished file; a core killed outright leaves its unfinished
      snapshot until the next one removes it.
    - A `backups/` that was a file ended the core from the timer; the report of a damaged
      database that could not be written left the core running. Neither does now.
    - The hub started a core on a damaged database again, four times or, for a large
      bot, forever; it now leaves it failed with the report's path, and `cats-bot run`
      exits with 1.
    - A snapshot that found damage, or a check that could not run, was only a warning.
    - Each read-only command wrote a report; a migrated bot whose `bot.db` was missing
      or empty showed as empty; a snapshot named after a time to come stopped snapshots.
    - A start right after a stop showed the bot as stopped while it started.
    - CI built the compiled maintenance script but never ran it; it runs it now.
  - Known, from the same review: a start of the core for `cats-bot say` or `tick` also
    begins the check, and its stop ends it; a check of a large bot after each start
    reads the whole file.
  - From the review of the follow-up (#173), which found nothing that blocks, fixed in it:
    a snapshot named after a time to come made a snapshot due at every look and stayed
    the newest; a report named after a time to come kept a healthy bot from restarting;
    after a stopped restore, every host advised copying an older snapshot instead of
    running the restore again; a child that could not be started left a stop waiting; a
    migrated bot without its `bot.db` was started again by the hub, as it wrote no
    report. Its confirmation found two more, fixed as well: a clock set back more than a
    day made the next snapshot remove every good one (now ones named after a time to come
    go only once three others are kept), and the report of a missing database after a
    stopped restore still advised an older snapshot. Known: a clock set back after a start hides that start's report from the
    hub, which then starts the core again a bounded number of times; the hub calls a
    missing database one that failed its check, though its report says what happened;
    Start pressed while
    a running core stops leaves the bot shown as stopped with the new core running, as
    before this work.
  - Checked on a copy of one local bot root (one conversation, 77 lines): its export
    before the migration and after it are equal byte for byte. The copy was removed.
    Checked again with `main` 5e49ab3, after #170, #171 and #173: equal after the
    migration, and again after `cats-bot restore` put the version-1 files back.
  - Chosen 2026-11-12, under the owner's instruction of that day, and listed in SPEC-014's
    Open Questions: the check runs once the core has started, in a child process; a snapshot
    only after this run's check passed, written under an unfinished name first; the
    report's name and what it says; the export's lines; `cats-bot reindex`.
  - For the release notes (1.8): a deleted conversation stays in the snapshots in
    `backups/` until they are replaced, three days later; the check and the daily
    snapshot read the whole database in the background (16 to 17 s and 9 s for 330 MB);
    a damaged database leaves the bot stopped in the hub with the report's path.
- [x] 1.7 Performance targets of SPEC-014 on the three platforms.
  - Measured on `main` 5d27bf2 by the manual `store-performance` workflow (run
    43133239743, 2026-11-12), one run on each GitHub runner, with 1,000,000 made-up
    entries, under Node.js 24.22.2 (SQLite 3.53.4) and inside Electron 41.2.0 (Node.js
    24.14.0, SQLite 3.51.2). SPEC-014's three targets are met on every platform, in both:
    - append at the 95th percentile 0.27 to 0.86 ms (target 5 ms);
    - the newest 50 entries 0.09 to 0.29 ms (target 20 ms);
    - two-character Chinese queries 1.7 to 51.3 ms (target 100 ms), over all entries, in
      a conversation of 21,000 and in one of 600,000 entries: a rare word 1.7 to 26.2 ms,
      one in some entries 4.5 to 23.2 ms, the commonest 12.2 to 34.2 ms, and two common
      words together 24.0 to 51.3 ms.
    - Outside SPEC-014's targets, which name no single-character query: the commonest
      single character takes 103.8 to 258.8 ms (115.6 to 144.7 ms inside Electron).
    - On this machine, the reference Windows machine SPEC-014 names, inside Electron 41 at
      `main` 5e49ab3, one run with other work at about 30% of the processor: append at the
      95th percentile 1.93 ms and the newest 50 entries 0.65 ms, within; two-character
      queries within 100 ms in 13 of 15 cases (6.2 to 97.7 ms), but the commonest word in
      the 600,000-entry conversation took 131.9 ms and two common words together there
      169 ms (114.5 ms in the 21,000-entry one). The commonest single character took about
      0.41 s. So the two-character target holds on GitHub's runners on the three platforms
      and is missed on this machine for the commonest words in the largest conversation:
      the owner decides whether that holds 0.6 back; nothing uses search before P2.
    - The numbers below are earlier ones: from before the search change (#171), or from a
      machine loaded by reviews running beside the measurement, two to three times slower.
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
  - Done, chosen 2026-11-12 under the owner's instruction: each entry's indexed terms end
    with a term for its conversation (index form 2, rebuilt by itself on first open), and a
    search ranks the newest 1,000 matches, read backwards from the index, and returns at
    most 1,000. Reading forwards from a row id, or ranking every match, is what took
    seconds: the index has no quick way forwards from a row id.
    - The conversation's term begins with U+E000, a character of private use: SQLite's
      tokenizer keeps it inside a token (checked with SQLite 3.51.2 in Electron 41 and
      3.54.0 in Node.js 26) and `indexText` turns it into a space, so no text and no query
      holds such a token. Its first form, `zc` and hex digits, could be typed, and entries
      of another conversation carrying it hid a search of the right one.
    - The version-1 import numbers entries in the order of their times across
      conversations, so that "the newest 1,000" are the newest entries after the
      migration too; before, they followed the order of file names (`bot-…`, `conv-…`,
      `home`). It reads each transcript once more for the times, and gives one
      conversation's entries row ids all over the table, which SQLite writes more slowly;
      larger transactions (50,000 entries) and a 256 MiB page cache for the import's
      connection take back part of that. Measured with Node.js 26 on 300,000 made-up
      entries on a shared machine, one run each: 31 interleaved conversations 31.4 s
      before, 66.1 s after; one conversation 35.9 s before, 47.2 s after.
    - Ranking still costs something that grows with how common each word is: BM25 counts
      the whole doclist of each phrase it ranks, the conversation's term included. A
      search of one conversation therefore costs in proportion to that conversation's size,
      whatever the word: the review measured a rare word in a conversation of 600,000
      entries at 46 to 68 ms, where it took 0.5 ms before.
    - Measured with the committed script inside Electron 41 (SQLite 3.51.2) on Windows,
      1,000,000 made-up entries, medians of five runs, two runs on a machine that other
      test runs shared (absolute times there are two to three times what a quiet machine
      gives). Under SPEC-014's 100 ms target only where said:
      - Append 7.3 to 13.6 ms at the 95th percentile: misses its 5 ms target on this
        machine. Newest 50 entries 0.5 to 0.8 ms: within its 20 ms.
      - A rare two-character word: 19 to 30 ms over all entries and in a conversation of
        2% of them, within; 151 to 204 ms in the conversation of 60%, missed.
      - A word in some entries (公園): 52 to 89 ms over all and in the small conversation,
        within; 187 to 314 ms in the large one, missed.
      - A word in most entries (今天): 131 to 194 ms over all, 154 to 205 ms in the small
        conversation, 294 to 496 ms in the large one, all missed.
      - One common character: 0.7 to 1.6 s everywhere. Two common words together: 139 to
        558 ms. Missed.
      - The independent review measured, on the same kind of machine, a word in most
        entries at 53 to 130 ms in a conversation of 21,000 entries (one five-run median
        155.9 ms), 97 to 350 ms in the large conversation, and 公園 there at 66 to
        226 ms.
      - Before this change the same kind of queries took 74 ms to 3.4 s. The numbers here
        come from a script whose made-up text no longer repeats after ten thousand
        entries; the first measurements of this task used text that did, with only a few
        hundred different entries, and were lower.
    - `scripts/testing/measure-store-performance.mjs` makes such a database and measures
      every target; the manual `store performance` workflow runs it on the three platforms,
      under Node.js and inside Electron, once it is on `main`.
    - Known and left as they are:
      - The cost of a search of one conversation grows with that conversation's size (see
        above). Ranking only the words typed, in a second step, is the way to remove it.
      - The conversation's term changes the ranking inside small conversations, where it
        is rare: an entry with more of the words can rank below a shorter one. The review
        found the order changed in 104 of 208 queries, the matches themselves only where
        more than 1,000 matched.
      - The next change of index form rebuilds the index when a writer opens, before the
        core publishes its channel: a million entries took 154 to 171 s, past the hub's
        60 s start. Form 1 never shipped, so 0.6 is not affected; the next form change
        has to give the start the time the migration gets.
      - Searching on a reader off the core's thread, and a cap on how much of one entry is
        indexed.
  - From the second review of #171, which found nothing that blocks:
    - Fixed: the index form is 3, since the conversation's term changed after form 2 was
      made on the branch; a time more than a day after the import, as a clock set forward
      leaves it, counts as one that cannot be read, so that it does not put the rest of its
      conversation after every other.
    - Measured by the review (Node.js 26, one or two runs, shared machine): importing a
      million entries took 144 s before the time-ordered row ids and 273 s after, with
      974 and 1,242 MiB at most; deleting a conversation of a 300,000-entry migrated
      database 1.13 s before and 1.82 s after. The conversation's term makes an append
      about half again as long at the median (0.63–0.69 ms to 0.95–1.0 ms) and 3.0–4.2 ms
      at the 95th percentile, within 5 ms; the 7.3–13.6 ms in the PR's measurement came
      from a loaded machine, where the same code measured 8.6 ms once.
    - Left as they are: the measurement samples 200 appends, where 5 to 12 pass 5 ms on
      a busy machine; how large the write-ahead log grows during the import's batches of
      50,000; a transcript changed during the import is caught by its count only.
- [ ] 1.8 Release and migration notes for the next minor version, prepared in the bump PR.
      No bump is part of this plan.
  - Draft for the bump PR's `docs/releases/v0.6.0.md`, written 2026-11-12. The owner
    fills in the title, the exact inputs (Runtime selection, shared UI, tool pins) and the
    validation from the bump itself, and edits anything below; nothing here was published.

    > **Each bot's data moves into one database.** The first start of 0.6 moves a bot's
    > conversations, transcripts, reply presentations and journal into `bot.db`, a SQLite
    > database in the bot's folder, with a full-text index of every entry (SPEC-014,
    > ADR-021). The note opens on the newest page of a conversation and loads older pages
    > as it scrolls, a few milliseconds each on long conversations. Once a day, while it is
    > idle, the bot keeps a snapshot of its database in `backups/` (the three newest), and
    > after each start it checks the database in the background; a damaged one stops the
    > bot, which the hub then leaves stopped, with a report naming the newest snapshot.
    > `cats-bot export <conversation>` writes a conversation as JSON lines, and
    > `cats-bot reindex` rebuilds the search index.
    >
    > **Migration (persisted data; this is why 0.6 is a new minor version).**
    > - It runs once, at a bot's first start or first change on 0.6, under the bot's lock.
    >   It copies the version-1 files to `migration-backup/<time>/` with a manifest,
    >   imports them, checks the database against the files, and marks it finished in one
    >   durable transaction. Only then is the profile raised to schema 3 and the files
    >   moved to `archive/v1/`. A migration stopped at any point, a power cut or Quit
    >   included, is done again by the next start.
    > - A large bot takes minutes: in reviews on a busy machine, a million entries took
    >   about 4.5 minutes and up to 1.2 GB of memory; 100,000 small conversations took about
    >   13 minutes before entries were numbered by time, which made the import slower. A transcript or journal over about 512 MB cannot be read, by 0.5 or by
    >   the migration. The hub shows the bot as starting meanwhile, gives it up to an hour,
    >   and starts the other bots beside it; Quit ends the migration.
    > - When the import finds something it cannot keep as it was (an entry out of order,
    >   two files of one conversation), the bot does not start; `core.log` names the report
    >   in `migration-backup/<time>/report.md`, and the files stay as they were. What it
    >   only reports (a broken line 0.5 skipped too, a file no reader read) is in the same
    >   report, and the bot starts.
    > - To go back to 0.5: quit the bot and run `cats-bot restore` with 0.6's CLI. It puts
    >   the version-1 files back, sets the database aside as `bot.db.set-aside-<time>` and
    >   lowers the profile, so 0.5.9 starts the bot as it was before the migration. What
    >   was written on 0.6 stays in the database set aside. 0.5.9 refuses a migrated bot
    >   ("Unsupported profile schema") instead of starting it empty.
    >
    > **Worth knowing.**
    > - `migration-backup/` and `archive/v1/` keep what the bot held before the migration,
    >   prompts of conversations deleted since included, until you remove them; remove
    >   them once 0.6 has run well. The snapshots in `backups/` keep a deleted
    >   conversation for three more days.
    > - Deleting a conversation now also deletes its work items and their journal lines,
    >   which held its prompts; a delivery of a deleted conversation is answered as
    >   cancelled.
    > - Keep `CATS_BOT_HOME` on a local disk: SQLite's write-ahead log does not work on a
    >   network share. Nothing refuses one.
    > - The check after each start and the daily snapshot read the whole database in a
    >   process of their own (about 16 s and 9 s for 330 MB); a stop ends them at once.
    > - Search is not yet used by any feature; it is there for the memory work that
    >   follows. Over a million entries, on the three platforms, a two-character Chinese
    >   query took 2 to 51 ms and one common character 0.1 to 0.26 s (PLAN-014 1.7).
    > - A host without the lock (`cats-bot status`, `conversations`) shows nothing of a bot
    >   not migrated yet, until its first start or change.
    > - Builds of `main` from before this release wrote an earlier database schema; 0.6
    >   upgrades such a database when it opens it, and those builds refuse it afterwards.

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
