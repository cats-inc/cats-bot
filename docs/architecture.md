# System Architecture

> How a cats-bot is put together. Decisions live in `docs/decisions/`, the
> behavioural contract in `docs/specs/SPEC-001-resident-bot-core-and-global-execution.md`.

## Overview

Desktop parity is specified by
[ADR-006](decisions/006-share-runtime-catalogs-and-package-provider-setup-helpers.md):
Runtime's public catalog projection/advanced HTTP catalog supplies model controls;
provider-specific setup helpers are vendored with exact provenance. Shell-owned
language preferences and native tray dialogs do not change core ownership. Product
surfaces use Conversation and Direct message; older internal names remain compatible.

One bot is one resident process tree: a Node **bot core** that owns the bot's
profile, conversations, work journal and every timer; a private
**cats-runtime** child it starts and supervises over loopback HTTP; and the
provider CLI the runtime runs. Presentation (the `cats-bot` CLI today, an
Electron tray and sticky notes later) is a disposable client of the core
through `BotHostApi`.

Provider-native questions and approvals use Runtime SPEC-039. The core keeps the
active work item and global turn gate while waiting; authenticated responses use a
separate control path. CLI responses arrive on stdin and travel through a random,
authenticated local pipe/socket, never the file handoff queue. Live prompts stay
in memory; the bounded provider-interaction receipt store contains identity,
deadline and terminal state only. Restart invalidates pending receipts.

Profile schema 2 adds an explicitly selected provider policy, separate from legacy
tool permission mode. Schema 1 projects to `providerPolicy: null` without changing
permissions. Only the instance-lock owner upgrades: validate, preserve original
bytes in `profile.json.v1.bak`, then atomically replace. Invalid/unknown schemas or
a conflicting backup stop the upgrade and preserve data. Restore the v1 backup
only while the Bot is stopped when returning to an older binary. This persisted
boundary requires the next Bot minor (0.2) before publication; the current task
does not publish or bump a release.

The private candidate Runtime package is pinned by source commit and lockfile
integrity; see [candidate provenance](../vendor/README.md). Inspection uses the
current session's worker without starting a model turn. Top-level MCP discovery
does not establish browser/desktop helper availability or successful invocation.

## Architecture Diagram

```text
┌───────────────────────────────┐   BotHostApi commands + events
│ host: cats-bot CLI / Electron │◀────────────────────────────────┐
│ tray + sticky notes (shell)   │                                 │
└───────────────┬───────────────┘                                 │
                │ in-process (CLI) / contextBridge IPC (shell)    │
┌───────────────▼───────────────────────────────────────────────┐ │
│ bot core  src/core                                            │ │
│  profile  conversations+transcripts  queue+journal  timers    │─┘
│  life loop (tick, schedules, heartbeat)   tool server (MCP)   │
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
  (FR-4), apply patches and bump `configRevision` only on a real change to
  what a session is created with: target, instructions or permissions (FR-27).

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

### `src/core/life`

- **Purpose**: what keeps the bot alive without a window (FR-20 to FR-25, FR-28).
- **Responsibilities**: `loop.ts` is the reconcile tick (every 60 s, 5 s after
  start, never overlapping because a tick requested while one runs joins that
  pass, never calling the model): restart the runtime with
  backoff, settle and fire schedules, keep the home session attached by the
  runtime's own session status (`initializing`/`ready`/`busy` are live and left
  alone; `closing`/`closed` resume; 404 rebuilds; unreachable means no action),
  put idle notes to sleep, expire unanswered approvals, and decide when a
  heartbeat turn is due. `schedules.ts` and `cron.ts` hold durable one-time and
  cron schedules evaluated in an IANA zone with skip/coalesce/run_once missed
  policies; `heartbeat.ts` the prompt, delays and `[quiet]` rule; `recovery.ts`
  the evidence check that settles interrupted turns by the runtime transcript:
  only messages after the run's journaled history baseline count, and a reply
  completes the turn only when every tool call the core saw has its result
  before it; anything less waits for the owner.

### `src/core/tools`

- **Purpose**: the bot's own tools for its model (FR-24, FR-30).
- **Responsibilities**: a minimal MCP Streamable HTTP server on loopback with a
  per-bot bearer token; the conversation that owns a session is in the URL path
  of its descriptor. Tools: `schedule_create`, `schedule_list`, `schedule_cancel`,
  `ask_owner`. A schedule exists only once journaled and the receipt is written
  into the conversation; a question becomes an `awaiting_owner` work item.
  Listing and cancelling see only the calling conversation's schedules.

### `src/core/desktopControl`

- **Purpose**: owner-consented desktop control on Windows (ADR-005, SPEC-006 phases A and B).
- **Responsibilities**: `helper.ts` supervises the native helper
  (`native/windows-desktop-control/`): lazy start, `hello` with the Bot's own process and
  executables plus Cats Desktop's install paths, idle exit, crash limit, and where the helper
  lives (packaged resource, or the checkout's Release build). `policy.ts` is the DC-04 gate
  on Runtime's capability snapshot. `tools.ts` holds SPEC-133's phase A and phase B tool
  names, schemas, key allowlist and error codes. `switches.ts` stores the per-conversation switch in
  `desktop-control.json`. `service.ts` serves `cats-desktop` with the `src/core/tools`
  server class: before every send it decides whether the conversation's session carries
  the descriptor, a tool call is served only while the running work item is an owner
  message from a local surface, and app grants are answered only through `BotHostApi`
  (`desktopControlState`, `setConversationDesktopControl`, `respondDesktopGrant`,
  `stopDesktopControl`). Grants stay in memory; while one waits, background work does not
  start (BDC-09). The first input tool of an owner turn holds control until the core reports
  that the work item ended (`turnEnded`); Stop releases it and cancels the helper op only for
  a conversation that held control (BDC-10). The note, Settings and the tray reach these through `ipc.ts`, where a note
  acts only on its own conversation; `cats-bot desktop` reaches them through the host control
  endpoint (`src/core/host-api/control.ts`).

### `src/shell/electron` and `assets/`

- **Purpose**: the first presentation host (ADR-001 §2, §8; FR-32 to FR-34).
- **Responsibilities**: `main.ts` mounts `BotCore` in the Electron main
  process (every timer stays there), takes one single-instance lock per bot
  id, and routes `bot:invoke` IPC calls to `ipc.ts`, which maps command
  names to `BotHostApi`; events are broadcast to every note. `windows.ts`
  owns the frameless sticky-note windows (close hides, bounds and
  always-on-top persist in `shell-state.json`); `tray.ts` and `trayMenu.ts`
  the tray and its menu. `assets/preload.cjs` is the sandboxed contextBridge.
  The pages (notes, settings and first run, the floating cat) live in
  `src/renderer/` and are built by Vite into `dist/renderer/` (ADR-003); they
  keep no durable state, type `window.catsBot` in `src/renderer/bridge.ts` and
  take only types from the core. The renderer never sees the runtime's URL
  or key.

### `src/core/transports/telegram.ts` and `src/core/secrets.ts`

- **Purpose**: the optional Telegram binding (FR-19, FR-26) and where its
  token lives.
- **Responsibilities**: one long-polling `getUpdates` consumer per bot with
  exponential backoff and 409-conflict handling; an update is acknowledged
  only after it was accepted (a failed one is polled again, one that fails
  five times is skipped by id), and the last accepted `update_id` is kept in
  `telegram-state.json` so a restart neither replays nor loses one; the first private chat that
  writes becomes the owner and is persisted in the profile; inbound text
  becomes an owner message in the home conversation; every completed home
  reply is mirrored back in order, split at 4,000 characters. The token is
  kept in `secrets.json` by `FileSecretStore`, encrypted through Electron's
  `safeStorage` when the shell runs, as a file otherwise; the shell re-stores
  a file-protected token encrypted when it starts and when the CLI hands over
  a new one, and status reports the stored protection. Loop shape adapted
  from cats-platform's Telegram polling with attribution.

### Later (PLAN-001 Phase 5, separate ADR)

- Desktop presence: wallpaper or desktop layer, character, native hosts.

## Data Flow

1. A host calls `sendOwnerMessage(conversation, text)`; the core appends the
   owner entry to the transcript, journals a `queued` work item and pumps the
   queue.
2. The turn runner admits the item (`running`, `configRevision` recorded),
   binds the conversation to a runtime session (creating one with persona plus
   handoff pack, resuming a sleeping one, or rebuilding a closed or stale one)
   and streams `POST /sessions/{id}/messages` as NDJSON. Binding is one pass
   per conversation at a time: the tick and a turn that bind together share
   one result, and a replaced session is closed once no turn runs in it.
3. Text, tool and error events become transcript entries and `turn.delta`
   host events; `result` completes the item, which is journaled with its
   result and notification state, and `turn.completed` is emitted.
4. Hosts rebuild everything they show from the conversation records,
   transcripts and journal; no event stream has to be replayed (FR-29).

## Technology Stack

| Layer         | Technology                                          | Purpose                          |
| ------------- | --------------------------------------------------- | -------------------------------- |
| Core          | Node.js 24, TypeScript 5 (ESM, erasable syntax)     | headless bot core and CLI        |
| Execution     | `@cats-inc/cats-runtime` (exact pin), provider CLIs | sessions, resume, streaming      |
| Tests         | `node:test`, a fake runtime, a scripted fixture CLI | unit, core and integration tests |
| Shell (later) | Electron                                            | tray and sticky notes            |

## Design Patterns

- **Resident core, disposable presentation** (ADR-001 §2): all timers and
  state in the core; hosts are clients.
- **Journal as truth** (ADR-001 §6): append-only records, last record per id
  wins, `interrupted` and `awaiting_owner` are first-class states.
- **Lazy attachment**: a session exists only once a turn needs it; stale
  attachments (created under an older `configRevision`) are never resumed.
- **Copied patterns, not imported packages**: the session gate and the life
  loop shapes come from cats-platform with attribution; nothing imports it.

## API Design

- The host contract is `BotHostApi` and `BotHostEvent` in `src/core/types.ts`.
- The runtime contract is the pinned cats-runtime's `docs/api.md`.

## Key Decisions

- See [decisions/](./decisions/) for Architecture Decision Records.

---

_Last updated: 2026-10-29_
