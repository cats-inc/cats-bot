# ADR-022: Give Each Bot Layered Memory It Consolidates While Asleep

> The conversation evidence is the bot's own record. Above it sit a summary per
> conversation, a small core memory, memory pages and a recall index. A tool-free
> session builds them overnight from the evidence.

## Status

Accepted, 2026-11-11. The owner chose every proposed default (see Decisions Taken).

The independent review of the same day corrected four mechanisms before acceptance was
recorded; the intent is unchanged:

- **One-turn context.** Runtime persists a send's `instructions` for later turns, so recall
  results, memory deltas and a one-time handoff need a Runtime turn-scoped field.
- **Instruction cost.** Session instructions are re-sent with every turn by every adapter,
  so core memory stays small and the handoff budget only grows once it can be delivered
  once.
- **Consolidation target.** Each bot's private Runtime runs one provider, so a cheaper
  consolidation target means a cheaper model of the same provider.
- **Bot tool writes** are validated, with trust derived from the cited evidence.

Nothing is implemented. Before any memory injection or consolidation:

- an independent security review is required, as it was for SPEC-009 and SPEC-012;
- the Runtime prerequisites in [PLAN-014](../plans/PLAN-014-bot-state-database-and-memory.md)
  P0 must exist.

It depends on [ADR-021](021-keep-each-bots-state-in-a-sqlite-database.md).

## Context

- **What a bot remembers today.**
  - A resumed provider session keeps its native context (PLAN-013).
  - Native sessions can still vanish (Runtime #214), be compacted by the provider, or be
    replaced on a provider or configuration change.
  - A replacement receives only the 12,000-character handoff pack. Its older part is clipped
    lines, not a summary.
  - Nothing durable is learned about the owner, and nothing can be searched.
- **Peers** ([survey](../research/2026-11-11-agent-memory-architecture-survey.md)):
  - All three keep a small, always-injected curated memory and retrieve the rest on demand.
  - OpenClaw consolidates nightly, with provenance, a loss guard and versions, behind a
    conservative promotion gate. Hermes reviews every 10 turns. Paperclip leaves it to
    agents and opt-in routines.
  - None indexes 2-character Chinese words; the two that try fall back to substring scans.
- **Cats boundaries.**
  - Runtime ADR-012: durable memory is product-owned.
  - Platform SPEC-022 / SPEC-031 (drafts) describe the same layers for Desktop.
  - SPEC-009 FR-6 and SPEC-012: no bot reads another bot's transcripts or memory, and
    contact-note sessions never carry owner-written entries. SPEC-012 notes these are API
    limits, not an OS security boundary.
- **Reach.**
  - Bot's MCP tools reach only providers whose Runtime adapter accepts session MCP servers
    (claude, codex, copilot, hosted ACP, muse MSP). Legacy grok gets no Bot tools.
- **Instructions.**
  - Session instructions are composed into every turn's message by every adapter, so their
    size is paid on every turn.
  - A send's `instructions` replaces the session's persisted instructions for later turns.
    Runtime has no field for context that should last one turn.
- **Tool-free sessions.** A session with no tools, no handoff and no provider-native project
  memory, deletable with its history, is not yet offered by Runtime. It is the same
  prerequisite as SPEC-012 FR-13. Runtime ADR-050's ephemeral sessions are verified for Codex
  only.

## Decision

1. **Layers**, aligned with Platform SPEC-022:
   - **Provider-native session**: a continuity aid only.
   - **Evidence**: ADR-021's transcript entries, complete and append-only. No memory
     process edits them.
   - **Working summary**: one per conversation, except contact notes, maintained by
     consolidation. It replaces the clipped digest in handoff packs.
   - **Durable memory**:
     - *core memory*: small and budgeted, injected into the bot's own conversations;
     - *memory pages*: topic and entity pages made of claims, each linked to the evidence
       entries it came from, read on demand.
   - **Recall index**: ADR-021's full-text index over evidence and memory pages.
2. **Canonical form.** Memory is records in `bot.db`, each carrying scope, trust,
   provenance and versions. Any Markdown is a rendering, never the source. Bot writes no
   memory into the workspace, because CLIs auto-load some file names there and the
   workspace is shared by every session of the bot.
3. **Reading.**
   - **Core memory** goes into the session instructions as a snapshot taken at session
     creation. This works for every provider today. A later change reaches the next new
     session.
   - **Turn-scoped context** goes through a Runtime field that is delivered for one execution
     and not persisted, once Runtime offers it. It carries:
     - a live-session delta of core memory;
     - core-side recall results, injected when an owner message asks about the past;
     - a one-time handoff.
   - **Tools.** Providers that accept session MCP get `memory_search` and `memory_get` as
     soon as recall exists.
4. **Writing.**
   - Consolidation extracts memory from evidence; this works for every provider.
   - Providers with MCP may call `remember`/`forget`.
     - A call is a proposal, validated like consolidation output.
     - It applies only when it cites the owner's own recent entries in the same
       conversation.
     - Anything else is queued for the owner.
   - The owner edits memory in settings.
5. **Scope and trust on every record.**
   - **Scope** comes from the conversation: `dm`, `note` or `contact`.
   - **Trust** is derived by the core from the cited evidence, never taken from the
     proposer:
     - `owner_stated` only from owner-written entries;
     - `bot_inferred` from the bot's own lines;
     - `untrusted` from tool output, web or file content, or another bot's words.
   - Untrusted content is never promoted.
   - Contact notes are excluded from consolidation and summaries, and memory is never
     injected into contact-note sessions or answers for another bot.
6. **Consolidation ("dreaming").**
   - **When**: once per local day, after the direct message falls asleep in rest hours
     (SPEC-011), and only when some conversation has evidence past its watermark.
   - **Session**: an owner-invisible, low-priority, cancellable work item. The Runtime
     session is tool-free, handoff-free and memory-free, deletable with its history, and
     ephemeral where supported. It is not enabled until Runtime offers such a session for
     the bot's provider; there is no fallback to a tool-capable session.
   - **Batches**: evidence goes in token-bounded batches, and each conversation's watermark
     advances per applied batch.
   - **Output**: structured proposals (add, merge, supersede, retire, summarize) with
     evidence ids. The core validates scope, derived trust, evidence, budget and a loss
     guard.
   - **Applying**: additions and summaries apply automatically; merges, supersessions and
     retirements wait for the owner. Every change is versioned and restorable.
   - **Model and cost**: it uses the bot's own provider, optionally with a cheaper model of
     that provider. There is a per-run and a daily token cap, recorded as usage, and Runtime
     guardrails stop it.
7. **Search.**
   - BM25 over the bigram-indexed store, with a recency tie-break. Single CJK characters use
     LIKE.
   - No embeddings until a Chinese/English evaluation set shows misses; then local
     embeddings first.
8. **Placement.** `src/core/store` and `src/core/memory` import nothing from the shell,
   renderer or Electron. Their data shapes follow Platform SPEC-022 / SPEC-031, so they can
   become a package under Platform ADR-142. Desktop adoption is Platform's decision.

## Decisions Taken

The owner chose the proposed option for each:

1. **Engine placement**: Bot-local, package-ready modules. Rejected: a shared package from
   the start, or a Runtime service (which conflicts with Runtime ADR-012). See SPEC-015 FR-1
   and PLAN-014 P2–P5.
2. **Canonical form and reach**: database records; session instructions plus core-side
   recall for every provider; MCP tools where accepted. Rejected: Markdown files as the
   source, as all three peers do, which conflicts with SPEC-012 and auto-loaded names. See
   SPEC-015 FR-1–FR-12.
3. **Injection and budget**: about 4,000 characters of core memory, as a snapshot at session
   creation, with a delta once Runtime offers turn-scoped context. Rejected: re-reading every
   turn (OpenClaw), or a snapshot with no delta ever (Hermes). See SPEC-015 FR-5–FR-8 and
   FR-10.
4. **Promotion**: owner-stated facts at the next consolidation; inferred patterns only after
   two distinct days; untrusted never. Rejected: OpenClaw's gate of 3 recalls, 3 distinct
   queries and at most 10 promotions a night. See SPEC-015 FR-16 and FR-18.
5. **Consolidation schedule and approval**: nightly after the direct message sleeps;
   additions automatic; edits and removals approved. Rejected: every N turns (Hermes; no
   shared prompt cache exists for a wrapped CLI), weekly proposals only (Paperclip), or
   approving everything. See SPEC-015 FR-13–FR-18, FR-20 and FR-22.
6. **Consolidation model and cost**: the bot's own provider, optionally a cheaper model of
   it, with per-run and daily token caps. Rejected: a fixed cheap model, or consolidation
   only on the owner's request. See SPEC-015 FR-19.

## Consequences

### Positive

- A bot remembers stated facts across session replacement, provider changes and restarts,
  and can find specifics from long ago.
- Core memory and consolidation work for providers without tools. Tool-capable providers get
  recall at once.
- Every remembered claim points to its evidence and can be corrected or removed by the
  owner.
- The SPEC-009 and SPEC-012 limits are enforced by the core's scope rules, not by prompt
  wording.

### Negative

- Consolidation spends model tokens every night a bot has new conversations.
- Core memory is paid on every turn, because session instructions are.
- Remembered text becomes prompt input, a new injection surface. Hence derived trust,
  validation and the security review.
- Two Runtime capabilities do not exist yet: turn-scoped context, and a tool-free deletable
  session.
- More owner-facing surface: memory settings and an approval queue.

### Neutral

- Desktop is unchanged. Its own memory work stays in Platform SPEC-022 / SPEC-031.

## Alternatives Considered

### Markdown memory files in the workspace (OpenClaw, Hermes, Paperclip)

- **Pros**: humans and every CLI can read and edit them; no tool needed.
- **Cons**: they reach every session in the workspace, including contact-note sessions.
  Auto-loaded names leak into SPEC-012 Phase 2 sessions. Provenance, scope and approval live
  outside the store.
- **Why rejected**: the scope rules should be enforced by the core, not left to file
  placement.

### Turn instructions for recall and deltas, without a Runtime change

- **Pros**: no Runtime work.
- **Cons**: Runtime persists them, so the next turn loses the persona, handoff and memory.
  Resending everything on every turn doubles the instructions, because the persisted layer
  is composed in as well.
- **Why rejected**: correctness and cost.

### Vector retrieval first

- **Pros**: finds paraphrases; OpenClaw weights vectors at 0.7.
- **Cons**: an embedding provider (privacy, keys, cost) or a 0.3 GB local model, for a corpus
  of a few megabytes per bot per year.
- **Why rejected**: bigram BM25 plus curated pages may be enough. An evaluation decides.

### Review every few turns (Hermes)

- **Pros**: fresher memory.
- **Cons**: Hermes stays cheap by forking its own cached prompt. A wrapped CLI offers no such
  fork, so each review is a full-price turn, and heartbeats multiply them.
- **Why rejected**: cost without a clear gain for a resident bot.

### Runtime-owned memory

- **Pros**: one implementation for Desktop and Bot.
- **Cons**: contradicts Runtime ADR-012; Runtime does not know scopes, owners or contact
  notes.
- **Why rejected**: boundary.

## References

- [Agent memory architecture survey](../research/2026-11-11-agent-memory-architecture-survey.md)
- [SPEC-015: Bot memory: layers, recall and consolidation](../specs/SPEC-015-bot-memory-layers-recall-and-consolidation.md)
- [PLAN-014: Bot state database and memory](../plans/PLAN-014-bot-state-database-and-memory.md)
- [SPEC-011](../specs/SPEC-011-heartbeat-modes-rhythm-and-backoff.md),
  [SPEC-012](../specs/SPEC-012-boss-cat-status-board-and-contact-notes.md),
  [SPEC-009](../specs/SPEC-009-boss-cat-role.md)
- Runtime [ADR-012](https://github.com/cats-inc/cats-runtime/blob/main/docs/decisions/012-separate-evidence-memory-and-retrieval-layers.md),
  [ADR-050](https://github.com/cats-inc/cats-runtime/blob/main/docs/decisions/050-separate-provider-session-persistence-from-product-history.md)
- Platform [SPEC-022](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-022-cats-memory-layering-and-ownership.md),
  [SPEC-031](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-031-built-in-memory-extraction-durable-sync-and-retrieval-context.md),
  [ADR-142](https://github.com/cats-inc/cats-platform/blob/main/docs/decisions/142-publish-reusable-platform-packages-for-independent-products.md)

---

*Decision made: 2026-11-11*
*Decision makers: owner (chose every proposed default); drafted by Claude*
