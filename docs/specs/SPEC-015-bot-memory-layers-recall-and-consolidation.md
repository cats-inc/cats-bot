# SPEC-015: Bot Memory: Layers, Recall and Consolidation

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Approved by the owner on 2026-11-11 with [ADR-022](../decisions/022-give-each-bot-layered-memory-it-consolidates-while-asleep.md)'s proposed defaults and the proposed answers below. Not implemented. Implementation waits for an independent security review and the Runtime prerequisites of [PLAN-014](../plans/PLAN-014-bot-state-database-and-memory.md) P0 |
| **Owner** | Bot core memory |
| **Reviewer** | Owner; independent security review before implementation (as for SPEC-009 and SPEC-012) |
| **Depends on** | [SPEC-014](SPEC-014-bot-state-database-and-migration.md); Runtime turn-scoped context ([Runtime SPEC-042](https://github.com/cats-inc/cats-runtime/blob/main/docs/specs/SPEC-042-turn-scoped-context.md)); a Runtime text-only session ([Runtime SPEC-043](https://github.com/cats-inc/cats-runtime/blob/main/docs/specs/SPEC-043-text-only-sessions.md), SPEC-012 FR-13). Both are approved and not implemented |
| **Updates when implemented** | SPEC-001 FR-1 and FR-5 (an optional consolidation target in the profile and the private Runtime), FR-11 and FR-12 (session instructions, handoff pack); SPEC-011 FR-13 (the assist review may read working summaries) |

## Summary

A bot remembers its owner across sessions, provider changes and restarts.

- **Layers.** Above the evidence of ADR-021 sit:
  - a working summary per conversation;
  - a small core memory injected into the bot's own conversations;
  - memory pages read on demand;
  - a recall index.
- **Reach.** Core memory reaches every provider through the session instructions. Recall
  reaches tool-capable providers through MCP tools, and every provider once Runtime can carry
  one-turn context.
- **Consolidation.** Once a night, while the direct message sleeps, a tool-free session
  proposes changes from new evidence. The core validates them, derives their trust from the
  evidence, applies additions and queues edits for the owner. Every remembered claim points
  to its evidence.

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
- **Trust**: how far a record can be relied on, always derived by the core from the cited
  evidence:
  - `owner_stated`: the owner wrote it;
  - `bot_inferred`: derived from the bot's own lines;
  - `untrusted`: tool output, web or file content, or another bot's words.
- **Core memory**: short records about the owner, the bot and their relationship, injected
  into the bot's own conversations.
- **Memory page**: a titled page of claims about a topic, person or ongoing matter. Each
  claim links to the evidence entries it came from.
- **Working summary**: one summary per conversation, rewritten by consolidation. Contact
  notes have none.
- **Turn-scoped context**: text delivered for one execution only and not persisted. It is
  Runtime's `turnContext` field (Runtime SPEC-042), which is specified and not yet
  implemented; turn `instructions` persist, so they are not it.
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
   - scope and derived trust;
   - evidence entry ids;
   - status: active, superseded or retired;
   - versions with the actor (consolidation, bot tool or owner) and time.
3. FR-3: Untrusted content never becomes a record. Contact-scope content never becomes core
   memory, a page claim or a working summary.
4. FR-4: Deleting a conversation retires records whose evidence is only in it, and removes
   that conversation's evidence links from the others.

#### Injection

5. FR-5: Core memory has a per-bot budget, 4,000 characters by default.
   - It is rendered as a fenced, dated data block and placed after the persona and reply
     language in the session instructions when a session is created (SPEC-001 FR-11).
   - Every adapter composes session instructions into every turn, so the budget is paid per
     turn. The P0 cost measurement in PLAN-014 sets the final default.
   - A bot tool write that would exceed the budget is refused with the current usage, so
     the bot must merge or drop items.
6. FR-6: Live-session changes.
   - Once Runtime offers turn-scoped context, a core-memory change made while a session is
     live reaches it as one short delta (added, changed, removed) in the next owner turn's
     turn-scoped context.
   - Until then, the change reaches the next new session.
   - Turn `instructions` are never used for this, because Runtime persists them in place of
     the session instructions.
7. FR-7: Core memory and recall results are never injected into:
   - contact-note conversations;
   - hub status answers (SPEC-012);
   - consolidation sessions, where memory is input data, not instructions;
   - any other bot.

#### Working summaries and handoff

8. FR-8: When a conversation has a working summary and Runtime offers turn-scoped context,
   the handoff for a new or replacement session goes once, as turn-scoped context on its
   first turn. It contains, in order:
   - the summary;
   - the most recent verbatim entries;
   - a note that it may be outdated;
   - for tool-capable providers, a pointer to `memory_search`.

   The budget scales with the target model's context window, between 12,000 and 48,000
   characters, and never exceeds the turn size Runtime reports for the target
   (`maxTurnInputChars`, Runtime SPEC-042 R5). Adapters that pass the prompt as a process
   argument cannot carry more than about 32,000 characters in total on Windows. The
   provider's native history then carries the handoff, and it is not re-sent with every
   turn.
9. FR-9: Otherwise the handoff stays as today: in the session instructions with SPEC-001
   FR-12's 12,000-character cap. When a working summary exists, it replaces the clipped
   older part.

#### Recall

10. FR-10: Core-side recall.
    - Before an owner turn whose message asks about the past, the core searches evidence and
      memory pages in the allowed scopes (FR-24).
    - Recall intent is detected with zh-TW and English patterns, for example 上次, 之前,
      還記得, 那時候, last time, remember.
    - Up to 5 results, at most 2,000 characters with their dates, are fenced as data, marked
      possibly outdated, and delivered as turn-scoped context.
    - Heartbeat and scheduled turns get no recall.
    - Until Runtime offers turn-scoped context, core-side recall is not injected, and only
      FR-11 tools provide recall.
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
14. FR-14: It runs in a Runtime text-only session (Runtime SPEC-043). Such a session keeps
    no resumable native conversation, can be deleted together with its content, and has
    none of the following:
    - MCP servers;
    - file or command tools;
    - a handoff pack;
    - provider-native memory.

    This is the same prerequisite as SPEC-012 FR-13.
    - **Checks.** The core reads Runtime's `textOnly` capability before it creates the
      session and confirms the create readback before it sends anything. Without both, it
      sends nothing and deletes the session.
    - **Unsupported targets.** If the target in use (FR-19) cannot offer such a session,
      consolidation stays off for that bot, and its settings say why. At Runtime's baseline
      no CLI adapter qualifies yet.
    - **Output.** A text-only turn's text arrives when the turn ends, not as a stream.
    - **Deletion.** The session is deleted after each run.
15. FR-15: Input:
    - **Evidence** past each conversation's watermark, from `dm` and `note` conversations
      only. It contains owner and bot lines only: tool output is shown as "[tool output
      omitted]", and contact notes and other bots' messages are excluded.
    - **Memory**: the current core memory, and the memory pages found by recall for that
      evidence.
    - **Batches**: evidence goes in batches bounded in estimated tokens, at most half of
      FR-19's per-run cap. CJK text is counted at one token per character, and other text at
      one per four characters.
    - **Scope**: a batch never mixes scopes. A working summary is written only from its own
      conversation's evidence.
    - Everything is fenced as data, with ids.
16. FR-16: Promotion rules:
    - An `owner_stated` fact may be added at the next consolidation.
    - A `bot_inferred` pattern needs evidence from at least two distinct local days.
    - Untrusted content is never promoted.
17. FR-17: The output is a JSON list of proposals. Anything else is rejected without
    changes. Each proposal carries:
    - an action: `add`, `merge`, `supersede`, `retire` or `summarize`;
    - a target kind;
    - text within limits;
    - evidence entry ids.

    A proposal's own trust or scope is ignored.
18. FR-18: The core validates each proposal before applying it:
    - **Evidence**: the cited ids exist and are in `dm` or `note` scope.
    - **Trust** is derived from the cited entries:
      - `owner_stated` if any cited entry is owner-written;
      - otherwise `bot_inferred`;
      - rejected if the only support is untrusted.
    - **Promotion**: FR-16's day rule is checked against the entries' dates.
    - **Limits**: text is within limits, and the core-memory budget holds.
    - **Loss guard**: a run may supersede or retire at most 25% of active records.
    - **Applied automatically**: `add` and `summarize`.
    - **Queued for the owner**: `merge`, `supersede` and `retire` of existing records
      (FR-22).
    - **Versions**: every applied change creates a version.
    - **Failure**: a failed validation changes nothing and is logged.
19. FR-19: Target and cost:
    - **Default target.** Consolidation uses the bot's own execution target.
    - **Separate target.** The owner may name a consolidation target for a bot: a provider,
      an instance and a model in the bot's private Runtime.
      - It must be a target for which Runtime reports the `textOnly` capability. Runtime's
        API backends (Anthropic, OpenAI, Gemini, and a local model through Ollama) are the
        expected first ones.
      - It is used for consolidation only. Conversations keep running on the bot's one
        execution target, and changing the consolidation target makes no conversation
        attachment stale.
    - **Consent.** Naming a provider other than the bot's own sends that provider
      everything a consolidation run reads (FR-15): the owner's and the bot's lines from the
      direct message and notes, the current core memory, and the memory pages recalled for
      them.
      - The setting names the provider and says so before it is saved.
      - Bot never selects or switches a consolidation target by itself.
      - A local model keeps the text on the machine only when its endpoint is on the
        loopback interface. The setting says which case applies.
    - **Credentials.** A key for the separate target is a billable secret.
      - It is stored in the bot's `secrets.json` only when the host can encrypt it at rest.
        Without a cipher the setting refuses the key.
      - It reaches the private Runtime through an environment variable with a Cats-private
        name. A provider's standard variable name is never used, because the conversation's
        CLI could pick it up and change how it signs in or bills.
      - It never appears in the configuration file, the profile, the journal or logs.
    - **Runtime prerequisite.** Runtime passes its whole environment to every provider CLI
      it starts, so a conversation's CLI, which has tools and reads untrusted input, could
      read the key. A separate target cannot be enabled until Runtime keeps API-backend
      credentials out of CLI processes (PLAN-014 P0).
    - **Private Runtime.** The generated provider configuration gains the consolidation
      target beside the conversation provider. Adding, changing or removing it restarts the
      private Runtime under SPEC-001 FR-27's rules: after the running turn, and never in
      the middle of one. Whether an app-managed Runtime can host a CLI target and an
      API-backend target together is not yet verified.
    - **No fallback.** If the target in use stops qualifying, or its key is missing or
      refused, consolidation is off and the settings say why (FR-14).
    - **Caps**: input plus output tokens per run (60,000 by default) and per day (120,000 by
      default).
    - Usage is recorded like other turns, with the target that ran it.
    - Reaching a cap ends the run, and the remaining batches wait for the next night.
20. FR-20: Watermarks and diary:
    - **Watermarks.** A conversation's watermark advances per successfully applied batch.
    - **Failed batches.** A batch that fails twice is halved. A single entry that still fails
      is skipped, listed in settings, and the watermark moves past it, so a run cannot stall.
    - **Dream diary.** Off by default. When enabled, it adds one short morning note in the
      direct message saying what changed, with a link to the memory settings.

#### Owner controls

21. FR-21: Bot settings gain a Memory section:
    - list and search records by kind, scope and trust;
    - edit text, or retire a record;
    - open the evidence entries;
    - restore any version.

    Owner actions apply at once and are versioned.
22. FR-22: An approval queue lists queued proposals with their evidence, to approve or
    reject. Unanswered proposals expire after 14 days.
23. FR-23: Per-bot switches: consolidation on or off, the consolidation target with its
    consent text and key (FR-19), recall on or off, and export of memory as JSON and
    Markdown.

#### Privacy

24. FR-24: Scope rules:
    - `dm` and `note` memory is used in the bot's own direct message and notes.
    - It is never used in contact notes, hub answers, other bots or Cats Desktop.
    - `contact` evidence is recalled only inside its own contact note. It never feeds
      consolidation, summaries or another conversation. This follows SPEC-012 FR-8: no
      contact-note session receives owner-written entries.
25. FR-25: Remembered text is always fenced as data with its source dates. Text that matches
    instruction-like or credential patterns is blocked from injection, and the owner sees it
    marked in settings.
26. FR-26: Telegram messages are `dm` scope. Only the owner's private chat is admitted
    (SPEC-001 FR-26).

#### Evaluation

27. FR-27: An evaluation set of zh-TW and English "should remember" questions, built from
    fixture conversations and never from owner data, runs against recall and against core
    memory after a consolidation. Results are recorded. Embeddings are considered only if
    recall misses exceed the threshold set with the first results.

#### Bot tool writes

28. FR-28: Providers that accept session MCP get `remember` (text and evidence entry ids)
    and `forget` (a record id), except in contact-note and consolidation sessions.
    - Each call is a proposal, validated by FR-18.
    - It applies at once only when every cited entry is an owner-written entry among the
      last 20 entries of the same conversation.
    - Otherwise it joins the approval queue (FR-22).
    - A call citing untrusted entries only is refused.

### Non-Functional Requirements

- **Cost**: no model call outside consolidation, owner turns, and tool calls the bot makes.
  Recall and injection are core-side. Before P2, PLAN-014 P0 measures what session
  instructions cost per turn on each provider.
- **Latency**: recall adds at most 100 ms to an owner turn on the reference machine.
- **Security**: an independent review before implementation. It covers memory poisoning
  through evidence, prompt injection through remembered text, cross-scope leaks, tool
  writes, the consolidation session's capabilities, the approval flow, and a separate
  consolidation target with its consent and key handling.
- **Compatibility**: memory tables are a `bot.db` schema change.
  - Under SPEC-014 FR-4, older binaries refuse the newer schema.
  - So they ship in a minor version, with a tested upgrade path (validation, backup, atomic
    replacement, failure recovery) and release notes.
  - The consolidation target is an optional profile field, normalized field by field like
    SPEC-011's additions. A profile without it uses the bot's own target.

## Design Overview

```text
evidence (SPEC-014) ──► recall index ──► core-side recall ──► turn-scoped context (Runtime, P0)
      │                      ▲                          └──► memory_search (MCP)
      ▼ nightly, tool-free   │
consolidation ──► proposals ──► core validation (derived trust) ──► records ──► core memory ──► session instructions
                                     │                                  └──► memory pages
                                     └──► owner approval queue ◄── remember/forget (MCP)
```

## Open Questions

All were answered on 2026-11-11 with the proposed options:

- [x] The six decisions in
      [ADR-022](../decisions/022-give-each-bot-layered-memory-it-consolidates-while-asleep.md#decisions-taken).
- [x] Dream diary default (FR-20): off.
- [x] Handoff budget bounds (FR-8): 12,000 to 48,000 characters, once turn-scoped delivery
      exists.
- [x] Consolidation time for bots without rest hours (FR-13): 03:30 local.
- [x] Approval expiry (FR-22): 14 days.

Decided later on 2026-11-11, after Runtime's audit for its text-only sessions:

- [x] Consolidation target (FR-19): the bot's own execution target by default, or a
      separate target the owner names for that bot. This amends ADR-022 decision 6.

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
