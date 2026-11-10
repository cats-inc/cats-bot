# Agent memory architecture survey — 2026-11-11

How three open-source agent systems store conversations and long-term memory, what Cats
Bot and its neighbours do today, and what that implies for a bot that should remember its
owner across sessions. It is the evidence for
[ADR-021](../decisions/021-keep-each-bots-state-in-a-sqlite-database.md) and
[ADR-022](../decisions/022-give-each-bot-layered-memory-it-consolidates-while-asleep.md).

## Sources and method

- **Official documentation**, read 2026-11-10:
  - OpenClaw: [memory](https://docs.openclaw.ai/concepts/memory),
    [dreaming](https://docs.openclaw.ai/concepts/dreaming),
    [compaction](https://docs.openclaw.ai/concepts/compaction),
    [session](https://docs.openclaw.ai/concepts/session),
    [memory search](https://docs.openclaw.ai/concepts/memory-search).
  - Hermes Agent: [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory),
    [sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions),
    [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills),
    [memory providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers).
    The last three were only partly read.
- **Source code**, read-only on 2026-11-11, nothing executed. The local checkouts add at
  most one commit that does not touch memory, so the upstream commits below are cited:
  - OpenClaw at `225d2f7d4f1`;
  - Hermes Agent at `acdc8f1ba6`;
  - Paperclip at `0c7a628fd`.
  - Paths below are relative to each repository root.
- **Cats repositories**: cats-bot `main` at `8d9a3db`, cats-runtime `main` at `fb50e59a`,
  cats-platform `main` at `d53b09db0`.
- **Experiments** ran in the installed Cats Bot 0.5.7 executable with
  `ELECTRON_RUN_AS_NODE=1`: Electron 41.2.0, Node 24.14.0, SQLite 3.51.2. No test touched a
  bot's data.
- **Confidence.** Unlabelled statements were read in code. Items marked *docs only*,
  *inferred* or *skimmed* were not confirmed in code.

## OpenClaw

- **Transcripts** live in one SQLite database per agent,
  `<state>/agents/<id>/agent/openclaw-agent.sqlite` (`src/state/openclaw-agent-db.paths.ts`):
  - `transcript_events` is keyed by (session_id, seq) and appended
    (`appendTranscriptEvent`). Payloads are JSON or zstd, at most 4 MiB.
  - `session_windows` records each transcript generation and why it started (reset,
    rollover, fork, recovery, compaction, …).
  - `session_transcript_fts` is FTS5 with `unicode61 remove_diacritics 2`
    (`src/state/openclaw-agent-schema.sql`).
- **JSONL migration.** Legacy JSONL is imported only by `openclaw doctor --fix`:
  - `verifyTranscriptEvents` proves that every JSONL event exists in SQLite. Only a missing
    tail may be appended, and an id conflict throws
    (`src/infra/session-sqlite-transcript-verification.ts`).
  - The originals move to `session-sqlite-import-archive/`. A backup is written first, and a
    failure leaves JSON and Markdown reports plus a restore path. The import itself was
    *skimmed*.
- **Retention**: stale sessions are pruned after 30 days and over-cap sessions are archived
  rather than deleted. There is a 10 GiB disk budget, and cold zstd storage is opt-in
  (`src/config/sessions/store-maintenance.ts`).
- **Curated memory** is Markdown in the workspace: `MEMORY.md`, `USER.md`, daily notes
  `memory/YYYY-MM-DD.md` and a `DREAMS.md` diary.
  - These files are re-read on every run. Budgets are 20,000 characters per file and
    60,000 in total, with `USER.md` at 4,000. Truncation keeps 75% head and 25% tail.
  - `MEMORY.md` is not injected into group or channel chats, subagents or cron
    (`workspace.ts`).
- **Search** uses the same database: FTS5 BM25 plus vectors in sqlite-vec, with brute-force
  cosine when the extension is missing.
  - Default weights are vector 0.7 and text 0.3, with MMR λ 0.7, a 30-day half-life for dated
    notes, `maxResults` 6 and `minScore` 0.35 (`src/agents/memory-search.ts`).
  - The default embedding provider is OpenAI; a local GGUF model is optional.
- **Chinese text is weak in keyword search.**
  - Under the default `unicode61`, an unspaced Chinese run is one token, so a word inside a
    sentence does not match.
  - Under `trigram`, any term shorter than three characters becomes a substring scan with
    BM25 score 0 (`keyword-query.ts`).
- **Memory flush.** A silent turn before compaction may append only to the daily note.
  - It is skipped for runtimes that own compaction, which includes wrapped CLIs
    (`agent-runner-memory.ts`).
- **Dreaming** is on by default and runs once a day (`0 3 * * *`):
  - **Light** reads the last 2 days and **REM** the last 7. Only **Deep** writes
    `MEMORY.md`.
  - **Promotion gates**: score ≥ 0.75, at least 3 recall signals, at least 3 distinct
    interactive `memory_search` queries, age ≤ 30 days, at most 10 promotions per run
    (`short-term-promotion.ts`).
  - **Consolidation** is a tool-free model call that returns actions only. The host writes
    the text with a `Source: path#Lx-Ly` reference.
  - **Safety rails**: losing more than 25% of entries, going over 10,000 characters, or any
    failure falls back to append-only. `untrusted` and `system` origins are blocked. The
    last 8 versions are kept; no restore command was found.
  - **Cost**: budget and token settings are parsed but not enforced
    (`dreaming-consolidation.ts`).
- **Wiki** is a separate plugin, `extensions/memory-wiki`.
  - The vault holds entities, concepts, syntheses and sources. Claims carry evidence,
    confidence and status.
  - Agents write through `wiki_apply`. A deterministic compile builds indexes, backlinks and
    reports on contradictions and stale pages; the plugin makes no model calls.
- **Active recall** is a separate plugin, `extensions/active-memory`. It searches before a
  reply and, in `escalate` mode, starts a recall subagent only when the message asks about
  the past.
- **Wrapped CLIs.** When a native session cannot be resumed, OpenClaw starts a fresh one
  with history pasted in:
  - The budget is max(12 KiB, min(256 KiB, window × 0.32 characters)), with the summary
    first and the text marked possibly stale (`session-history.ts`).

## Hermes Agent

- **Transcripts** are in `state.db` (SQLite, WAL, schema version 33).
  - **Indexes**: `messages_fts` uses unicode61, and `messages_fts_trigram` excludes tool rows.
  - **Short Chinese queries**: when a Chinese term is shorter than three characters, search
    falls back to a LIKE scan, newest first. No word segmentation was found
    (`hermes_state_search.py`).
  - **JSONL** is not read. It is written only when the database was replaced under a live
    process. No migrator was found in the current tree.
- **Writes and retention.**
  - Writes use `BEGIN IMMEDIATE` with jittered retries, a passive checkpoint every 50
    writes, and an FTS merge every 1,000.
  - Auto-prune is off by default (90 days when on).
- **Prompt memory** is `MEMORY.md` (2,200 characters) and `USER.md` (1,375 characters).
  - Both are injected as a snapshot frozen at session start and re-read only at
    compaction.
  - Writes take a lock, re-read the file and replace it atomically. Entries that match
    threat patterns appear as `[BLOCKED: …]` in the snapshot (`tools/memory_tool_store.py`).
- **Background review** runs every 10 user turns for memory and every 10 tool-calling
  iterations for skills (`agent/turn_context.py`, `agent/turn_iteration_prep.py`).
  - It reuses the main model and its cached prompt.
  - An unattended review may only add; patches and removals are staged for approval
    (`tools/memory_tool.py`).
- **No pre-compression memory flush.** It was removed. Compression keeps old rows searchable
  (`active=0, compacted=1`) and inserts summary rows.
- **Skills** are procedural memory: `SKILL.md` with progressive disclosure. An idle curator
  runs every 7 days, after at least 2 hours idle, and archives stale skills.
- **Group chats.** No exclusion from memory was found. `MEMORY.md` reaches every chat of the
  profile.
- **Wrapped Codex.** When `thread/resume` fails, Hermes:
  - clears the id and tells the user;
  - seeds a fresh thread with its own transcript, up to 32,000 characters
    (`agent/codex_runtime.py`, `agent/codex_runtime_history_seed.py`).

## Paperclip

- **What it is.** Paperclip runs agent CLIs (claude, codex, grok, …) as "employees" in short
  heartbeats, on PostgreSQL through Drizzle.
- **Continuity** is stored per (company, agent, adapter, task) in `agent_task_sessions`.
- **Unknown or expired native ids** are detected per adapter by regex
  (`packages/adapters/*/src/server/`). The adapter then:
  - reruns once with a fresh session and clears the saved id;
  - injects `paperclip.native-session-handoff.v1`: at most 24,000 bytes, secrets redacted,
    fenced as untrusted evidence, with a pointer to fetch more through tools
    (`server/src/services/native-runtime/native-session-handoff.ts`).
- **Proactive rotation** after 200 runs, 2M input tokens or 72 h applies to adapters whose
  native context management is unknown: cursor, gemini, grok, kimi, opencode and pi. It is
  disabled for claude, codex and hermes, which manage their own context
  (`packages/adapter-utils/src/session-compaction.ts`).
- **Continuation summary** is filled from a template without a model, at most 8,000
  characters, after every run.
  - Receipts of completed actions keep a resumed agent from repeating side effects
    (`server/src/services/execution-continuation.ts`).
- **No memory service in core.**
  - Agents keep Markdown in a per-agent home that is synced back after each run.
  - A bundled skill describes PARA-style memory files.
  - Search is `pg_trgm`, ILIKE and Levenshtein. There are no vectors in the schema.
- **Wiki** is a plugin (`packages/plugins/plugin-llm-wiki`).
  - A wiki-maintainer agent uses ingest, query, lint and distill skills.
  - Routines (paused by default and billed) distill sources after a cursor every 6 h and
    lint nightly.
- **Reflection.** A weekly reflection coach and a daily summarizer are paused by default.
  The coach only proposes; edits need an accepted confirmation.

## Patterns across the three

- **Storage.** Queryable history lives in a database with a full-text index. JSONL survives
  only as raw logs (Paperclip run logs) or a fallback (Hermes).
- **Prompt memory.** A small curated memory is always in the prompt; everything else is
  retrieved by tools on demand.
- **Who consolidates.**
  - OpenClaw consolidates nightly.
  - Hermes reviews every N turns.
  - Paperclip leaves it to agents and opt-in routines.
  - The two that wrap CLIs do not flush the CLI's context; they work from their own
    history.
- **Guardrails** on automatic writes: provenance, a loss guard, staged edits, versions.
- **Chinese keyword search** is weak in all three. None indexes 2-character Chinese words;
  Hermes and OpenClaw fall back to substring scans.
- **A lost native session** gets a fresh session plus the system's own history.

## Cats Bot today

- **Storage** (SPEC-001 FR-2):
  - Bubbles are in `transcripts/<conversation>.jsonl`, and each reply's block structure is
    in `presentations/<conversation>.json`.
  - Work items and schedules are in `journal.jsonl`, and attachments in
    `conversations/<id>.json`.
  - Runtime and the provider CLI each keep their own copy of the same exchanges.
- **Access patterns**:
  - `ConversationStore.transcript(id)` reads and parses the whole JSONL on every call,
    several times per turn. The note receives the newest 4 MB.
  - `savePresentation` rereads and rewrites the whole presentation file and its `.bak` up to
    every 100 ms while a reply streams. The file holds every reply the conversation ever
    had.
  - `journal.jsonl` re-appends the whole work item on every transition, is replayed at every
    start, and is never compacted.
- **Measurements** from one development bot that was idle apart from heartbeats:
  - 346,910 bytes of journal after about 8.5 days (2026-11-02 to 2026-11-10 23:07 local);
  - another 23,331 bytes in the next 5 h 16 min;
  - transcript and presentation files of about 24 KB each.
- **What a new session receives** is the handoff pack (`HANDOFF_PACK_LIMIT = 12_000`).
  - Its older part is clipped lines of 160 characters each, not a summary.
  - Errors and rebuild notices have been left out since #139.
  - The assist-heartbeat review (`review.ts`) still renders error lines.
- **Session continuity.**
  - Until 2026-11-10 every core restart created a new session; the log above shows eight
    in one week.
  - PLAN-013 (#149) now resumes saved sessions across restarts.
  - Runtime's typed `provider_session_unavailable` (Runtime #214) is in the pinned
    candidate `fb50e59a`.
- **Tool reach.**
  - Runtime accepts session MCP servers only for its claude, codex, copilot, hosted ACP and
    muse MSP adapters.
  - Bot offers its tools to grok and muse only under a hosted provider policy (full machine
    and network access), and never to antigravity (`src/shared/providerTools.ts`).
  - A legacy grok bot therefore has no Bot tools. In one such bot, the model correctly said
    no external tool was connected.
- **Instruction delivery.**
  - Runtime composes skills, the session instructions and the turn's instructions into
    every turn's message. This holds for the claude, codex, hosted ACP and per-turn adapters
    (`compileRuntimeTurnPrompt`, `mergeRuntimeInstructionLayers`, `WorkerProcess.ts`).
    Session instructions, including a handoff pack, are therefore paid on every turn by
    every provider.
  - A send's `instructions` also becomes the session's persisted instructions for later
    turns (`src/http/routes/messages.ts`, `docs/api.md`). Turn instructions therefore cannot
    carry one-turn context, which is why Bot already keeps its tool guidance out of them
    (`src/core/desktopControl/tools.ts`).
- **Telegram** accepts only the owner's private chat; group messages are ignored.
- **Privacy rules.** SPEC-009 FR-6 and SPEC-012 forbid any bot reading another bot's
  transcripts or memory.
  - Contact-note sessions never carry owner-written entries.
  - SPEC-012 Phase 2 waits for a Runtime session with no tools, no MCP, no handoff and no
    provider-native project memory (FR-13).

## Cats Desktop and Runtime today

- **Runtime ADR-012**: Runtime owns execution evidence; durable memory is product-owned;
  retrieval corpora are downstream projections.
- **Runtime ADR-050**: an optional ephemeral provider-session policy, verified for Codex
  only. Product owners alone decide replacement and supply the handoff.
- **Platform plans.** SPEC-022 (layers) and SPEC-031 (extraction and retrieval) are drafts.
  Platform ADR-118 and SPEC-031 put lexical retrieval first and do not require a vector
  database.
- **Platform's implemented slice**, from a code read, partly traced rather than observed:
  - durable memory comes only from the owner's curation;
  - retrieval is lexical token overlap, top 8, injected every turn;
  - there is no model-based extraction, no consolidation schedule and no full-text or
    vector index.
- **Platform transcripts** are in one `chat-state.local.json` snapshot that is rewritten
  whole, with a `.bak`, on every change. Commit history records a 6 MB profile costing about
  5 s of CPU per rewrite.

## Experiments

- **`node:sqlite`** is available in the shipped Electron without a native dependency. It
  prints an ExperimentalWarning.
- **FTS5 with `tokenize='trigram'`** found a 3-character Chinese query but returned nothing
  for 2-character queries. `LIKE` found them.
- **A bigram shadow column worked on a three-row probe.** CJK runs were stored as
  overlapping 2-character tokens and indexed with unicode61.
  - 2- and 3-character Chinese queries and an English word all matched, with BM25 ranking.
  - This needs an evaluation set before it is called better.
- **A file-backed database in WAL mode on Windows behaved as expected.**
  - A read-only connection saw nothing during an open write transaction and all 20,000 rows
    after commit.
  - The newest 50 rows came back in 0.33 ms. The file was about 2.1 MB.
  - The WAL and SHM files were checkpointed away on close.
  - Not tested: macOS, Linux, antivirus interference, or crash during checkpoint.

## Implications

- **Keep JSONL as a format, not as the store.** A database with append-only evidence rows,
  upserted presentation rows and current-state work items removes whole-file rewrites and
  replay ([ADR-021](../decisions/021-keep-each-bots-state-in-a-sqlite-database.md)).
- **Memory must reach providers without tools.**
  - Core memory can go into the session instructions at session creation today. It is then
    paid on every turn, so its budget must stay small.
  - Context that should last one turn (recall results, a memory delta, a one-time handoff)
    needs a Runtime turn-scoped field that is not persisted. Until then, recall reaches only
    providers with MCP tools.
  - Workspace Markdown is risky: CLIs auto-load some file names, and the workspace is shared
    with contact-note sessions.
- **Consolidate from Bot's own evidence, not from a CLI's context.** It needs a tool-free
  Runtime session, the same prerequisite as SPEC-012 Phase 2.
- **Promotion rules from the peers are either too conservative or unguarded.**
  - OpenClaw's recall-count gate is too conservative for a fact the owner states once.
  - Hermes lets everything into every chat.
  - Bot needs scope and trust on every record.
- **Search Chinese with bigrams** and add vectors only if an evaluation shows misses.

## Not verified

- No end-to-end consolidation was run in any of the three systems. Behaviour is from code
  and docs.
- Paperclip's native runner was read from docs only. OpenClaw's recall-state database
  location is inferred.
- The bigram probe used three short sentences. The SQLite tests ran on Windows only.
