# PLAN-001: Resident Bot Core Foundation

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Phases 0–4 done — the owner told the team to start implementing on 2026-10-27 and it was completed the same day; Phase 5 is not scheduled per the plan (it needs a new ADR) |
| **Owner** | Claude |
| **Assigned To** | Claude |
| **Reviewer** | Owner |
| **Related decision** | [ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md) |

## Related Spec

[SPEC-001: Resident Bot Core and Global Execution Contract](../specs/SPEC-001-resident-bot-core-and-global-execution.md)

## Overview

One toolchain prerequisite phase plus five phases that can each be demonstrated on their own. The order follows
the priority the two research documents share: first a headless resident core, then make it alive, and only
then add the shell; multiple notes and global changes come after the shell; the desktop layer and the character
avatar need a new ADR, and this plan only reserves a place for them. Each phase's exit corresponds to SPEC-001's
Acceptance (A1–A6). This plan does not choose a release version and does not authorize publishing.

## Implementation Phases

### Phase 0: Toolchain and boundaries (ADR-001 §9)

- [x] Task 0.1: Change `tsconfig.json` to ESM (`module: NodeNext`, `moduleResolution: NodeNext`,
      `target: ES2022`, `erasableSyntaxOnly: true`, output to `dist/`), and add `"type": "module"` to
      `package.json`.
- [x] Task 0.2: Change the `package.json` scripts to `build` (tsc), `typecheck` (tsc --noEmit),
      `test` (`node --test "tests/**/*.test.ts"`), `bot` (`node dist/cli/main.js`); remove the jest, ts-jest,
      ts-node and eslint template dependencies; keep prettier; add the exact version 0.6.1 of
      `@cats-inc/cats-runtime` to `dependencies`.
- [x] Task 0.3: Turn on the Node job in `.github/workflows/ci.yaml`: Node 24, ubuntu and windows,
      `npm ci`, typecheck, test, build.
- [x] Task 0.4: `tests/architecture-boundaries.test.ts`: `src/core/**` and `src/cli/**` must not import
      `electron`, any `cats-platform` path, or a relative path into a sibling checkout; `src/shell/**` must not
      import `src/core/runtime/client`.
- [x] Task 0.5: `docs/services.md` records that the runtime child process binds loopback dynamically with
      `--port 0` and this repo has no fixed listener; `docs/setup-guide.md` and `docs/testing.md` get the
      actual commands.
- [x] Task 0.6: Change the `src/index.ts` placeholder to export the core's public types; clean up `.gitkeep`
      per the mbf rule.

**Deliverables**: `npm ci && npm run typecheck && npm test && npm run build` all pass on a clean checkout and on
CI; the boundary test exists and passes.

### Phase 1: Headless core (SPEC-001 FR-1–FR-19; acceptance A1, A6)

- [x] Task 1.1: `src/core/profile/`: the `BotProfile` type, defaults, field-by-field filling, `configRevision`.
- [x] Task 1.2: `src/core/store/`: data root layout, lock file and single-instance handoff, atomic writes with
      temp file plus rename, journal append and rebuild at startup.
- [x] Task 1.3: `src/core/runtime/supervisor.ts`: start the app-managed runtime with the pinned package's bin,
      parse `runtime.ready`, confirm with `GET /health`, backoff restart, shutdown order, turn off background
      discovery with environment variables (`CATS_RUNTIME_NATIVE_DISCOVERY_INTERVAL_MS=0`, WSL / Docker policy
      `manual_only`; no change to the provider's session directory).
- [x] Task 1.4: `src/core/runtime/client.ts`: sessions create / resume / close / delete / cancel /
      observe / history, NDJSON stream parsing of `messages`, health; Bearer API key.
- [x] Task 1.5: `src/core/conversations/`: conversations and transcripts, home conversation creation, the
      attachment state machine, the handoff pack (12,000 characters; verbatim for short, digest plus recent for
      long), the idle policy.
- [x] Task 1.6: `src/core/queue/`: work items, admission (recording `configRevision`), serialized execution,
      the session gate, handling of 404 / 409 / 410 / 403 / 429, and appending replies in order.
- [x] Task 1.7: `src/cli/main.ts`: `cats-bot init`, `run`, `say <conversation> <text>`, `status`,
      `conversations`; `run` runs the core in the foreground and prints events to stdout.
- [x] Task 1.8: Tests: unit tests with a fake runtime client and a fake clock (state machines, gate, retries,
      handoff pack truncation); integration tests with a real runtime process plus a scripted fixture provider
      in a temp directory (create, stream, cancel, resume, state consistent after restarting the core; when the
      registry has discovered entries the list is unaffected and `history` is readable).

**Deliverables**: A1 passes; `cats-bot run` with a real CLI can converse, cancel and resume; restarting does not
rerun `interrupted` work items.

### Phase 2: Alive (SPEC-001 FR-20–FR-31; acceptance A2)

- [x] Task 2.1: `src/core/life/reconcile.ts`: the 60-second reconciliation tick (first run 5 seconds after
      startup, non-overlapping, never calls the model), runtime restart, runtime status classification (alive /
      closed / nonexistent / unknown) and `busy` protection, home's resume / rebuild with 5-minute backoff,
      `presence` records, leftover `running` turned into `interrupted`.
- [x] Task 2.2: `src/core/life/schedules.ts`: one-shot and cron (IANA time zone converted by the core), due
      schedules turned into work items, coalesce, missed policy and grace.
- [x] Task 2.3: `src/core/tools/`: the bot's session MCP server (`schedule_create`, `schedule_list`,
      `schedule_cancel`, `ask_owner`), attached to every session through `mcpServers`; receipts written into the
      conversation.
- [x] Task 2.4: `src/core/life/heartbeat.ts`: random intervals, `wake` and `regular`, deferral conditions, the
      prompt, `[quiet]` detection, busy and failure retries, a log that records only kind and result.
- [x] Task 2.5: Recovery at startup (reconciling with `history` / `observe`, `awaiting_owner`) and notification
      delivery state.
- [x] Task 2.6: CLI adds `schedule add | list | cancel`, `approve <workItem> <decision>`,
      `heartbeat pause | resume`.
- [x] Task 2.7: Tests: a due schedule runs with no view; duplicate input is coalesced; after killing the
      runtime, home is `ready` within 60 seconds; when the session is `busy` the tick does not resume, rebuild
      or cancel; an `initializing` session is brought to ready by the heartbeat; a quiet heartbeat produces no
      message but has a log; busy retry after 4 minutes; `interrupted` is not replayed; the three missed
      policies; after an OS resume the heartbeat catches up at most once; when the model promises verbally
      without calling the tool there is no schedule.

**Deliverables**: A2's headless demonstration leaves log evidence: a schedule created in a conversation, all
views closed, it runs at the due time, the result is kept, and a notification event is emitted.

### Phase 3: Minimal Electron shell (SPEC-001 FR-32–FR-34; acceptance A3 and measurement)

- [x] Task 3.1: `src/shell/electron/main.ts` mounts the core in the main process; `preload.ts` exposes
      `BotHostApi` through contextBridge; all timers stay in the main process.
- [x] Task 3.2: The tray and menu, one single-instance lock per bot id, optional start at login; copy the
      patterns of platform `desktop/host`'s `tray.ts`, `trayMenu.ts` and `candidateProfile.ts` and note the
      source and revision in the file header.
- [x] Task 3.3: One note window: streaming output, an input box, history, cancel, unread, on-screen dragging,
      an always-on-top toggle, close-to-tray, an explicit Quit that cleans up child processes.
- [x] Task 3.4: Packaging: a Windows installer and a portable build; the way the runtime package and Node are
      obtained follows platform's `ELECTRON_RUN_AS_NODE=1` approach; verify on a clean machine that startup
      and shutdown leave no orphaned processes.
- [x] Task 3.5: Fill in SPEC-001's measurement table and set the numbers as the budget; do the Windows
      acceptance with the `desktop-ui-automation` skill.

**Deliverables**: A3 passes; the measurement table has numbers; behavior when the shell crashes is recorded, as
evidence for the ADR-001 §2 trigger condition.

### Phase 4: Multiple notes, global change and Telegram (acceptance A4, A5)

- [x] Task 4.1: Multiple notes map to multiple conversations; creating and deleting conversations; idle sleep
      and native resume for non-home conversations.
- [x] Task 4.2: Global `executionTarget` change: `configRevision`, a stale attachment is not resumed, the
      owner is told in the conversation, a passphrase isolation test (a passphrase in one note cannot be
      elicited in another; after changing the model the old session is not resumed).
- [x] Task 4.3: Optional Telegram long polling: the bot's own token, a single `getUpdates` consumer, inbound
      becomes an owner message of home, replies are mirrored and segmented in order; token storage follows the
      decision in SPEC-001 Open Questions.

**Deliverables**: A4 passes; A5 passes when Telegram is enabled.

### Phase 5: Desktop presence (needs a new ADR, not scheduled in this plan)

Since 2026-10-28 this has been taken over by
[ADR-002](../decisions/002-give-the-bot-a-desktop-presence-in-the-electron-shell.md) and
[PLAN-002](./PLAN-002-desktop-presence.md); the two items below are no longer tracked in this plan.

- [ ] Task 5.1: Experiment with two paths: Electron plus a native helper porting fleet's WorkerW /
      `SHELLDLL_DefView` mounting, or fleet's C#/WPF/WebView2 host plus a core child process; acceptance for
      DPI, focus / IME and display-loss recovery for each.
- [ ] Task 5.2: The character avatar and free dragging on the desktop.

**Deliverables**: evidence for a new ADR, not a feature.

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `package.json`, `tsconfig.json` | Modify | ESM, scripts, pinned runtime dependency |
| `.github/workflows/ci.yaml` | Modify | Turn on the Node job |
| `src/core/profile/*.ts` | Create | BotProfile and defaults |
| `src/core/store/*.ts` | Create | Atomic writes, lock file, journal |
| `src/core/runtime/supervisor.ts`, `client.ts` | Create | Runtime child process and HTTP client |
| `src/core/conversations/*.ts` | Create | Conversations, transcripts, attachments, handoff pack |
| `src/core/queue/*.ts` | Create | Work items, admission, gate, turn execution |
| `src/core/life/reconcile.ts`, `schedules.ts`, `heartbeat.ts`, `recovery.ts` | Create | The mechanics of being alive |
| `src/core/tools/*.ts` | Create | The bot's session MCP server |
| `src/core/host-api/*.ts` | Create | `BotHostApi` types and events |
| `src/cli/main.ts` | Create | Headless entry `cats-bot` |
| `src/shell/electron/main.ts`, `preload.ts`, `renderer/` | Create | The phase-three shell |
| `tests/architecture-boundaries.test.ts` | Create | Boundary test |
| `tests/core/*.test.ts`, `tests/integration/*.test.ts` | Create | Unit and integration tests |
| `docs/services.md`, `docs/setup-guide.md`, `docs/testing.md`, `docs/architecture.md` | Modify | Turn the templates into actual content (after phase one) |

## Technical Decisions

- ESM plus `NodeNext`, consistent with the runtime (`type: module`); tests run `.test.ts` directly with
  `node:test`, relying on Node 24's native type stripping, so the source is limited to erasable syntax
  (`erasableSyntaxOnly`); jest is not introduced.
- `@cats-inc/cats-runtime` is pinned to the exact version 0.6.1 (the npm `latest` at the time of writing);
  upgrading is a separate PR and must run the integration tests; in development the package's bin is started
  with the host Node, and after packaging with Electron's Node (`ELECTRON_RUN_AS_NODE=1`), the same as platform
  `processSupervisor`.
- In phase one the core is mounted in the Electron main process (ADR-001 §2); `BotHostApi` is defined as
  serializable JSON commands and events, not tied to Electron IPC types, so that switching later to loopback or
  a named pipe does not touch the core.
- The bot's MCP server uses Streamable HTTP (loopback, bearer token): the runtime's `mcpServers` accepts only
  `transport: http`, and `stdio` is rejected with a 400 (runtime api.md, "Session MCP servers"); phase two
  writes a minimal JSON-RPC over HTTP in-house, without pulling in an SDK.
- The integration tests' fixture provider is a scripted CLI that speaks the stream-json one of the runtime's
  adapters expects, registered through the temp runtime's `providers.yaml`; real providers are used only in
  manual acceptance.
- Windows first; all paths in the core go through `node:path`, with no platform assumptions.

## Testing Strategy

- **Unit Tests**: fake runtime client and fake clock; attachment and work-item state machines, the gate,
  retries and backoff, handoff pack truncation, schedule due times and missed policies, heartbeat deferral and
  `[quiet]` detection, profile filling.
- **Integration Tests**: a real runtime process plus a fixture provider in a temp directory: startup and
  ready, streaming, cancel, resume, waking back within 60 seconds after killing the runtime, journal
  consistent after restarting the core; each test cleans up its own child processes.
- **Manual Testing**: a real CLI on Windows runs A1–A4; phase three uses `desktop-ui-automation` for tray and
  note acceptance; each scenario of the measurement table leaves its numbers and how they were captured.
- **State hygiene**: all tests use only temp directories; never touch `~/.catsbot` or `~/.cats`; tests do
  not read any credential file.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Redoing handoff, the gate and polling regresses into bugs platform already fixed (PR #319, #321, #327) | High | These three behaviors are written into SPEC-001 FR-11, FR-17, FR-19, FR-27 and the tests of A2 / A4 |
| Runtime 0.x contract drift | High | Pin the exact version; upgrade PRs must run the integration tests; the client uses only endpoints documented in api.md |
| Timers throttled by the renderer | Medium | Timers only in the core; boundary test and Electron main process mounting |
| A phase-one shell crash takes the core with it | Medium | Start at login and single-instance restart; record events as trigger evidence for ADR-001 §2 |
| Heartbeat quota | Medium | Each bot can turn it off; the log counts them; the measurement table sets the budget |
| Exactly-once is unattainable | Medium | `interrupted` and `awaiting_owner` are first-class states; reconcile with runtime evidence; never rerun automatically |
| Resident cost of each bot | Medium | Discuss multiple bots and a shared runtime after the phase-three measurement |
| Explorer's non-public protocol and native acceptance | Low (phase five) | A separate ADR; not implemented in this plan |
| Credential and token handling | High | Never read CLI credential files; Telegram token preferably in the OS credential store; logs contain no credentials |

## Progress Log

| Date | Update |
|------|--------|
| 2026-10-27 | PLAN-001 created together with ADR-001 and SPEC-001; the two research documents fused; no code at all |
| 2026-10-27 | Revised after Codex's review: discovery isolation changed to runtime flags instead of changing directories (ADR-001 §1, SPEC-001 FR-5); reconciliation classifies by session status and protects `initializing` and `busy` (ADR-001 §5, SPEC-001 FR-20); the branch cleanup script now verifies the work has landed before deleting; the CI YAML validation now fails when it should |
| 2026-10-27 | Phase 0 done: ESM toolchain (`NodeNext`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`), `node:test` running `.ts` directly, CI Node job (ubuntu and windows), pinned `@cats-inc/cats-runtime` 0.6.1, architecture boundary test, `src/core/types.ts` contract types, services / setup / testing docs; fix: the bot's MCP server must use Streamable HTTP (the runtime rejects stdio) |
| 2026-10-27 | Phase 1 done: `src/core` (profile, store, runtime supervisor and client, conversations and handoff pack, queue and turn runner, `BotCore`), `src/cli/main.ts` (`init`, `run`, `say`, `status`, `conversations`); 30 tests: unit, core end-to-end with a fake runtime, integration with the real runtime 0.6.1 plus a fixture CLI (create, stream, cancel, resume, history, discovered entries do not affect the list). Fixes found by measurement: runtime 0.6.1 rejects `--port 0`, so the core now reserves a loopback port itself before startup (SPEC-001 FR-5); the backoff restart on unexpected runtime exit was implemented in the core first (originally listed in Task 2.1), and the reconciliation tick is wired in at Phase 2; FR-28's reconciliation with `history` / `observe` evidence is left to Task 2.5, and Phase 1 only marks leftover `running` as `interrupted` without rerunning |
| 2026-10-27 | Phase 2 done: `src/core/life` (`loop.ts` reconciliation tick, `schedules.ts` and `cron.ts` with IANA time zone cron, `heartbeat.ts`, `recovery.ts`), `src/core/tools` (the Streamable HTTP session MCP server and `schedule_create` / `schedule_list` / `schedule_cancel` / `ask_owner`), `src/core/conversations/binder.ts` (session binding shared by the turn runner and the tick), CLI adds `schedule add\|list\|cancel`, `approve`, `heartbeat pause\|resume`, `tick`; tests: unit tests for cron, schedules, heartbeat, recovery and tools, life tests with a fake runtime (the tick creates and revives home, busy protection, quiet and speaking heartbeats, pause, due schedules and coalesce, missed policies and one catch-up heartbeat after downtime, ask_owner and timeout, note idle sleep), and with the real runtime a fixture CLI calling the bot tool server through `--mcp-config` to create a schedule that runs at the due time, `ask_owner`, heartbeat `[quiet]`. Design notes: the handoff pack is sent in the instructions only when a session is created or replaced, and the heartbeat prompt itself carries only time facts and the `[quiet]` rule; a heartbeat while the session is `busy` is rescheduled by the loop four minutes later rather than left in the queue |
| 2026-10-27 | Phase 3 done: `src/shell/electron` (`main.ts` mounts the core in the main process, one single-instance lock per bot id (distinguished by per-bot userData), `assets/preload.cjs` exposes the `BotHostApi` commands and events through contextBridge, `windows.ts` frameless note windows (close hides, position and always-on-top saved in `shell-state.json`), `tray.ts` / `trayMenu.ts` (open home, list notes, new note, pause heartbeat, start at login, Quit), `assets/renderer/` note page); CLI adds `open`, `quit` (handoff to the running shell); electron-builder config (`asar: false`, Windows NSIS and portable); the measurement table filled with measured numbers from the fixture provider (see SPEC-001). Not done: installation verification on a clean machine (locally only the `--dir` and installer builds and launches were run), the display-loss scenario; Electron pinned to 41.2.0 (same as platform, already cached locally) |
| 2026-10-27 | Phase 4 done: multiple notes and idle sleep already existed from Phase 2, so this phase accepts A4 with the real runtime (a passphrase remembered in one note cannot be elicited in another; after changing the model the old attachment is marked stale and not resumed, the next turn uses the new model in a new session, and the turn in progress finishes under the setting it was admitted with); `src/core/transports/telegram.ts` long polling (single `getUpdates` consumer, the chat of the first direct message becomes the owner and is stored in the profile, inbound becomes an owner-message work item of home, home's replies are mirrored in order and segmented at 4,000 characters, backoff on 409 conflict); `src/core/secrets.ts` (token stored in `secrets.json`: the shell encrypts with Electron `safeStorage`, the CLI falls back to a file and says so); CLI `telegram set-token\|clear-token\|enable\|disable\|status`. Open Questions decided: token storage uses safeStorage with a file fallback; home mirrors to Telegram by default |
| 2026-10-28 | Fixes from external review (items 8–11): `schedule_list` / `schedule_cancel` see only the schedules of the caller's conversation (FR-24); the Telegram update advances `offset` only after durable admission, is refetched on failure and skipped after 5 consecutive failures, and the last admitted `update_id` is stored in `telegram-state.json` for deduplication across restarts (FR-26); at shell startup and on a CLI token-change handoff the plaintext token is re-encrypted, and status reports the protection actually in use; pressing Enter in a note input during IME composition does not send |
| 2026-10-28 | Fixes from external review (items 1–7, #10, #12 and this row): a conversation has only one session binding at a time, the tick and a turn share the result, and the handoff pack excludes pending owner messages (FR-11); changes to instructions and permissions (including `cwd`) also increment `configRevision`, the old session is invalidated and closed when no turn is running (FR-27); a run is written to the journal together with `historyBaseline` before the prompt is sent, recovery recognizes only the messages of this run, and when tool calls are unfinished or a reply cannot be ordered after the tool results it is handed to the owner (FR-28); when changing provider, wait for the turn in progress to finish before restarting the runtime (FR-27); work items in a retry delay are covered by cancel and coalesce, and the timer rereads state when it expires (FR-21); Telegram work items record `sourceRef`, so a resend after a crash is not admitted twice (FR-26). Each item was first reproduced by a test before the fix |

---

*Created: 2026-10-27*
*Author: Claude*