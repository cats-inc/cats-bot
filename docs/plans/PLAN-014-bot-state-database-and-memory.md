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
  - What the acceptance run found, and the defaults it proposes for the adapter. The ones
    that change SPEC-014 are in its Open Questions and wait for the owner.
    - **Hosts that only read.** Today `BotCore.open` reads the files in its own process,
      without the lock (the CLI's `status`, `conversations` and `schedule list`). Proposed:
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
      - This touches SPEC-014 FR-1 and ADR-021 decision 1, which say other hosts reach
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
- [ ] 1.3 Full-text index with the bigram column, query builder, the LIKE path for single
      characters, and a rebuild command.
- [ ] 1.4 `BotHostApi` paged transcript read and note paging. `conversationTranscript` keeps
      working.
- [ ] 1.5 Migration (backup, import, verify, marker, profile schema raise, archive), failure
      report and `cats-bot restore`.
  - Fixtures: a copied version-1 data root, crash at each step including after the marker,
    corrupt lines, an unknown schema, and an older binary refusing the raised profile.
- [ ] 1.6 Daily `VACUUM INTO` snapshot, startup `quick_check`, and `cats-bot export`.
- [ ] 1.7 Performance targets of SPEC-014 on the three platforms.
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

- **Index design.** The bigram shadow column was chosen because trigram and unicode61 both
  miss 2-character Chinese words; the survey's probe covered this. It is re-checked with the
  P2 evaluation set.
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
