# SPEC-015: Bot Memory: Layers, Recall and Consolidation

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Draft, 2026-11-11. Waiting for the owner's decisions in [ADR-022](../decisions/022-give-each-bot-layered-memory-it-consolidates-while-asleep.md) and for an independent security review. Not implemented |
| **Owner** | Bot core memory |
| **Reviewer** | Owner; independent security review before implementation (as for SPEC-009 and SPEC-012) |
| **Depends on** | [SPEC-014](SPEC-014-bot-state-database-and-migration.md); a Runtime tool-free session (SPEC-012 FR-13, Runtime ADR-050) for consolidation |
| **Would update** | SPEC-001 FR-12 (handoff pack); SPEC-011 FR-13 (the assist review may read working summaries). Annotated only after acceptance |

## Summary

A bot remembers its owner across sessions, provider changes and restarts.

- **Layers.** Above the evidence of ADR-021 sit:
  - a working summary per conversation;
  - a small core memory injected into the bot's own conversations;
  - memory pages read on demand;
  - a recall index.
- **Reach.** Memory reaches every provider through instructions and core-side recall;
  tool-capable providers also get memory tools.
- **Consolidation.** Once a night, while the direct message sleeps, a tool-free session
  proposes changes from new evidence. The core validates them, applies additions and queues
  edits for the owner. Every remembered claim points to its evidence.

## Goals

- Facts the owner states are remembered and used in later sessions, including after a
  session is replaced.
- Specifics from long ago can be found, in Chinese and English.
- Remembered content never crosses into contact notes or other bots (SPEC-009, SPEC-012).
- The owner can see, correct, remove and restore everything the bot remembers.
- Cost is bounded and visible.

## Non-Goals

- Embeddings, vector search or an external memory service in this version.
- Sharing memory between bots, or with Cats Desktop.
- Writing provider-native memory files (`CLAUDE.md`, `AGENTS.md`, auto-memory) or any
  memory file in the workspace.
- Procedural memory (skills learned from tasks). It is a possible later step.

## Definitions

- **Evidence**: transcript entries in `bot.db` (SPEC-014), append-only.
- **Scope**: where a record came from:
  - `dm`: the direct message, including Telegram;
  - `note`: an owner note;
  - `contact`: a contact note with another bot.
- **Trust**: how far a record can be relied on:
  - `owner_stated`: the owner said it;
  - `bot_inferred`: derived by the bot;
  - `untrusted`: tool output, web or file content, or another bot's words.
- **Core memory**: short records about the owner, the bot and their relationship, injected
  into the bot's own conversations.
- **Memory page**: a titled page of claims about a topic, person or ongoing matter. Each
  claim links to the evidence entries it came from.
- **Working summary**: one summary per conversation, rewritten by consolidation.
- **Consolidation**: the nightly run that proposes memory changes. In product copy it is
  called dreaming (做夢).
- **Watermark**: the last evidence entry per conversation that consolidation has
  processed.

## Requirements

### Functional Requirements

#### Records and placement

1. FR-1: Memory records live in `bot.db`.
   - Modules sit under `src/core/memory` and import nothing from the shell, renderer or
     Electron.
   - Record shapes follow Platform SPEC-022 / SPEC-031 (subject, category, content, source
     references, visibility, lineage), so the module can become a package under Platform
     ADR-142.
2. FR-2: Every record has:
   - kind (core, page claim, working summary);
   - scope and trust;
   - evidence entry ids;
   - status: active, superseded or retired;
   - versions with the actor (consolidation, bot tool or owner) and time.
3. FR-3: Untrusted content never becomes a record. Contact-scope content never becomes core
   memory or a page claim.
4. FR-4: Deleting a conversation retires records whose evidence is only in it, and removes
   that conversation's evidence links from the others.

#### Injection

5. FR-5: Core memory has a per-bot budget, 4,000 characters by default.
   - It is rendered as a fenced, dated data block and placed after the persona and reply
     language in session instructions when a session is created (SPEC-001 FR-11).
   - A bot tool write that would exceed the budget is refused with the current usage, so
     the bot must merge or drop items.
6. FR-6: When core memory changes while a session is live, the next turn's instructions
   carry one short delta (added, changed, removed) and no more. The next new session gets
   the full snapshot.
7. FR-7: Core memory and recall results are never injected into:
   - contact-note conversations;
   - hub status answers (SPEC-012);
   - consolidation sessions, where memory is input data, not instructions;
   - any other bot.

#### Working summaries and handoff

8. FR-8: When a conversation has a working summary, the handoff pack for a new or
   replacement session contains, in order:
   - the summary;
   - the most recent verbatim entries;
   - a note that the summary may be outdated;
   - for tool-capable providers, a pointer to `memory_search`.

   The budget scales with the target model's context window, between 12,000 and 48,000
   characters.
9. FR-9: Without a working summary, SPEC-001 FR-12's pack applies unchanged.

#### Recall

10. FR-10: Before an owner turn whose message asks about the past, the core searches
    evidence and memory pages in the allowed scopes (FR-24).
    - Recall intent is detected with zh-TW and English patterns, for example 上次, 之前,
      還記得, 那時候, last time, remember.
    - Up to 5 results, at most 2,000 characters with their dates, go into that turn's
      instructions, fenced as data and marked possibly outdated.
    - Heartbeat and scheduled turns get no recall.
11. FR-11: Providers that accept session MCP get `memory_search` (query, optional scope,
    limit ≤ 10) and `memory_get` (a record, or an entry range). Both are scope-filtered and
    fenced, and they are not offered in contact-note or consolidation sessions.
12. FR-12: By default, recall returns only owner and bot lines. Tool output, other bots'
    messages and heartbeat prompts are excluded.

#### Consolidation

13. FR-13: When it runs:
    - **Schedule.** Once per local day, after the direct message falls asleep in rest hours
      (SPEC-011 FR-16, FR-17). A bot without rest hours (heartbeat off) uses 03:30 local
      once idle for 30 minutes.
    - **Needs new evidence.** It runs only when some conversation has entries past its
      watermark.
    - **Priority.** It is a low-priority work item that never preempts owner messages and
      can be cancelled.
    - **Skips.** It is skipped while Runtime is unavailable, a guardrail is active or a turn
      is running.
14. FR-14: It runs in a Runtime session that is ephemeral where supported (Runtime ADR-050)
    and has none of the following:
    - MCP servers;
    - file or command tools;
    - a handoff pack;
    - provider-native project memory.

    This is the same prerequisite as SPEC-012 FR-13. If the bot's provider cannot offer such
    a session, consolidation stays off for that bot, and its settings say why.
15. FR-15: The input contains:
    - new evidence past the watermark: owner and bot lines only, with tool output shown as
      "[tool output omitted]" and other bots' messages excluded;
    - the current core memory;
    - memory pages found by recall for that evidence.

    Each run is bounded to about 40,000 characters of evidence, and an older backlog
    continues on following nights. Everything is fenced as data, with ids.
16. FR-16: Promotion rules:
    - An `owner_stated` fact may be added at the next consolidation.
    - A `bot_inferred` pattern needs evidence from at least two distinct local days.
    - Untrusted and contact-scope content is never promoted.
17. FR-17: The output is a JSON list of proposals. Anything else is rejected without
    changes. Each proposal carries:
    - an action: `add`, `merge`, `supersede`, `retire` or `summarize`;
    - a target kind;
    - text within limits;
    - evidence entry ids;
    - scope and trust.
18. FR-18: The core validates each proposal before applying it:
    - **Checks**: the evidence ids exist and are in allowed scopes, text is within limits,
      and the core-memory budget holds.
    - **Loss guard**: a run may supersede or retire at most 25% of active records.
    - **Applied automatically**: `add` and `summarize`.
    - **Queued for the owner**: `merge`, `supersede` and `retire` of existing records
      (FR-22).
    - **Versions**: every applied change creates a version.
    - **Failure**: a failed validation changes nothing and is logged.
19. FR-19: Model and cost:
    - It uses the bot's execution target, unless the owner sets a separate consolidation
      target.
    - Caps: input plus output tokens per run (60,000 by default) and per day (120,000 by
      default).
    - Usage is recorded like other turns.
    - Reaching a cap ends the run, and the rest waits for the next night.
20. FR-20: The watermark advances only after a successful apply, so a failed run retries the
    next night. An optional dream diary is off by default. When enabled, it adds one short
    morning note in the direct message saying what changed, with a link to the memory
    settings.

#### Owner controls

21. FR-21: Bot settings gain a Memory section:
    - list and search records by kind, scope and trust;
    - edit text, or retire a record;
    - open the evidence entries;
    - restore any version.

    Owner actions apply at once and are versioned.
22. FR-22: An approval queue lists queued proposals with their evidence, to approve or
    reject. Unanswered proposals expire after 14 days.
23. FR-23: Per-bot switches: consolidation on or off, recall on or off, and export of memory
    as JSON and Markdown.

#### Privacy

24. FR-24: Scope rules:
    - `dm` and `note` memory is used in the bot's own direct message and notes.
    - It is never used in contact notes, hub answers, other bots or Cats Desktop.
    - `contact` evidence is recalled only inside its own contact note.
25. FR-25: Remembered text is always fenced as data with its source dates. Text that matches
    instruction-like or credential patterns is blocked from injection, and the owner sees
    it marked in settings.
26. FR-26: Telegram messages are `dm` scope (SPEC-001 FR-19; only the owner's private chat
    is accepted).

#### Evaluation

27. FR-27: An evaluation set of zh-TW and English "should remember" questions, built from
    fixture conversations and never from owner data, runs against recall and against core
    memory after a consolidation. Results are recorded. Embeddings are considered only if
    recall misses exceed the threshold set with the first results.

### Non-Functional Requirements

- **Cost**: no model call outside consolidation, owner turns, and tool calls the bot makes.
  Recall and injection are core-side.
- **Latency**: recall adds at most 100 ms to an owner turn on the reference machine.
- **Security**: an independent review before implementation. It covers memory poisoning
  through evidence, prompt injection through remembered text, cross-scope leaks, the
  consolidation session's capabilities and the approval flow.
- **Compatibility**: new tables in `bot.db`. No change to the provider-native files.

## Design Overview

```text
evidence (SPEC-014) ──► recall index ──► core-side recall ──► turn instructions
      │                      ▲                          └──► memory_search (MCP)
      ▼ nightly, tool-free   │
consolidation ──► proposals ──► core validation ──► records ──► core memory ──► session instructions
                                     │                    └──► memory pages
                                     └──► owner approval queue
```

## Open Questions

- [ ] The six decisions in [ADR-022](../decisions/022-give-each-bot-layered-memory-it-consolidates-while-asleep.md#open-decisions),
      each with a proposed default.
- [ ] Dream diary default (FR-20). Proposed: off.
- [ ] Handoff budget bounds (FR-8). Proposed: 12,000 to 48,000 characters.
- [ ] Consolidation time for bots without rest hours (FR-13). Proposed: 03:30 local.
- [ ] Approval expiry (FR-22). Proposed: 14 days.

## References

- [Agent memory architecture survey](../research/2026-11-11-agent-memory-architecture-survey.md)
- [ADR-022](../decisions/022-give-each-bot-layered-memory-it-consolidates-while-asleep.md),
  [ADR-021](../decisions/021-keep-each-bots-state-in-a-sqlite-database.md)
- [SPEC-011](SPEC-011-heartbeat-modes-rhythm-and-backoff.md),
  [SPEC-012](SPEC-012-boss-cat-status-board-and-contact-notes.md),
  [SPEC-009](SPEC-009-boss-cat-role.md)

---

*Created: 2026-11-11*
*Author: Claude*
*Related Plan: [PLAN-014](../plans/PLAN-014-bot-state-database-and-memory.md)*
