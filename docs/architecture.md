# System Architecture

> How a cats-bot is put together. Decisions live in `docs/decisions/`, the
> behavioural contract in `docs/specs/SPEC-001-resident-bot-core-and-global-execution.md`.

## Overview

One bot is one resident process tree: a Node **bot core** that owns the bot's
profile, conversations, work journal and every timer; a private
**cats-runtime** child it starts and supervises over loopback HTTP; and the
provider CLI the runtime runs. Presentation (the `cats-bot` CLI today, an
Electron tray and sticky notes later) is a disposable client of the core
through `BotHostApi`.

## Architecture Diagram

```text
┌───────────────────────────────┐   BotHostApi commands + events
│ host: cats-bot CLI / shell    │◀────────────────────────────────┐
└───────────────┬───────────────┘                                 │
                │ in-process (CLI) / IPC (shell, PLAN-001 Phase 3)│
┌───────────────▼───────────────────────────────────────────────┐ │
│ bot core  src/core                                            │ │
│  profile  conversations+transcripts  queue+journal  timers    │─┘
│  runtime supervisor ──── runtime client (HTTP, bearer key)    │
└───────────────┬───────────────────────────────────────────────┘
                │ spawn: cats-runtime --startup-mode app-managed --port <reserved>
┌───────────────▼───────────────┐   env: CATS_RUNTIME_DIR=<root>/runtime
│ cats-runtime (pinned package) │        CATS_RUNTIME_API_KEY=<random>
│  sessions, resume, streaming  │        discovery flags off (ADR-001 §1)
└───────────────┬───────────────┘
                │ stdin/stdout stream-json
┌───────────────▼───────────────┐
│ provider CLI (claude, codex…) │
└───────────────────────────────┘
```

## Components

### `src/core/profile`

- **Purpose**: the `BotProfile` (SPEC-001 FR-1): identity, persona
  instructions, the single global `executionTarget`, permissions, heartbeat
  policy, `configRevision`.
- **Responsibilities**: create with defaults, normalise field by field on read
  (FR-4), apply patches and bump `configRevision` only on a real target change
  (FR-27).

### `src/core/store`

- **Purpose**: the data root (`~/.cats/bots/<id>/` or `CATS_BOTS_HOME`).
- **Responsibilities**: atomic writes (temp file plus rename), JSON-lines
  append and rebuild for `journal.jsonl` and transcripts, the single-instance
  lock and the handoff directory a second instance writes into (FR-2, FR-3).

### `src/core/runtime`

- **Purpose**: the only contact with cats-runtime (ADR-001 §1).
- **Responsibilities**: `supervisor.ts` writes the minimal `providers.yaml`
  for the bot's provider into the private `CATS_RUNTIME_DIR`, reserves a free
  loopback port, spawns the pinned package's bin as an app-managed child,
  waits for `runtime.ready` and a ready `GET /health`, and stops it by closing
  stdin before any signal (FR-5, FR-7). `client.ts` wraps sessions, messages
  (NDJSON streaming), resume, cancel, close, delete, observe and history, and
  classifies HTTP errors.

### `src/core/conversations`

- **Purpose**: conversations, their transcripts and session attachments
  (FR-9 to FR-14).
- **Responsibilities**: the home conversation that always exists, note
  conversations, attachment state transitions, and the handoff pack a new or
  replacement session receives (12,000 characters; verbatim when short, lossy
  digest plus recent part when long).

### `src/core/queue`

- **Purpose**: every turn is a work item (FR-15 to FR-19).
- **Responsibilities**: the bot-wide serialized queue with owner messages
  first, the per-session gate, and the turn runner that binds a session
  (create, resume or rebuild), streams the turn into the transcript and host
  events, and turns every runtime answer into a state: 409 waits, 404/400
  closed resumes, 410 rebuilds, 403/429 fails with the guardrail reason, a
  stream without `result` is `interrupted`.

### `src/core/bot.ts`

- **Purpose**: the `BotCore` facade implementing `BotHostApi`.
- **Responsibilities**: start (lock, home conversation, journal replay with
  `running` turned into `interrupted`, runtime start with backoff restarts),
  owner messages, cancel, mark seen, profile updates with stale attachments,
  conversation deletion that closes and deletes the runtime session, the
  event bus, and stop without orphan processes.

### `src/cli/main.ts`

- **Purpose**: the headless host `cats-bot` (`init`, `run`, `say`, `status`,
  `conversations`).
- **Responsibilities**: `run` keeps the core in the foreground and prints its
  events; `say` hands a message to the running instance through the handoff
  directory, or runs one turn itself when no instance holds the lock.

### Planned (PLAN-001 Phases 2 to 4)

- `src/core/life`: reconciliation tick, schedules, heartbeat, recovery.
- `src/core/tools`: the bot's session MCP server (Streamable HTTP on loopback).
- `src/shell/electron`: tray, sticky-note windows, IPC bridge for `BotHostApi`.
- Telegram long polling.

## Data Flow

1. A host calls `sendOwnerMessage(conversation, text)`; the core appends the
   owner entry to the transcript, journals a `queued` work item and pumps the
   queue.
2. The turn runner admits the item (`running`, `configRevision` recorded),
   binds the conversation to a runtime session (creating one with persona plus
   handoff pack, resuming a sleeping one, or rebuilding a closed or stale one)
   and streams `POST /sessions/{id}/messages` as NDJSON.
3. Text, tool and error events become transcript entries and `turn.delta`
   host events; `result` completes the item, which is journaled with its
   result and notification state, and `turn.completed` is emitted.
4. Hosts rebuild everything they show from the conversation records,
   transcripts and journal; no event stream has to be replayed (FR-29).

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Core | Node.js 24, TypeScript 5 (ESM, erasable syntax) | headless bot core and CLI |
| Execution | `@cats-inc/cats-runtime` (exact pin), provider CLIs | sessions, resume, streaming |
| Tests | `node:test`, a fake runtime, a scripted fixture CLI | unit, core and integration tests |
| Shell (later) | Electron | tray and sticky notes |

## Design Patterns

- **Resident core, disposable presentation** (ADR-001 §2): all timers and
  state in the core; hosts are clients.
- **Journal as truth** (ADR-001 §6): append-only records, last record per id
  wins, `interrupted` and `awaiting_owner` are first-class states.
- **Lazy attachment**: a session exists only once a turn needs it; stale
  attachments are never resumed after a target change.
- **Copied patterns, not imported packages**: the session gate and the life
  loop shapes come from cats-platform with attribution; nothing imports it.

## API Design

- The host contract is `BotHostApi` and `BotHostEvent` in `src/core/types.ts`.
- The runtime contract is the pinned cats-runtime's `docs/api.md`.

## Key Decisions

- See [decisions/](./decisions/) for Architecture Decision Records.

---

*Last updated: 2026-10-27*
