# ADR-022: Give Each Bot Layered Memory It Consolidates While Asleep

> The conversation evidence is the bot's own record. Above it sit a summary per
> conversation, a small core memory, memory pages and a recall index. A tool-free
> session builds them overnight from the evidence.

## Status

Proposed, 2026-11-11. Waiting for the owner's decisions (see Open Decisions). Nothing is
implemented.

It depends on [ADR-021](021-keep-each-bots-state-in-a-sqlite-database.md). An independent
security review is required before any consolidation or memory injection is implemented,
as it was for SPEC-009 and SPEC-012.

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
  - None handles 2-character Chinese queries in keyword search.
- **Cats boundaries.**
  - Runtime ADR-012: durable memory is product-owned.
  - Platform SPEC-022 / SPEC-031 (drafts) describe the same layers for Desktop.
  - SPEC-009 FR-6 and SPEC-012: no bot reads another bot's transcripts or memory, and
    contact-note sessions never carry owner-written entries.
- **Reach.**
  - Bot's MCP tools reach only providers whose Runtime adapter accepts session MCP servers
    (claude, codex, copilot, hosted ACP, muse MSP). Legacy grok gets no Bot tools.
  - Turn `instructions` reach every provider.
- **Tool-free sessions.** A session with no tools, no handoff and no provider-native project
  memory is not yet offered by Runtime. It is the same prerequisite as SPEC-012 FR-13.
  Runtime ADR-050's ephemeral sessions are verified for Codex only.

## Decision

The following is proposed; the defaults under Open Decisions are part of the proposal.

1. **Layers**, aligned with Platform SPEC-022:
   - **Provider-native session**: a continuity aid only.
   - **Evidence**: ADR-021's transcript entries, complete and append-only. No memory
     process edits them.
   - **Working summary**: one per conversation, maintained by consolidation. It replaces the
     clipped digest in handoff packs.
   - **Durable memory**:
     - *core memory*: small and budgeted, injected into the bot's own conversations;
     - *memory pages*: topic and entity pages made of claims, each linked to the evidence
       entries it came from, read on demand.
   - **Recall index**: ADR-021's full-text index over evidence and memory pages.
2. **Canonical form.** Memory is records in `bot.db`, each carrying scope, trust,
   provenance and versions. Any Markdown is a rendering, never the source. Bot writes no
   memory into the workspace, because CLIs auto-load some file names there and the
   workspace is shared by every session of the bot.
3. **Reading works for every provider.**
   - **Core memory** goes into the session instructions as a snapshot taken at session
     creation. A later change reaches a live session as a short delta in the next turn's
     instructions.
   - **Recall** is done by the core before the turn, when the message asks about the past.
     Results are bounded, fenced as data and marked possibly outdated.
   - **Tools.** Providers that accept session MCP additionally get `memory_search` and
     `memory_get`.
4. **Writing.**
   - Consolidation extracts memory from evidence; this works for every provider.
   - Providers with MCP may propose immediate `remember`/`forget` calls, which the core
     validates like consolidation output.
   - The owner edits memory in settings.
5. **Scope and trust on every record.**
   - **Trust levels**: owner-stated, bot-inferred, or untrusted. Untrusted covers tool
     output, web and file content, and other bots' messages.
   - Untrusted content is never promoted.
   - Contact-note content is never promoted, and memory is never injected into contact-note
     sessions or into answers for another bot.
6. **Consolidation ("dreaming").**
   - **When**: once per local day, after the direct message falls asleep in rest hours
     (SPEC-011), and only when new evidence exists past the bot's watermark.
   - **Session**: an owner-invisible, low-priority, cancellable work item in a Runtime
     session that is tool-free, handoff-free and memory-free, and ephemeral where supported.
     It is not enabled until Runtime offers such a session for the bot's provider; there is
     no fallback to a tool-capable session.
   - **Output**: structured proposals (add, merge, supersede, retire) with evidence ids. The
     core validates scope, trust, evidence, budget and a loss guard.
   - **Applying**: additions apply automatically; edits and removals wait for the owner.
     Every change is versioned and restorable.
   - **Cost**: a per-run and a daily token cap, recorded as usage. Runtime guardrails stop
     it.
7. **Search.**
   - BM25 over the bigram-indexed store, with a recency tie-break. Single CJK characters use
     LIKE.
   - No embeddings until a Chinese/English evaluation set shows misses; then local
     embeddings first.
8. **Placement.** `src/core/store` and `src/core/memory` import nothing from the shell,
   renderer or Electron. Their data shapes follow Platform SPEC-022 / SPEC-031, so they can
   become a package under Platform ADR-142. Desktop adoption is Platform's decision.

## Open Decisions

Each item has a proposed default. Answering "as proposed" accepts the default.

1. **Engine placement**: Bot-local, package-ready modules (proposed). The alternatives are
   a shared package from the start, or a Runtime service, which conflicts with Runtime
   ADR-012. A change affects SPEC-015 FR-1 and PLAN-014 P2–P5.
2. **Canonical form and reach**: database records; instructions plus core-side recall for
   every provider; MCP tools where accepted (proposed). The alternative is Markdown files
   as the source, as all three peers do. That conflicts with SPEC-012 and auto-loaded
   names. A change affects SPEC-015 FR-1–FR-12.
3. **Injection and budget**: about 4,000 characters of core memory; a snapshot at session
   creation plus a delta on change (proposed). The alternatives are re-reading every turn
   (OpenClaw), or snapshot-only until the next session (Hermes). A change affects SPEC-015
   FR-5–FR-7.
4. **Promotion**: owner-stated facts at the next consolidation; inferred patterns only after
   two distinct days; untrusted never (proposed). OpenClaw's gate of 3 recalls, 3 distinct
   queries and at most 10 promotions a night is the alternative. A change affects SPEC-015
   FR-15–FR-16.
5. **Consolidation schedule and approval**: nightly after the direct message sleeps;
   additions automatic; edits and removals approved (proposed). The alternatives are every
   N turns (Hermes; no shared prompt cache exists for a wrapped CLI), weekly proposals only
   (Paperclip), or approving everything. A change affects SPEC-015 FR-13–FR-20.
6. **Consolidation model and cost**: the bot's own execution target, with an optional
   cheaper target, and per-run and daily token caps (proposed). The alternatives are always
   a fixed cheap model, or consolidation only on the owner's request. A change affects
   SPEC-015 FR-19.

ADR-021 is decided on its own, and P1 of PLAN-014 depends only on it.

## Consequences

### Positive

- A bot remembers stated facts across session replacement, provider changes and restarts,
  and can find specifics from long ago.
- Memory works for providers without tools. Tool-capable providers get more.
- Every remembered claim points to its evidence and can be corrected or removed by the
  owner.
- The SPEC-009 and SPEC-012 privacy rules are enforced by scope, not by prompt wording.

### Negative

- Consolidation spends model tokens every night a bot has new conversations.
- Remembered text becomes prompt input, a new injection surface. Hence trust levels,
  validation and the security review.
- Consolidation waits on a Runtime capability that does not exist yet.
- More owner-facing surface: memory settings and an approval queue.

### Neutral

- Desktop is unchanged. Its own memory work stays in Platform SPEC-022 / SPEC-031.

## Alternatives Considered

### Markdown memory files in the workspace (OpenClaw, Hermes, Paperclip)

- **Pros**: humans and every CLI can read and edit them; no tool needed.
- **Cons**: they reach every session in the workspace, including contact-note sessions.
  Auto-loaded names leak into SPEC-012 Phase 2 sessions. Provenance, scope and approval
  live outside the store.
- **Why rejected**: the privacy rules must hold by construction.

### Vector retrieval first

- **Pros**: finds paraphrases; OpenClaw weights vectors at 0.7.
- **Cons**: an embedding provider (privacy, keys, cost) or a 0.3 GB local model, for a
  corpus of a few megabytes per bot per year.
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

*Proposed: 2026-11-11*
*Decision makers: owner (pending)*
