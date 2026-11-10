# PLAN-014: Bot State Database and Memory

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Draft, 2026-11-11. No phase is authorized. P1 waits for ADR-021; P2–P6 wait for ADR-022 and the security review |
| **Owner** | Bot core store and memory |
| **Assigned To** | Unassigned |
| **Reviewer** | Owner; independent review per phase; independent security review before P3 |

## Related Spec

- [SPEC-014: Bot state database and migration](../specs/SPEC-014-bot-state-database-and-migration.md)
- [SPEC-015: Bot memory: layers, recall and consolidation](../specs/SPEC-015-bot-memory-layers-recall-and-consolidation.md)
- Decisions: [ADR-021](../decisions/021-keep-each-bots-state-in-a-sqlite-database.md),
  [ADR-022](../decisions/022-give-each-bot-layered-memory-it-consolidates-while-asleep.md)
- Evidence: [agent memory architecture survey](../research/2026-11-11-agent-memory-architecture-survey.md)

## Overview

The store comes first, because memory and recall need it. Recall is useful without any
consolidation. Core memory and owner controls come before the bot writes anything
automatically. Consolidation waits for a Runtime capability and the security review.
Embeddings come only if the evaluation asks for them.

## Implementation Phases

### P0: Decisions and prerequisites

- [ ] Owner decides ADR-021, which unblocks P1.
- [ ] Owner decides ADR-022's six open decisions, which unblocks P2 onward.
- [ ] Independent security review of SPEC-015 before P3.
- [ ] A Runtime tool-free, handoff-free, memory-free session, ephemeral where supported, on
      the providers bots use (SPEC-012 FR-13, Runtime ADR-050). This blocks P4 only, and it
      is shared with SPEC-012 Phase 2.

### P1: State database (SPEC-014), blocked on ADR-021 only

- [ ] 1.1 Storage adapter over `node:sqlite`, schema, and `meta` with versions; driver
      acceptance on Windows, macOS and Linux under the shipped Electron.
- [ ] 1.2 Move writers and readers:
  - conversations and attachments;
  - transcript entries (append-only `seq`);
  - presentations (row upsert, existing 100 ms throttle);
  - work items and transitions; schedules;
  - startup without journal replay.
- [ ] 1.3 Full-text index with the bigram column, query builder, the LIKE path for single
      characters, and a rebuild command.
- [ ] 1.4 `BotHostApi` paged transcript read and note paging. `conversationTranscript`
      keeps working.
- [ ] 1.5 Migration (backup, import, verify, marker, archive), failure report and
      `cats-bot restore`.
  - Fixtures: a copied version-1 data root, crash at each step, corrupt lines, an unknown
    schema.
- [ ] 1.6 Daily `VACUUM INTO` snapshot, startup `quick_check`, and `cats-bot export`.
- [ ] 1.7 Performance targets of SPEC-014 on the three platforms.
- [ ] 1.8 Release and migration notes for the next minor version, prepared in the bump PR.
      No bump is part of this plan.

**Deliverables**: every bot runs on `bot.db`; the version-1 files are archived; search is
available to the core.

### P2: Recall (SPEC-015 FR-10–FR-12, FR-24–FR-27)

- [ ] 2.1 Recall service over evidence, with scope and trust filters and fenced rendering
      with dates.
- [ ] 2.2 Recall-intent detection (zh-TW and English) and injection into the turn's
      instructions within budget.
- [ ] 2.3 `memory_search` / `memory_get` MCP tools for providers that accept session MCP;
      not offered in contact notes.
- [ ] 2.4 Evaluation set v1 from fixture conversations, and its runner.

**Deliverables**: a bot can find specifics past the handoff pack on every provider.

### P3: Core memory and owner controls (SPEC-015 FR-1–FR-7, FR-21–FR-23), after the security review

- [ ] 3.1 Records, versions, scope and trust; deletion rules (FR-4).
- [ ] 3.2 Core-memory rendering in session instructions, and the live-session delta.
- [ ] 3.3 `remember` / `forget` MCP tools, validated by the core, with the budget refusal.
- [ ] 3.4 Settings Memory section: list, search, edit, retire, evidence, versions, restore,
      switches and export.

**Deliverables**: the owner and tool-capable bots can maintain core memory, and the owner
controls all of it.

### P4: Consolidation (SPEC-015 FR-13–FR-20), blocked on the Runtime session in P0

- [ ] 4.1 Consolidation work item, scheduling after the direct message sleeps (SPEC-011),
      the heartbeat-off schedule, and watermarks.
- [ ] 4.2 Input builder with bounded, fenced evidence (owner and bot lines only).
- [ ] 4.3 Proposal schema, validation, loss guard, automatic additions and the approval
      queue.
- [ ] 4.4 Token caps per run and per day, and usage records.
- [ ] 4.5 Optional dream diary, off by default.

**Deliverables**: bots improve their memory overnight within a known cost.

### P5: Working summaries and handoff (SPEC-015 FR-8–FR-9)

- [ ] 5.1 Consolidation maintains one working summary per conversation.
- [ ] 5.2 Handoff pack: summary first, recent entries, stale marker, tool pointer, and a
      budget scaled to the model's context.
- [ ] 5.3 The assist-heartbeat review (SPEC-011 FR-13) may use working summaries.
      Independently, it should stop rendering error lines. That is a small fix that can
      land earlier.

**Deliverables**: replacement sessions start from a summary, not from clipped lines.

### P6: Evaluation and the embeddings decision

- [ ] 6.1 Run the evaluation on recall and on post-consolidation memory, and record misses.
- [ ] 6.2 Owner decision on embeddings (local first) from the results. Nothing is built
      without it.

## Files to Create/Modify

- **Create**:
  - `src/core/store/database.ts` (adapter), `schema.ts`, `migrate.ts`, `search.ts`;
  - `src/core/memory/*` (records, recall, consolidation, rendering);
  - tests under `tests/core/store/` and `tests/core/memory/`;
  - fixtures of a version-1 data root.
- **Modify**:
  - `src/core/conversations/store.ts`, `src/core/store/journal.ts`,
    `src/core/store/presentation.ts`, `src/core/bot.ts`, `src/core/conversations/binder.ts`
    and `handoff.ts`, `src/core/queue/turnRunner.ts`;
  - `src/core/host-api/commands.ts`, `src/cli/main.ts`;
  - the settings renderer;
  - `docs/architecture.md`, SPEC-001 FR-2/FR-12 (after acceptance), `docs/testing.md`.

## Technical Decisions

- **Index design.** The bigram shadow column was chosen because trigram and unicode61 both
  miss 2-character Chinese words; the survey's probe covered this. It is re-checked with the
  P2 evaluation set.
- **Store before memory.** The store change is independently valuable and independently
  reversible through `cats-bot restore`.
- **Not in this plan**, follow-ups:
  - Measure the token cost of Runtime re-sending session instructions every turn for
    per-turn adapters such as legacy grok.
  - Consider hosted grok so that Bot tools reach it.
  - Record completed actions so that a re-sent turn cannot repeat side effects (Paperclip's
    receipts).

---

*Created: 2026-11-11*
*Author: Claude*
