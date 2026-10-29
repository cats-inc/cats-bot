# ADR-001: Build a Resident Bot Core on cats-runtime with Disposable Presentation

## Status

Accepted — 2026-10-27. Written by Claude, fusing two independent research documents; the same day the owner
told the team to start implementing per PLAN-001, which counts as approval.
Approval only means the direction and the phasing are accepted; implementation progress is in PLAN-001.
Revised the same day after Codex's review: the discovery isolation in §1 now targets each of the runtime's
channels (the session directories are not changed), and the reconciliation in §5 now classifies by the
runtime's session status, with `initializing` and `busy` protected.
For the spec see [SPEC-001](../specs/SPEC-001-resident-bot-core-and-global-execution.md),
for the implementation see [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md).
On 2026-10-30 PLAN-008 Phase 1 implemented [ADR-007](007-give-cats-bot-its-own-identity-and-data-root.md),
which replaces the §6 data root and the `--managed-by` value. Pending:
[ADR-008](008-run-every-bot-as-a-headless-core-under-one-hub.md) supersedes §2's mounting and §8's per-bot
lock and tray once PLAN-009 lands; until then this record describes the shipped code for those parts.

## Context

Proposed dependency follow-up (2026-10-29):
[Platform ADR-142](https://github.com/cats-inc/cats-platform/blob/main/docs/decisions/142-publish-reusable-platform-packages-for-independent-products.md)
would replace the blanket Platform-package exclusion for specifically reviewed
pure/Node public entries after dual-consumer verification. The current import
guard remains in force until adoption lands. Headless core, independent data,
Runtime process/HTTP ownership and product authority are unchanged.

### The owner's direction

- One executable is one bot, wrapping one agent CLI.
- The bot must be "alive": whether through heartbeat, scheduler or event-driven wakeups, it can be woken at
  any time to reply or do work; this is the first priority, with the desktop layer and dragging second.
- It has a tray icon; conversations are notes, and there can be several; the whole bot has exactly one global
  provider/model, not one per conversation.
- It is unclear whether the new member should depend on cats-runtime directly or on cats-platform.

### Two studies that did not reference each other

On 2026-10-27 there were two studies of the same topic, deliberately written without reading each other:

- [Standalone Living Bot Feasibility](../research/2026-10-27-standalone-living-bot-feasibility.md) (Claude):
  clarifies that Catlas is the Guide Cat and that the "alive" mechanism is the companion's life loop
  (platform ADR-127); inventories the runtime's managed-startup and wakeup primitives; lists four dependency
  directions A–D and leans toward depending on the runtime directly; proposes a candidate topology and a
  two-phase shell, and leaves open questions on the note-to-session mapping, the shell choice and the cost of
  multiple bots.
- [Resident Bot Architecture Assessment](../research/2026-10-27-resident-bot-architecture-assessment.md) (Codex):
  argues that the architectural priority is "a resident core whose work survives the shell closing or being
  rebuilt"; points out that one bot is not one PID; gives the conceptual boundaries between bot profile /
  conversation / note view / work item / run; splits being alive into three input paths (event, schedule,
  deliberate heartbeat) plus a health reconciliation loop that does not call the model; lists the minimal
  recovery design, the measurements and the delivery slices.

Where the two documents independently reached the same conclusion, this ADR adopts it directly:

- Depend on cats-runtime directly, over a process + loopback HTTP contract; do not import cats-platform; do
  not build a .catsapp.
- Platform's life loop, heartbeat, turn gate, Telegram polling and desktop/host mode are design references
  that can be copied, not packages that can be depended on (`exports` has only `.` and `./app-sdk`).
- The runtime's wakeup only reattaches a worker and never sends a prompt; it is neither a scheduler nor a
  heartbeat system (runtime SPEC-012).
- desktop-work-fleet provides a verified native shell and two lessons (hidden WebView timers are throttled;
  a desktop window has no redirection surface), but its "non-visual resident core" is only a proposal
  (fleet ADR-058), so copying the shell cannot be assumed to yield the core.
- The desktop layer, the character avatar and cross-platform native hosts each need their own native
  acceptance evidence and are not part of the first usable bot.

Where the two documents complement or diverge, this ADR resolves them as follows:

- Note-to-session mapping: Claude left it as an open question; Codex argued that each conversation has its own
  session attachment, created lazily, with a bot-scoped serialized queue, and that background triggers must
  have an explicit destination. This ADR adopts Codex's conversation model and adds a "home conversation" as
  the only session the life loop keeps warm and the destination of heartbeats (§4).
- Strength of the lifecycle guarantee: Claude proposed Electron for phase one, staying alive when the window
  is closed; Codex asked the first ADR to state the trade-off between "hidden-window operation" and "the core
  does not depend on graphics initialization". This ADR defines the bot core as a module that can run
  headless and does not depend on Electron, mounts it in the Electron main process in phase one, and writes
  down the boundary and the condition for moving to a separate process (§2).
- Scheduling: Claude proposed using runtime wakeup as the cron timer; Codex pointed out that wakeup only
  targets runtime sessions, has no retry and is not a durable bot identity. Adopt Codex: the bot's own journal
  is the source of truth for schedules (§5).
- Heartbeat: Claude reused ADR-127's interval constants directly; Codex stressed that a quiet heartbeat is
  still a real turn and needs a budget. Adopt both: default to ADR-127's shape, but each bot can turn it off
  and it must be measured (§5).
- Permissions: Codex added handling for approval requests that arrive while no window is open; Claude's
  inventory noted that the companion runs with fully automatic permissions. Adopt Codex: background turns and
  interactive turns use the same enforceable runtime permissions, and approval requests wait in the inbox (§7).

### Facts verified on 2026-10-27

- cats-runtime main is 0.6.2 (`5212fa59`) and the npm `latest` is 0.6.1; the package is `type: module`,
  `bin.cats-runtime` points to `build/runtime/index.js`; `CATS_RUNTIME_MAX_SESSIONS` defaults to 50.
- Managed startup: `--startup-mode app-managed --managed-by <name> --ready-output json --host --port`;
  stdout emits `runtime.ready` / `runtime.startup_error` / `runtime.stopping` / `runtime.stopped`;
  closing the child's stdin ends it portably
  ([api.md](../../../cats-runtime/docs/api.md), "App-Managed Lifecycle Events").
- Session endpoints: `POST /sessions` (accepts `instructions`, `workspaceKind`, `workspaceAccess`,
  `mcpServers`, `sessionKey`), `POST /sessions/{id}/messages` (SSE or NDJSON; 409 when busy with no queue,
  404 when there is no worker, 410 when the worker has exited; guardrail 403/429), `resume`, `cancel`,
  `close`, `observe`, `history`.
- Wakeup: `target.kind` is only `session`, cron accepts only UTC, there is no retry/backoff, and a trigger only
  does `ensureSessionAwake`.
- Session status is only `initializing | ready | busy | closing | closed` (runtime `src/core/types.ts`);
  FileWatcher treats the first three as live sessions (`src/backends/cli/discovery/FileWatcher.ts`);
  platform's companion loop deliberately lets an `initializing` session be brought to ready by the first
  heartbeat (`companion/life/loop.ts`).
- Session discovery has four channels: the file-backed FileWatcher (the provider's session directory, which
  is also read by `history` and pi resume), the background native `listSessions()` scan and agent discovery
  (both controlled by `CATS_RUNTIME_NATIVE_DISCOVERY_INTERVAL_MS`, default 5000, `0` disables;
  `src/server.ts`), the WSL / Docker policy (`always | if_running | manual_only`;
  `src/backends/cli/config.ts`), and the explicit `/sessions/discover` endpoint. A discovered session without a
  worker does not count toward `maxSessions` (`WorkerPool` counts only live workers).
- cats-platform has no npm dependency on the runtime (HTTP, pinned SHA); the companion life loop constants are:
  60-second tick, sleep after 15 minutes idle, 2–10 minutes after the heartbeat wakes, then 30–120 minutes,
  defer if the owner spoke within 10 minutes, retry busy after 4 minutes, retry failure after 30 minutes, and a
  12,000-character cap on the handoff pack (ADR-127, SPEC-124).
- Platform's 2026-10-26 fixes (PR #319, #321, #327) define three behaviors that must be preserved: the first
  turn can be run by the heartbeat, resume on wake is distinguished from retarget and retarget does not resume
  the old provider, and segmented replies arrive in order.

## Decision

### 1. Depend only on cats-runtime, over a process + HTTP contract

- The only runtime dependency of `@cats-inc/cats-bots` is `@cats-inc/cats-runtime`, pinned to an **exact
  version** in `package.json` (0.6.1 on npm at the time of writing; 0.6.2 is not yet published). Upgrading the
  runtime is a separate change that must run the contract tests.
- The bot starts the runtime as an app-managed child process: `--startup-mode app-managed --managed-by cats-bots
  --ready-output json --host 127.0.0.1 --port <port>`. The core reserves the port before startup (0.6.1
  rejects `--port 0`, verified in PLAN-001 Phase 1), takes the actual port from `runtime.ready`, and then
  confirms with `GET /health`; the private `CATS_RUNTIME_DIR` is under the bot's data root;
  `CATS_RUNTIME_API_KEY` is generated by the bot; on shutdown it closes stdin first, then sends SIGTERM after
  a timeout.
- Isolating external sessions must target every one of the runtime's discovery channels, not just one:
  - The background native CLI `listSessions()` scan and agent (ACP) discovery are both controlled by
    `CATS_RUNTIME_NATIVE_DISCOVERY_INTERVAL_MS`; the bot sets it to `0` to turn them off;
    `CATS_RUNTIME_WSL_DISCOVERY_POLICY` and `CATS_RUNTIME_DOCKER_DISCOVERY_POLICY` are set to `manual_only`;
    the bot never calls any `/sessions/discover`-style endpoint.
  - File-backed discovery (the runtime mounts a FileWatcher on the session directories of providers such as
    claude, codex, copilot and pi) is **not turned off by changing directories**: the same directory is also
    where the runtime reads `history` and pi resume, and pointing it at an empty folder would break the bot's
    own sessions. The bot accepts that these `origin: 'discovered'` entries exist — they have no worker and
    do not count toward `CATS_RUNTIME_MAX_SESSIONS` — ignores them in every listing, and identifies its own
    sessions only through its own attachment records, never by scanning `GET /sessions` to recognize them.
  - If measurement shows that watching the user's whole session directory costs too much, ask the runtime for
    a flag that "turns off file-backed discovery but keeps `history` reads"; do not work around it in this
    repo.
- Do not source-import the runtime (`createRuntimeServer` is for tests/dev embedding, runtime ADR-009). If
  process overhead later proves to be a problem, in-process embedding becomes the subject of another ADR.
- cats-platform is only a design reference. When copying the life loop, the heartbeat prompt shape, the session
  turn gate, Telegram long polling, or the desktop/host tray and single-instance patterns, note the source file
  and revision in the file header; both repos are MIT. Never import `@cats-inc/cats-platform`, and do not build
  a .catsapp or a thin client of the platform server.
- Each bot owns its own runtime instance. Sharing a runtime among multiple bots is left to be measured and
  revisited once multiple bots actually exist.

### 2. The resident core owns all durable state; the shell is disposable

- The **bot core** is a TypeScript/Node module that must not import Electron, the DOM or any renderer code,
  and can run headless (the `cats-bot` CLI entry, for development, CI and a future service mode). It owns the
  bot profile, conversations, the work queue and journal, runtime supervision, and **all timers**. Fleet's
  lesson: hidden WebView timers are throttled to about once a minute, so timers are never in the renderer.
- The **shell** (tray, note windows, a future character avatar) is only a client of the core. Through a narrow
  command/event interface (SPEC-001's `BotHostApi`) it opens and closes views, sends owner messages, cancels,
  and reads unread counts and progress; it cannot get the runtime's URL or API key.
- The phase-one lifecycle guarantee is "**hidden-window operation**": the bot keeps running when all windows
  are closed, until OS sleep, logout, an explicit Quit or a fatal core error. This is the same boundary as
  platform ADR-127; waking a sleeping computer or running while logged out is a separate OS-integration
  decision.
- Phase one **mounts the core in the Electron main process** (one process tree: Electron main + runtime + CLI
  child, with a renderer only while a note is open). Reason: the Electron main process starts before any
  window, a GPU or renderer failure does not take it down, and the cost of a separate process and local IPC
  should not be paid before a headless core exists.
- The condition for moving to a separate process is fixed here: once there is evidence that a shell failure
  (the kind of graphics-device initialization failure at login recorded in fleet ADR-058) kills the core, move
  the core to a separate child process or a root process. `BotHostApi` must be designed so that this is a
  change in the packaging layer, not in the core.
- "One exe, one bot" means one independently managed instance: its own identity, data root, tray and
  single-instance lock. It is not one PID: the CLI is a child process, and Electron and WebView2 are
  themselves multi-process.

### 3. One bot, one identity, one global execution target

- Each bot instance has one `BotProfile`: a stable id, a name, persona instructions,
  `executionTarget { provider, model }`, a permission policy, a heartbeat policy and a data root.
- `executionTarget` is the **only** provider/model setting for the whole bot (same shape as platform's
  `GuideCatRecord`). Conversations have no override. Each turn reads the current target at admission.
- When the global setting changes, a turn in progress either finishes under the setting it was admitted with
  or is explicitly cancelled; later turns use the new setting. A session attachment created under another
  provider is always marked stale and is not resumed; the id still existing is not a reason to keep using it
  (the lesson of PR #321). Each run records the provider/model it actually used as historical evidence, not
  as a second setting.

### 4. Conversations, notes and sessions

- A **conversation** owns its own transcript (stored by the bot itself, independent of the provider), a
  bounded handoff context, and at most one runtime session attachment; the attachment is created or resumed
  lazily, so opening three notes does not reserve three warm CLI workers.
- A **note** is a view of a conversation (position, size, visibility, layer). Several notes can show different
  conversations; closing a note, deleting a conversation and quitting the bot are three different things.
- Each bot has exactly one **home conversation**, which is the inbox: the life loop keeps only its session
  warm; heartbeats and general proactive messages go only here; a trigger tied to a particular piece of work
  goes back to its original conversation. The destination is always explicit; it never implicitly picks "the
  most recently focused note", and it does not inject each note's private context into every heartbeat.
- Non-home conversations get an idle policy: after idling, close the worker and keep the session id; resume
  natively the next time it is needed.
- Bot memory shared across conversations is "selected facts and open commitments", kept separate from each
  conversation's raw transcript; v1 does only each conversation's own handoff pack (12,000-character cap,
  verbatim for short conversations, digest plus recent content for long ones), and shared memory is deferred.
- Rejected: "a bot has only one session and notes are all views of it": note contexts would mix into one
  another, and every note's turns would have to queue on the same provider session. The home design keeps the
  benefit of "only one warm session".

### 5. Defining "alive": three input paths, one pipeline, and one reconciliation loop that does not call the model

- All three input paths go through the same admission and execution pipeline and produce the same kind of
  **work item**:
  - **Event**: an owner message (note, later Telegram), a work completion, an explicitly configured external
    input. Event-driven input provides immediacy without periodic model calls.
  - **Schedule**: one-shot and recurring work, persisted in the bot's own journal, with a trigger id, a
    destination conversation, an admission state, a missed policy (skip / coalesce / run once) and bounded
    retries. 「三十分鐘後提醒我」 ("remind me in thirty minutes") must create a real schedule through a host
    operation and return a receipt; the model promising it verbally does not count. The runtime wakeup is
    **not** the source of truth for schedules: it targets only runtime sessions, uses UTC cron, has no retry
    and never sends a prompt.
  - **Deliberate heartbeat**: a hidden turn sent into the home conversation at random intervals, carrying the
    local time, how long it has been awake, how long since the owner last spoke, and the handoff pack; if it
    has nothing to say it replies `[quiet]` and the core discards it. By default it follows ADR-127's shape
    (2–10 minutes after waking, then 30–120 minutes, defer if the owner spoke within 10 minutes, retry busy
    after 4 minutes, retry failure after 30 minutes). Even when quiet it is a real provider turn that
    consumes quota; each bot can turn it off, and SPEC-001 requires measuring it.
- The **reconciliation tick** (every 60 seconds, first run 5 seconds after startup, non-overlapping, never
  calls the model): checks the runtime's health and the child processes it owns, and restarts the runtime with
  backoff if it exits unexpectedly; reconciles home's attachment by the session status the runtime reports —
  `initializing`, `ready` and `busy` all count as alive: `initializing` is brought to ready by the next turn
  (including a heartbeat), same as platform's loop; `busy` is a turn in progress, and reconciliation never
  resumes, rebuilds or cancels it; only `closing` / `closed`, or the runtime answering 404 for not knowing the
  session, triggers a resume or rebuild (on failure, back off 5 minutes and record the reason); an
  observation failure (unreachable, timeout, 5xx) is treated as "unknown" and nothing is done — then it scans
  the journal for due schedules and for `running` work items left over from before a restart. After a runtime
  restart, home wakes itself back up within one tick.
- The v1 queue is bot-scoped and serialized: only one turn runs at a time. Owner messages take priority over
  background work; a turn in progress is not implicitly interrupted, and cancellation is always an explicit
  action. The core holds a gate keyed by runtime session so its own concurrency does not cause 409s (the
  runtime has no queue).

### 6. Durability and recovery

- Each bot has one data root (default `~/.cats/bots/<bot-id>/`, overridable by an environment variable), with a
  single writer; writes always go through a temp file plus rename, and reads never write back opportunistically
  (the existing bugs in platform's `FileChatStore` and `FileCompanionBoxStore` came from exactly this); every
  file carries a `schemaVersion`.
- The journal records seven work-item states: queued, running, awaiting_owner, completed, failed, cancelled and
  interrupted (outcome uncertain), plus results and notification delivery state; reopening a window rebuilds
  the truth from the journal and does not need the original event stream.
- The journal cannot promise exactly-once for external effects. A crash after the CLI performed an action but
  before the result was written to disk is uncertain: on restart, reconcile with evidence (the runtime's
  `history` / `observe`), or mark it `awaiting_owner` and ask the owner to decide; never blindly replay all
  interrupted work, and never replay an unbounded backlog.
- No data migration is promised before release; once released, cats-inc's version and upgrade policy (a tested
  upgrade path, backup, atomic replacement, failure recovery) applies.

### 7. Permissions and approval

- Background turns and interactive turns use the same enforceable runtime session settings
  (`workspaceAccess`, `permissionMode`, `allowedTools`, `cwd`), decided by the bot profile's permission
  policy; copying the companion's prompt or its fully automatic mode is not the same as this bot's permission
  policy.
- An approval request the model raises while no window is open becomes an `awaiting_owner` work item, shown in
  the tray and the home conversation; it is never auto-approved; on timeout it is closed out with a reason.
- Never read any CLI's credential files; quota comes only from CLI signals forwarded by the runtime.

### 8. Shell roadmap

- Phase one (Windows first) uses Electron: a tray, frameless note windows, optional always-on-top, on-screen
  dragging, close-to-tray, an explicit Quit, optional start at login, and one single-instance lock per bot id;
  it reuses the tray and candidate profile patterns of platform `desktop/host`.
- The desktop layer / wallpaper layer, the character avatar, and macOS and Linux native hosts are left to a
  **separate ADR**, on the condition that every claimed platform has native acceptance for DPI, focus / IME,
  Explorer and display-loss recovery. The candidates are "Electron plus a native helper porting fleet's
  WorkerW / `SHELLDLL_DefView` mounting" and "adopt fleet's C#/WPF/WebView2 host with the core as a child
  process".
- Until SPEC-001's measurement table is filled in, claim no memory or startup-time advantage for any shell; a
  smaller renderer or a single executable is not in itself evidence of a lower total working set.

### 9. Repo toolchain so the first slice can start

- TypeScript, Node 24, ESM (`"type": "module"`, `NodeNext`), consistent with the runtime; `tsc` handles type
  checking and the build.
- Tests use `node:test`, running `.test.ts` directly with Node 24's native type stripping; so the source uses
  only erasable TypeScript syntax (no enums, namespaces or parameter properties). The jest / eslint toolchain
  of the bootstrap template is not adopted; prettier may stay.
- Turn on the CI Node job: `npm ci`, typecheck, test, build.
- Add an architecture boundary test: the core must not import `electron` or any `cats-platform` path; the
  shell must not hold the runtime client directly.

### 10. Explicitly not done now

- Multiple bots sharing a runtime; rhythm (bedtime / wake-up) — v1 has only the idle policy; image generation
  and albums; mobile; OS-level wake from sleep or running while logged out; Telegram webhook ingress (only
  long polling when added); the desktop layer.

## Consequences

### Positive

- It runs without Cats Desktop, the platform server or its product storage; it directly reuses the runtime's
  16 CLI adapters, resume, streaming, cancellation and session MCP.
- The headless core can be tested and accepted without any UI, and the shell can be swapped; timers are immune
  to renderer throttling.
- Conversation contexts do not mix; there is only one setting to manage; the truth survives window closing and
  restarts.
- It satisfies the durability boundary in point 7 of platform ADR-110: an independent release cadence and a
  versioned runtime contract.

### Negative

- Each bot keeps a Node core, a runtime and a CLI resident (plus Chromium when there is a shell), so the cost
  scales linearly with the number of bots; heartbeats use quota even when quiet.
- The runtime is still 0.x and its contract will drift; the only defenses are version pinning and contract
  tests, and upgrading is deliberate work.
- The phase-one hidden-window guarantee is weaker than a fully isolated core: when the shell crashes the bot
  stops with it, until start-at-login or the owner reopens it.
- Redoing handoff, the gate and polling, which platform has already fixed, risks regressions; the behaviors of
  PR #319, #321 and #327 become SPEC-001 acceptance items.

### Neutral

- "Outcome uncertain" is a first-class state; the journal does not pretend to be exactly-once.
- Task Manager will show several processes; "one exe" is a process tree.
- Choosing Electron for phase one is not a commitment for the desktop-layer phase; the shell technology is
  re-evaluated in phase five.
- Patterns copied from platform are kept under MIT with source notes; no shared package has been extracted
  yet, and points 4 and 6 of ADR-110 may change that later.
- The user's own CLI sessions appear as discovered entries in the bot's private runtime registry (§1); the bot
  ignores them, and the cost is measured in phase three.

## Alternatives Considered

### Alternative 1: Depend on cats-platform

- **Pros**: the most reuse (the companion, dispatch, Telegram and the handoff pack are all there).
- **Cons**: `exports` does not include these interfaces; the logic is tied to ChatState's single JSON snapshot
  and an in-process gate; the package extraction of ADR-110 points 4 and 6 has to be done first.
- **Why rejected**: there is no dependable boundary today. Reevaluate if platform publishes a transport /
  client package.

### Alternative 2: Build it as a .catsapp

- **Pros**: can be distributed inside Cats Desktop.
- **Cons**: cannot own windows, a tray or startup entries; it dies when Cats is closed; `jobs.schedule` has
  only manifest validation and no executor.
- **Why rejected**: opposite to "a standalone process, much lighter".

### Alternative 3: A thin client of the platform server (like Mobile)

- **Pros**: almost no execution logic to write.
- **Cons**: not standalone; still needs Desktop or a headless platform running resident.
- **Why rejected**: does not meet the core requirement.

### Alternative 4: Use runtime wakeup as the bot's scheduler

- **Pros**: the runtime already has a 1-second tick, cron recurrence and replay after restart.
- **Cons**: SPEC-012 explicitly says it is not a scheduler or heartbeat system; it targets only sessions, does
  not send prompts, is UTC only and has no retry.
- **Why rejected**: schedules need bot and conversation identity, a missed policy and retries; they are owned
  by the core's journal.

### Alternative 5: The Electron main process is the core, with no headless entry

- **Pros**: the fastest prototype.
- **Cons**: the core and shell are welded together, so changing the shell or splitting processes means a
  rewrite; a shell failure always takes the core with it.
- **Why rejected**: rejected as a **boundary**, accepted as the phase-one **mounting method** (§2).

### Alternative 6: Use fleet's C#/WPF/WebView2 host as the first shell

- **Pros**: the three-layer desktop layer, tray, single instance and MSIX are verified on real machines.
- **Cons**: an extra .NET toolchain; its resident-core split is not implemented (fleet ADR-058); the first
  value is the headless core.
- **Why rejected**: deferred to a comparison in phase five, not rejected.

### Alternative 7: All bots share one runtime

- **Pros**: fewer processes and less duplicated infrastructure.
- **Cons**: shared capacity, configuration, shutdown ownership and availability all need coordination.
- **Why rejected**: deferred until multiple bots actually exist and can be measured.

### Alternative 8: One session per bot, with notes as views only

- **Pros**: always exactly one warm worker and one destination.
- **Cons**: note contexts mix; all note turns serialize on the same provider session.
- **Why rejected**: the home conversation in §4 keeps the benefit of a single warm session without giving up
  isolation.

## References

- [Standalone Living Bot Feasibility](../research/2026-10-27-standalone-living-bot-feasibility.md) (Claude)
- [Resident Bot Architecture Assessment](../research/2026-10-27-resident-bot-architecture-assessment.md) (Codex)
- [SPEC-001](../specs/SPEC-001-resident-bot-core-and-global-execution.md),
  [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md)
- cats-runtime: [docs/api.md](../../../cats-runtime/docs/api.md),
  [ADR-009](../../../cats-runtime/docs/decisions/009-keep-cats-runtime-separately-packageable-with-app-managed-local-startup.md),
  [SPEC-012](../../../cats-runtime/docs/specs/SPEC-012-scheduled-wakeup-substrate.md)
- cats-platform: [ADR-003](../../../cats-platform/docs/decisions/003-electron-host-manages-local-services.md),
  [ADR-110](../../../cats-platform/docs/decisions/110-keep-platform-clients-in-one-repository-with-explicit-package-boundaries.md),
  [ADR-127](../../../cats-platform/docs/decisions/127-keep-companion-cats-alive-with-a-platform-owned-life-loop.md),
  [SPEC-124](../../../cats-platform/docs/specs/SPEC-124-alive-companion-life-loop.md),
  [PLAN-117](../../../cats-platform/docs/plans/PLAN-117-alive-companion-life-loop.md)
- desktop-work-fleet: [ADR-017](../../../../sammykenny2/desktop-work-fleet/docs/decisions/017-windows-composition-surface-and-input.md),
  [ADR-030](../../../../sammykenny2/desktop-work-fleet/docs/decisions/030-windows-explorer-wallpaper-layer.md),
  [ADR-058](../../../../sammykenny2/desktop-work-fleet/docs/decisions/058-desktop-presentation-lifecycle-and-core-isolation.md)
- cats-inc version and upgrade policy: [cats-one release guide](../../../cats-one/docs/release-guide.md)
- Relative paths assume the side-by-side checkouts of the cats-inc developer workspace; fleet lives at
  `../sammykenny2/desktop-work-fleet`.

---

*Decision made: 2026-10-27 (accepted)*
*Decision makers: Product owner (approved by authorizing PLAN-001 on 2026-10-27), Claude (author; fuses the Claude and Codex research)*
