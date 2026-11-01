# SPEC-001: Resident Bot Core and Global Execution Contract

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted — 2026-10-27 together with [ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md); implemented by PLAN-001 |
| **Owner** | Claude |
| **Reviewer** | Owner |
| **Related decision** | ADR-001 |
| **Related plan** | [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md) |
| **Pending change** | [SPEC-007](SPEC-007-cats-bot-identity-and-data-root.md) changes the FR-2 data root and FR-5 `--managed-by` (PLAN-008); [SPEC-008](SPEC-008-hub-and-bots.md) hosts the core under a hub (PLAN-009) |

## Summary

A cats-bot is one independently managed resident instance: a bot core owns the bot profile, conversations, the
work journal and the timers; it starts a private cats-runtime as an app-managed child process and, over
loopback HTTP, has the selected provider CLI run turns. The owner talks to it from a note window or (later)
Telegram; it stays alive through events, durable schedules and a deliberate heartbeat, and uses a reconciliation
tick that does not call the model to keep the runtime and the home conversation's session going. The whole bot
has exactly one global provider/model. The shell (tray, notes) is a disposable client; the bot keeps running
when all windows are closed.
For decisions and trade-offs see ADR-001; this document defines behavior that can be accepted, and is not a
freeze of the storage format.

## Goals

- Run without Cats Desktop and the platform server: one bot instance, one private runtime, one CLI.
- With all windows closed, owner messages, due schedules and heartbeats still run, results are kept, and
  reopening a window rebuilds progress.
- After a runtime restart or a session being closed, the home conversation's session wakes itself back up
  within one reconciliation tick.
- Conversation contexts do not mix; a global provider/model change affects only later turns, and an old
  attachment does not quietly keep using the old model.
- The core can run and be tested headless; the shell operates the core only through a narrow interface.

## Non-Goals

- The desktop layer / wallpaper layer, the character avatar, macOS and Linux native hosts (a separate ADR).
- Multiple bots sharing a runtime; rhythm (bedtime / wake-up); selection of shared bot memory; image generation
  and albums.
- OS-level wake from sleep, running while logged out, Telegram webhook ingress.
- Promising exactly-once for external effects.
- Data migration before release; after release, cats-inc's version and upgrade policy applies.
- Importing `@cats-inc/cats-platform`, building a .catsapp, reading any CLI credential file.

## Definitions

- **Bot instance**: one data root, one `BotProfile`, one private runtime child process, one single-instance lock.
- **Bot core**: the Node module that owns the profile, conversations, journal, runtime supervision and all
  timers; it does not depend on Electron.
- **Shell**: the presentation layer such as the tray and note windows; only a client of the core.
- **Conversation**: the unit for which the bot itself holds the transcript and handoff context; at most one
  runtime session attachment.
- **Home conversation**: exactly one per bot; the only session the life loop keeps warm; the destination of
  heartbeats and general proactive messages; also the inbox.
- **Note**: a view of a conversation (position, size, visibility, layer).
- **Attachment**: the mapping between a conversation and a runtime session, containing `sessionId`, the
  provider/model at creation time, `providerSessionId`, and a status
  `none | initializing | ready | sleeping | closed | stale | failed`.
- **Work item**: the unit of the admission pipeline; its source is an owner message, a schedule, an event or a
  heartbeat; its state is `queued | running | awaiting_owner | completed | failed | cancelled | interrupted`.
- **configRevision**: a sequence number incremented each time `executionTarget`, `instructions` or
  `permissions` (including `cwd`) actually changes; a work item records it at admission, and an attachment
  records the value at its creation.
- **Session alive**: the `status` reported by the runtime's `GET /sessions/{id}` (or `observe`) is
  `initializing`, `ready` or `busy`; the runtime's `SessionStatus` is only these three plus `closing` and
  `closed`. `closing` / `closed` means "closed"; 404 means "does not exist"; unreachable, timeout or 5xx means
  "unknown", which is different from closed. On the attachment side: `ready`, and `initializing` with a session
  id, are candidates for alive; `busy` is not an attachment status but what the runtime reports for a turn in
  progress.

## Requirements

### Bot profile and data root

1. FR-1: `BotProfile` fields: `schemaVersion`, `id` (generated on first creation and never changed afterwards),
   `name`, `instructions` (the persona, the bootstrap instructions of every session),
   `executionTarget: { provider, model | null }`, `configRevision`,
   `permissions: { workspaceAccess, permissionMode, allowedTools?, cwd }`,
   `heartbeat: { enabled, wakeMinMinutes, wakeMaxMinutes, regularMinMinutes, regularMaxMinutes }`
   (defaults `true`, 2, 10, 30, 120), `idleSleepMinutes` (default 15), `updatedAt`.
2. FR-2: The data root defaults to `~/.catsbot/bots/<id>/`; `CATS_BOT_HOME` moves the whole `~/.catsbot` root
   (SPEC-007 FR-3, FR-4). Layout:
   `profile.json`, `conversations/<conversationId>.json` (conversation metadata and attachment),
   `transcripts/<conversationId>.jsonl`, `journal.jsonl` (work items, schedules and state transitions),
   `runtime/` (used as `CATS_RUNTIME_DIR`), `logs/`; plus the core's `life.json` (time of the last tick),
   `instance.lock.json`, `handoff/`, `secrets.json` (the Telegram token and the like, see Open Questions),
   `telegram-state.json` (the last admitted `update_id`, not secret), and the shell's own `shell-state.json`
   (note position, size, always-on-top, start at login).
3. FR-3: A data root has only one writer at a time, guaranteed by a lock file; a second instance with the same
   id hands its startup arguments to the first and exits. All writes go through a temp file plus rename; reads
   never write back. Under the hub (SPEC-008) the writer is the bot's core process; the hub's own files have
   their own locks, and the hub takes a bot's lock only to archive, restore or delete it.
4. FR-4: When reading, missing or invalid fields get defaults field by field without rewriting the existing
   file; when a file is corrupt, report an error and keep the original file, never overwriting it with empty
   content.

### Runtime supervision

5. FR-5: The core starts a child process with the `cats-runtime` bin of the pinned `@cats-inc/cats-runtime`
   package: `--startup-mode app-managed --managed-by cats-bot --ready-output json --host 127.0.0.1 --port <port>`,
   where `<port>` is a free loopback port the core reserves itself before startup (runtime 0.6.1 rejects
   `--port 0`); environment variables `CATS_RUNTIME_DIR=<root>/runtime`,
   `CATS_RUNTIME_API_KEY=<random value generated by the core>`,
   `CATS_RUNTIME_NATIVE_DISCOVERY_INTERVAL_MS=0` (turns off background native and agent discovery),
   `CATS_RUNTIME_WSL_DISCOVERY_POLICY=manual_only`, `CATS_RUNTIME_DOCKER_DISCOVERY_POLICY=manual_only`.
   It changes no provider's session directory setting, because the same directory is also the read source for
   `history` and resume; the core never calls `/sessions/discover`-style endpoints; the `origin: 'discovered'`
   sessions the runtime imports through FileWatcher have no worker, and the core ignores them in every listing
   and identifies its own sessions only by attachment records, without scanning `GET /sessions`.
   It takes `healthUrl` from `runtime.ready` on stdout, and only a successful `GET /health` counts as ready; on
   timeout (default 60 seconds) it marks `failed` and records the reason.
6. FR-6: When the runtime exits unexpectedly, the core marks the runtime `failed` and all attachments `closed`,
   and the reconciliation tick restarts it with backoff (5 seconds, 30 seconds, 2 minutes, 5 minutes, then a
   fixed 5 minutes), recording each restart in the journal. This differs from platform `processSupervisor`,
   which only marks `failed` without restarting, because the bot's promise is to be alive.
7. FR-7: Shutdown order: cancel the turn in progress, close the child's stdin, wait for `runtime.stopping` /
   `runtime.stopped` or a timeout (10 seconds), then SIGTERM; after the core exits it must not leave orphaned
   runtime or CLI processes.
8. FR-8: An unreachable runtime is always treated as "unknown": do not change attachment status, do not sleep,
   do not rebuild, do not replay.

### Conversations and sessions

9. FR-9: Conversation record fields: `id`, `role: 'home' | 'note'`, `title`, `createdAt`, `updatedAt`,
   `attachment`, `unreadCount`, `lastOwnerMessageAt`, `lastBotMessageAt`, the handoff checkpoint.
10. FR-10: Each bot has exactly one home conversation, created on first startup; it can be cleared but not
    deleted.
11. FR-11: Attachments are created lazily: when a work item is admitted and the attachment is `none` /
    `closed` / `stale`, `POST /sessions` with `executionTarget`, `instructions` (persona plus handoff pack), the
    corresponding `permissions` fields and `mcpServers` (the bot tool server of FR-24); when it is `sleeping`,
    `POST /sessions/{id}/resume`. If resume fails, keep the attachment, mark it `failed` and write the error
    into the conversation, never silently substituting a blank session. A conversation has only one binding at
    a time: when the reconciliation tick and a turn bind at the same time they share one result, and do not
    each create a session that overwrites the other's attachment; the handoff pack does not include owner
    messages still `queued` / `running`, which are sent in as messages.
12. FR-12: Handoff context: the CLI provider's native transcript is kept by the CLI; the core additionally keeps
    its own transcript and, when creating or replacing a session, sends the handoff pack in the instructions:
    12,000-character cap, verbatim for short conversations, digest plus recent content for long ones. The
    digest is lossy, and lossless recall is not claimed.
13. FR-13: Idle policy: a non-home conversation's attachment with no turn within `idleSleepMinutes` has its
    worker closed (`POST /sessions/{id}/close`), its status becomes `sleeping` and the session id is kept. The
    home conversation is not subject to the idle policy.
14. FR-14: Deleting a conversation: `close` first, then `DELETE /sessions/{id}`, and after confirmation remove
    the transcript and views; closing a note view never deletes a conversation; quitting the bot never deletes
    any conversation.

### Admission, queue and turns

15. FR-15: Every turn is a work item: `id`, `kind: owner_message | heartbeat | schedule | event`, `source`,
    `conversationId` (the destination, required), `createdAt`, `admittedAt`, `configRevision`, `state`,
    `attempts`, `coalesceKey?`, `result?`, `notification?`.
16. FR-16: The queue is bot-scoped and serialized, with only one `running` at a time. Owner messages jump ahead
    of all background work items; a `running` background work item is not preempted; cancellation is triggered
    only by an explicit owner action (`POST /sessions/{id}/cancel`).
17. FR-17: The core holds a gate keyed by runtime session, to ensure its own concurrency does not cause 409s.
    Only a recognized session-busy 409 is retried: a background work item is retried once after 4 minutes;
    an owner message waits 15 seconds between attempts, with at most eight attempts. Waiting remains
    cancellable and keeps Send disabled. After the limit the item fails with an explicit notice and its
    prompt stays in history for an owner-directed retry. Other 409 responses fail with their original
    reason and code. A retry never replaces or cancels another turn's session. Runtime cancellation is
    sent only after this work item's HTTP stream was admitted. No persisted format changes are needed.
18. FR-18: Turn execution goes through `POST /sessions/{id}/messages` with `Accept: application/x-ndjson`;
    `text`, `tool_use`, `tool_result`, `progress`, `error` and `result` events are appended to the transcript
    and the view in real time; receiving `result` marks `completed`; a stream that ends without `result` marks
    `interrupted`; a 404 "no active worker" resumes first and then retries once; a 410 marks the attachment
    `closed` and rebuilds it at the next admission; a 403 / 429 guardrail marks `failed` with the runtime's
    reason and respects `cooldownUntil`.
19. FR-19: The bot's replies are appended to the destination conversation in order; when a transport is
    attached later, segmentation (Telegram 4,000 characters) must preserve order.

### Being alive: reconciliation, schedules, heartbeat, events

20. FR-20: The reconciliation tick runs every 60 seconds, first run 5 seconds after startup, non-overlapping,
    and never calls the model:
    - Check runtime health, and restart per FR-6 when `failed`.
    - Reconcile the home conversation's attachment using the classification in Definitions:
      - Alive (`initializing` / `ready` / `busy`): leave it alone. `initializing` is brought to ready by the
        next turn (including a heartbeat, same as platform `companion/life/loop.ts`); when the session is
        `busy` or the attachment has a `running` work item, the tick never resumes, rebuilds or cancels.
      - Closed (`closing` / `closed`) or nonexistent (404): if the attachment is `sleeping`,
        `POST /sessions/{id}/resume`, otherwise rebuild per FR-11; on failure back off 5 minutes, with the
        reason recorded as `no_capacity` (`Max sessions (N) reached`), `wake_failed` or `runtime_unavailable`,
        and each stretch of failure is recorded only once.
      - Unknown (unreachable, timeout, 5xx): per FR-8 do nothing, and look again at the next tick.
    - Mark `running` work items left over from before a restart as `interrupted` and hand them to FR-27.
    - Turn due schedules into work items (FR-21).
    - On each state transition write one `presence` record (`awake` / `sleeping` / `failed`); do not write one
      when the session was already alive.
21. FR-21: Schedule record: `id`, `conversationId`, `kind: once | cron`, `at` (ISO) or `cron` plus an IANA
    `timezone` (default: the host's local time zone; the core does the time zone conversion and does not rely
    on the runtime's UTC cron), `prompt`, `missedPolicy: skip | coalesce | run_once` (default `run_once` for
    `once` and `coalesce` for `cron`), `graceMinutes` (default 1,440), `createdBy: owner | agent`, `receipt`.
    When due it creates a work item whose `coalesceKey` is the schedule id; if the same schedule still has a
    `queued` work item (including one waiting out a retry delay), it does not create a duplicate. When a
    schedule is cancelled, its work items that have fired and are still queued or in a retry delay are also
    marked `cancelled`; when a retry timer expires it first rereads the work item and does not run it if it is
    no longer `queued`.
22. FR-22: Schedules missed during downtime are handled by `missedPolicy`: `skip` records a skip notification;
    `coalesce` merges them into one; `run_once` runs once within `graceMinutes` and skips with a notification
    beyond that. Never replay an unbounded backlog.
23. FR-23: When resuming after OS sleep, run a reconciliation tick immediately; time spent asleep is treated as
    downtime and FR-22 applies; the heartbeat catches up at most once.
24. FR-24: The core provides the bot tools through a session MCP server (`mcpServers`): `schedule_create`,
    `schedule_list`, `schedule_cancel`, `ask_owner`. A schedule exists only after the journal write succeeds;
    the tool returns a result containing a `receipt`, and the core writes the receipt into the conversation;
    when the model only promises verbally in its reply without calling the tool, no schedule exists.
    `schedule_list` and `schedule_cancel` can see only the schedules of the conversation the caller is in; a
    schedule id from another conversation and a nonexistent id return the same error, neither leaking contents
    nor allowing cancellation.
25. FR-25: The heartbeat is scheduled only when `heartbeat.enabled` and the home attachment is alive; the timer
    lives in memory and is redrawn after a restart:
    - The first one after waking is within 2–10 minutes, `kind: wake`; if a `wake` heartbeat already happened
      within 3 hours of waking, it becomes a regular heartbeat.
    - After that, one at a random time every 30–120 minutes, `kind: regular`.
    - If the owner spoke within 10 minutes, defer to 10 minutes after that message and redraw; if the session
      is handling a turn, defer 4 minutes.
    - The prompt contains the local time, how long it has been awake, how long since the owner last spoke, and
      "if you have nothing to say, reply only `[quiet]`"; the handoff pack is not stuffed into every heartbeat,
      since it was already sent in the instructions when the session was created or replaced (FR-11, FR-12).
    - A reply of `[quiet]` (case-insensitive, ignoring surrounding whitespace) is discarded; otherwise it is
      written into the home conversation as a bot message (`origin: heartbeat`), `unreadCount` is incremented
      and a notification event is emitted.
    - When busy, retry the same heartbeat after 4 minutes; on failure retry after 30 minutes. Each heartbeat
      records its `kind` and `spoke | quiet | busy | failed`, without recording the prompt or reply content.
26. FR-26: Event sources: owner messages sent from a note; work item completion (produces a notification and
    does not automatically produce a new turn); later, Telegram long polling with the bot's own token and a
    single `getUpdates` consumer, where inbound messages become owner-message work items of the home
    conversation and bot replies are mirrored back to Telegram; file watching and local webhooks must be
    explicitly configured and are off by default. The `offset` advances only after an update has been durably
    admitted (the owner-message work item has been written to the journal, or it is certain that no handling is
    needed); when handling fails it is not acknowledged and the same one is fetched again after backoff; an
    update that fails 5 times in a row has its id recorded (without content) and is skipped, so that one bad
    message cannot block polling. The last admitted `update_id` is persisted per bot id and confirmed first
    after a restart, so a resent update that was already admitted is not processed twice; a work item also
    records `sourceRef` (`telegram:<chat>:<message>`), so even if a crash happens after the work item was
    written to the journal but before `update_id` was saved, the resent same message does not create a second
    work item.

### Global provider/model changes

27. FR-27: When `executionTarget`, `instructions`, `permissions` (including `cwd`) or the resolved reply
    language (SPEC-008 FR-28) change, `configRevision`
    is incremented and persisted; a `running` work item finishes under the revision it recorded or is
    cancelled; a `queued` work item rereads at admission; an attachment created under an older revision is
    marked `stale` and not resumed, the next admission rebuilds the session from the handoff pack and tells the
    owner in the conversation; the superseded session is closed (`close`) when no turn is running in it, so no
    worker is left outside the idle policy. When the values are all identical it is a no-op; name, heartbeat,
    idle and Telegram settings do not affect the session. Changing provider requires restarting the private
    runtime: if a turn is running, let it finish under the original setting first, during which the queue
    pauses admission and the tick does not touch the runtime; only after the turn ends is the runtime
    restarted, and then later work is admitted. Every run records the provider/model actually used.

### Recovery and notification

28. FR-28: Before sending the prompt, write the run (provider, model, session id, `startedAt`,
    `historyBaseline`: the number of messages in history before sending, 0 for a new session, null if
    unreadable) into the journal. At startup, load the journal and change `running` to `interrupted`; for
    each `interrupted` work item reconcile using `GET /sessions/{id}/history`. The runtime's history has no
    turn-end marker, so completion must have evidence: the prompt belongs to this run (it is after
    `historyBaseline`; with no baseline, identified by a timestamp not earlier than `startedAt`), a reply
    follows it, the tool calls of this turn that the core itself recorded all have results, and the last reply
    comes after the last tool result. Only when all hold is it marked `completed` and the result filled in
    from that reply; otherwise it is marked `awaiting_owner` with an evidence summary. Never rerun
    automatically.
29. FR-29: Notification delivery state (`deliveredAt`, `seenAt`) is persisted together with the result; when a
    note is reopened, `unreadCount` and progress are rebuilt from the store without the original event stream.

### Permissions and approval

30. FR-30: All sessions are created with the profile's `permissions`, the same for background and interactive
    turns. When the model calls `ask_owner`, an `awaiting_owner` work item is created, shown in the tray and
    the home conversation; with no window open it waits in place; it is never auto-approved; on timeout
    (default 24 hours) it is marked `failed` with a reason.
31. FR-31: The core never reads provider credential files; quota and usage are obtained only through the
    runtime's `/usage/snapshot`.

### Presentation contract (`BotHostApi`)

32. FR-32: Commands: `getProfile`, `updateProfile` (including `executionTarget`, `heartbeat`),
    `listConversations`, `createConversation`, `deleteConversation`, `openView` / `closeView` (change only the
    view), `setViewFocused(conversationId, focused)` (which view the owner is looking at; only a focused view
    keeps new replies from counting as unread, and a note that is open but in the background still accumulates
    unread), `sendOwnerMessage(conversationId, text)`, `cancelTurn(conversationId)`,
    `markSeen(conversationId)`, `listSchedules`, `cancelSchedule`, `resolveApproval(workItemId, decision)`,
    `quit`. Events: `conversation.updated`, `turn.delta`, `turn.completed`, `work.awaitingOwner`,
    `presence.changed`, `runtime.status`. The renderer never gets the runtime's URL or API key.
33. FR-33: Note view: streaming output, an input box, history, cancel, an unread marker, on-screen dragging,
    optional always-on-top. Tray: open the home note, list conversations, new note, pause heartbeat, quit.
    Closing a note, deleting a conversation and quitting the bot are three separate things.
34. FR-34: Phase one mounts the core in the Electron main process and exposes `BotHostApi` through
    contextBridge / IPC; all timers are in the main process; the renderer holds no state that needs to be
    written to disk.

### Non-Functional Requirements

- **Cost**: at the default heartbeat intervals, a bot awake all day runs about 12–48 hidden turns per day; it
  can be turned off; each quiet heartbeat also counts against the provider quota, and the count can be seen in
  `logs/`.
- **Capacity**: the private runtime has a default cap of 50 sessions; the bot uses 1 home plus the number of
  open notes; an ephemeral provider spawns once per turn; discovered entries imported by FileWatcher have no
  worker and do not count toward the cap.
- **Measurement** (phase three, measured on 2026-10-27 on Windows 11, Electron 41.2.0, runtime 0.6.1 with a
  fixture provider; the numbers are the budget, and a real CLI adds its own cost on top):

  | Scenario | Measured 2026-10-27 (fixture provider) |
  | --- | --- |
  | Tray only, idle (notes hidden but the renderer still present) | 7 processes (Electron 5, runtime node 1, conhost 1), working set 468 MB, private 312 MB, CPU 0.03% over 10 seconds |
  | 1 and 3 notes open | 1 note: 7 processes, working set 470 MB, private 314 MB; 3 notes: 11 processes (including the provider worker), working set 725 MB, private 403 MB, CPU 0.21%; each note adds about 100–130 MB working set |
  | First and post-resume CLI turns | First turn of a new note (create session plus spawn fixture) first token 175 ms, done 184 ms; second turn on a warm session first token 34 ms, done 42 ms (only the bot's and the runtime's overhead) |
  | All windows closed, schedule runs | With all three notes hidden, a schedule added via the CLI for 1 minute later: ran at the next tick after it was due (119 seconds after adding), the result was written to the journal and transcript, and home `unreadCount` became 1 |
  | 2 bots at once | One runtime each: the first (3 hidden notes) working set 726 MB, the second (1 note) 660 MB, about 1.4 GB total, 18 processes; idle CPU 0.03–0.13%; provider capacity not contended (fixture) |
  | Display loss and recovery | Not yet measured (needs a physical display change); the window position is clamped back into the visible work area on open |

  Budget implication: a hidden note does not release its renderer; to lower the tray's idle cost, the window
  could later be destroyed after being hidden for a while and rebuilt on demand.

- **Security**: the runtime binds only to loopback; the API key is randomly generated per bot; the Telegram
  token is preferably stored in the OS credential store, and when falling back to a file the permissions are
  restricted and the risk is stated explicitly (not copying platform's plaintext storage); logs contain no
  prompts, replies or credentials.
- **State hygiene**: tests use only temp directories and a fake runtime client; integration tests use a temp
  `CATS_RUNTIME_DIR` for the runtime; never touch the real `~/.catsbot` or `~/.cats`.
- **Portability**: phase one is accepted on Windows only; the core itself must not contain platform-specific
  path assumptions.

## Acceptance

Each item corresponds to a PLAN-001 phase; every one needs a re-runnable test or manual acceptance that leaves
evidence.

- A1 Headless core: with the real selected CLI (or the runtime's scripted fixture provider), create a
  conversation, stream a reply, cancel, resume; after restarting the core the profile, conversations and
  journal are consistent, and `interrupted` work items are not rerun; when the private runtime's registry
  contains discovered entries, the bot's conversation list is unaffected, and `history` of its own session is
  readable.
- A2 Alive: in a conversation, use the tool to create a schedule for "30 minutes later", close all windows; at
  the due time it runs, the result is kept and a notification event is emitted; after killing the runtime
  process, home's session returns to `ready` within 60 seconds; a tick that runs during a long turn (`busy`)
  leaves no resume, rebuild or cancel record, and the turn completes normally; an `initializing` session is
  brought to ready by the heartbeat; when the heartbeat replies `[quiet]` the conversation has no new message
  but the log has a record; duplicate input is coalesced; the status and messages when the provider is busy
  or unavailable are truthful.
- A3 Shell: close a note and execution continues; reopen the note and history and progress are rebuilt; after
  Quit there are no orphaned runtime or CLI processes.
- A4 Multiple notes and global change: a passphrase written in one note cannot be elicited in another; after
  changing provider/model, the turn in progress finishes under the old setting and the next turn uses the new
  one; the old attachment is not resumed.
- A5 Telegram (optional phase): a direct message coming in is answered by the home conversation, and the same
  token has only one polling consumer.
- A6 Boundary: the architecture boundary test proves that the core does not import `electron` or any
  `cats-platform` path.

## Design Overview

- `src/core/profile/`: `BotProfile` reading, writing and defaults.
- `src/core/store/`: atomic writes, lock file, journal append and rebuild.
- `src/core/runtime/`: child process supervision (start, ready, backoff restart, shutdown) and the HTTP client
  (sessions, messages, resume, cancel, observe, health).
- `src/core/conversations/`: conversations, transcripts, attachments, handoff pack.
- `src/core/queue/`: work items, admission, serialized queue, session gate, turn execution and event parsing.
- `src/core/life/`: reconciliation tick, schedules, heartbeat, recovery.
- `src/core/tools/`: the bot's session MCP server (schedules and `ask_owner`).
- `src/core/host-api/`: the types and event bus of `BotHostApi`.
- `src/cli/`: the headless entry `cats-bot` (`init`, `run`, `say`, `status`, `schedule`).
- `src/shell/electron/`: the phase-three tray, note windows and IPC bridge.

```text
tray / note windows (Electron renderer)
        │  BotHostApi (IPC; commands + events)
bot core (Node, in the Electron main for Phase 1; headless via `cats-bot run`)
        │  loopback HTTP + API key
cats-runtime (app-managed child, --port 0, private CATS_RUNTIME_DIR)
        │
provider CLI (claude / codex / pi resident; others spawned per turn and resumed)
```

## Dependencies

- `@cats-inc/cats-runtime`, exact version (npm `latest` is 0.6.1; 0.6.2 on main is not yet published).
- Node.js 24; TypeScript 5 (erasable syntax); `node:test`.
- Electron (phase three).
- A minimal MCP Streamable HTTP server implementation (phase two; the runtime's `mcpServers` accepts only
  `transport: http`; written in-house without pulling in an SDK, with the decision recorded in PLAN-001).
- Design references: platform `src/products/chat/companion/life/`, `sessionTurnGate.ts`,
  `platform/transports/telegram/polling.ts`, `desktop/host/tray.ts` and `candidateProfile.ts`.

## Open Questions

- [x] Telegram token storage (2026-10-27): stored in `secrets.json` in the data root; the Electron shell
      encrypts it with `safeStorage` (Windows DPAPI, macOS Keychain, Linux secret service) before storing it,
      and the headless CLI falls back to a plaintext file (POSIX mode 0600) and says so explicitly in command
      output; a shell capable of encryption re-encrypts plaintext entries at startup and when it receives a
      handoff from the CLI for a token change; status reports the protection actually in use, not the host's
      capability. A value stored one way that the other kind of host cannot read is reported, not guessed.
- [ ] Rhythm: whether to reuse ADR-127's bedtime / wake window, or have only the idle policy and a manual
      pause.
- [ ] Selection and presentation of shared bot memory (facts, commitments, open loops).
- [ ] Whether the same provider can change model without changing session (depends on whether each CLI
      supports specifying the model per turn).
- [x] The home conversation mirrors to Telegram by default (2026-10-27): when enabled, every completed reply in
      home (including heartbeat openers and schedule results) is sent in order to the owner's chat; note
      conversations are not mirrored.
- [ ] The threshold for evaluating multiple bots sharing a runtime.
- [ ] The phase-five shell: Electron plus a native helper, or fleet's host plus a core child process.
- [ ] The cost of file-backed discovery: if watching the user's whole session directory is unacceptable, ask
      the runtime for a flag that "turns off file-backed discovery but keeps `history` reads".

## References

- [ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md)
- [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md)
- [Standalone Living Bot Feasibility](../research/2026-10-27-standalone-living-bot-feasibility.md),
  [Resident Bot Architecture Assessment](../research/2026-10-27-resident-bot-architecture-assessment.md)
- cats-runtime [docs/api.md](../../../cats-runtime/docs/api.md),
  [SPEC-012](../../../cats-runtime/docs/specs/SPEC-012-scheduled-wakeup-substrate.md)
- cats-platform [SPEC-124](../../../cats-platform/docs/specs/SPEC-124-alive-companion-life-loop.md)

---

*Created: 2026-10-27*
*Author: Claude*
*Related Plan: [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md)*
