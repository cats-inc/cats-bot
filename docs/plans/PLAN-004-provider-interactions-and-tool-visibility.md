# PLAN-004: Provider Interactions and Tool Visibility

## Metadata

| Field | Value |
| --- | --- |
| Status | Codex and Claude Code done; successful Chrome/desktop operation not yet verified |
| Owner | Bot core, CLI, Electron shell |
| Assigned To | Unassigned |
| Reviewer | Product owner, Runtime maintainers |
| Related spec | [SPEC-004](../specs/SPEC-004-provider-interactions-and-tool-visibility.md) |

## Overview

After the owner authorized automatic merging of documentation PRs on 2026-10-28, the latest code was
pulled, sliced and implemented, with commits made along the way. This authorization does not include
version publishing. It follows PLAN-001's headless-first order: first prove that the core can answer,
then connect the note/tray. Runtime PLAN-049 is a shared prerequisite, and Platform PLAN-124 is not an
execution dependency of the Bot.

## Implementation Phases

### P0 — Contract, compatibility and data upgrade design

- [x] Align with Runtime P0's interaction, reply, policy and inventory fixtures and the versioned
  capability.
- [x] Clearly distinguish ask_owner, recovery rerun and provider interaction; define the configRevision
  boundary, the turn gate that is still held while waiting, the reply control path and the restart
  decision.
- [x] Design the minimal new profile/journal data and the protected upgrade; define the semantics of
  old CLI commands.

**Exit:** The supported Runtime identity and protocol are fixed, and old data is not widened by new
permission options.

### P1 — Headless core and CLI

- [x] Consume Runtime P1/P2, verified with the exact package/candidate artifact, with no source import
  from the sibling repo.
- [x] Add the core interaction registry, journal projection, snapshot/event reconciliation and
  BotHostApi.
- [x] The CLI adds listing and typed response operations; sensitive answers are sent through
  stdin/controlled input.
- [x] Keep the global gate, with replies going through the control path; integrate waiting, deadline,
  provider resolve and cancel.

**Exit:** Integration tests without Electron/Platform pass A1/A2; a native question is not turned into
a re-run of the prompt.

### P2 — Life loop, recovery and retarget

- [x] Make reconcile/heartbeat/scheduler recognize a pending interaction and protect the busy worker.
- [x] Verify core/Runtime/worker restart, retarget, conversation deletion, quit and the reply race.
- [x] Pass the tests for journal/profile upgrade validation, backup, atomic replacement and failure
  recovery.
- [x] Regress ask_owner, approval of an interrupted retry, multi-note isolation and non-overlapping
  ticks.

**Exit:** The core part of A3–A5/A7 passes; there is no deadlock caused by waiting, no automatic rerun
and no privilege widening.

### P3 — Note/tray and settings diagnostics

- [x] The note adds question/approval/form/URL-flow cards with a source, and an invalidated state.
- [x] The tray/floating Cat can locate the pending conversation; notifications are deduplicated, and
  the unread count and the pending-reply count are kept apart.
- [x] Consume Runtime P3; settings and the CLI show the effective permissions, tool sources and partial
  inventories; when the helper has no direct evidence, unknown is shown.
- [x] The shell goes through BotHostApi throughout; Telegram only notifies in this phase and does not
  treat ordinary text as a native reply.

**Exit:** Closing/rebuilding the renderer does not affect the core's live request; sensitive input is
not left in history.

### P4 — Native and packaging acceptance

- [x] Run the affected core/integration/architecture-boundary tests, typecheck and build.
- [x] Complete the fixture acceptance of A1–A5/A7 with a temporary Bot data root; the real `~/.cats` is
  neither read nor written.
- [ ] After matching the Terminal's CLI/account/config/cwd/trust/policy/helper conditions, compare the
  tool sources, and separately verify controlled Chrome navigation/reading and a harmless desktop
  operation in a test window.
- [x] Record the actual failure and the configuration direction when the helper is currently
  unavailable; recovery after restarting the helper is still unverified.
- [x] Build the Windows unpacked candidate with the exact Runtime pin; the UI acceptance of b75da37b
  and the repackaging/headless integration of 50ef02b4 are recorded separately, and macOS/Linux stay
  pending verification because they are not verified.

**Exit:** There is Bot operation evidence independent of Platform. Publishing, versions and installing
into the user's existing profile are not authorized automatically by any step of this document.

### P5 — Claude Code (SPEC-004 B8, Runtime PLAN-050)

- [x] Pin a packed artifact containing Runtime PLAN-050 P1/P2, and add `tool_approval` and the built-in
  tool inventory.
- [x] A per-bot switch for Claude in Chrome (`--chrome`), and the explanation of Claude's policy ceiling
  and the check before saving.
- [x] A scripted Claude CLI completes a question, a Chrome tool approval, an MCP form and inventory
  observation through the packed Runtime.
- [x] Run the real Claude CLI once through the Runtime and a new test Bot; actual Chrome operation is
  accepted separately after the owner agrees.

**Exit:** The Claude bot and the Codex bot take the same interaction path; a ceiling that cannot be
run is rejected before saving or creating a session.

## Files to Create/Modify

| Area | Intended change |
| --- | --- |
| `src/core/runtime/client.ts`, `src/core/conversations/binder.ts` | Negotiation, reply, inventory and policy |
| `src/core/bot.ts`, `src/core/queue`, `src/core/life` | Waiting, gate, tick, retarget and recovery |
| `src/core/store`, `src/core/profile` | Necessary de-sensitized state and protected upgrade |
| `src/core/host-api`, `src/cli/main.ts`, `src/shell` | Shared API, CLI and shell presentation |
| `tests/integration`, core tests | Scripted provider requests and lifecycle regression |

## Testing Strategy and Risks

First use a fake Runtime/clock, then a real managed Runtime with a scripted provider to test
request/reply, and only last the isolated native operation acceptance. The key points are that a reply
inside the gate does not deadlock, that waiting is not reclaimed by a tick, that an old request cannot
take effect on a new worker, and that it is not confused with the existing ask_owner semantics.
Tests use only temporary state and clean up the processes/windows they created; the user's bot is not
used as a test fixture.
The original documentation PR did not run a model; the fixtures, candidates and real-model tool calls
of the implementation phase are in the records below.

## Progress Log

| Date | Update |
| --- | --- |
| 2026-10-28 | Draft created from Bots `7951c28` and the state of Runtime 0.6.1; P0–P4 not started, package/profile unchanged. |
| 2026-10-28 | The renderer work `6598b9c` merged at the same time already uses SPEC-003/PLAN-003; this work is numbered SPEC-004/PLAN-004. That renderer baseline is integrated before implementation. |
| 2026-10-28 | P0–P2 headless slice: exact pin of the Runtime b75da37b candidate (unpublished), CLI stdin/local pipe control, same-turn reply, global gate, de-sensitized receipts, schema 1→2 backup under lock and atomic upgrade, policy negotiation and session inventory. 49 affected core/life/shell/boundary tests and build/typecheck pass; packed Runtime + scripted Codex native input integration passes. The snapshot race, empty allowlist, upgrade single-writer, unknown backup and failure cleanup gaps found by independent review are fixed and re-verified. Real Chrome/desktop operation and renderer/packaged candidate acceptance remain to be done. The formal release of schema 2 needs the next Bot minor 0.2; this work does not bump or publish. |
| 2026-10-28 | P3 slice: six kinds of native interaction on the note, controlled URLs, tray locating and de-sensitized notifications; the settings page separates policy from legacy controls and shows the session inventory. The independent UI/IPC review has converged; 9 focused tests and typecheck/build pass. The isolated Electron and the Windows unpacked candidate (Runtime b75da37b) completed renderer reload → same-turn reply; a long history plus 4 terminal receipts still locates the new request, and replies with an empty string for required, an empty array, and an empty optional enum succeed. Real Chrome/desktop tool operation, macOS/Linux or a release are not claimed to pass. |
| 2026-10-28 | P4 native comparison: Codex 0.164.0, the same Windows user/config/test cwd, explicit workspace-write/offline/on-request/reviewer=user. The real Bot core (Runtime b75da37b) and the Terminal both actually called Chrome to create a tab and got Browser is not available: chrome; the native listing of the controlled WinForms target got missing native pipe (OS error 2) in both, and no tab or button operation succeeded. The Bot's policy is verified, and configured MCP is 279/3/4, plus 4 tools injected by the Bot. The tool call path is connected; the successful operation of A6 and helper recovery remain to be accepted once the environment is available. |
| 2026-10-28 | Follow-up slice: pin Runtime 50ef02b4686c1fff6b60819d292acc5b2e1ef773, fixing the misidentification of an old Codex thread with the same cwd and the deletion of the transcript on a failed admission; the exact tgz digest is in vendor/README. Integer forms convert fractional bounds with ceil/floor, and 4 actual DOM validity cases were checked independently. 12 focused tests on the new pin (including the real packed Runtime + scripted provider) and typecheck/build pass, and the Electron 41.2.0 Windows unpacked build was rebuilt and checked to contain the fixed Runtime. Native tool success is not claimed again, and nothing was published. |
| 2026-10-28 | P5 Claude Code slice: pin Runtime `e38e56bfd54fe783df22a5e0d914b14d186ee6bf` (PLAN-050 P1/P2, unpublished), adding `tool_approval`, the Claude in Chrome switch, the pre-save check and explanation of Claude's policy ceiling, and the built-in tool inventory. The scripted Claude CLI adds initialize/mcp_status/AskUserQuestion/Chrome tool approval/MCP form; the packed Runtime integration tests pass, and the Codex integration tests still pass. The full `npm test` 128/128, typecheck and build pass. Acceptance of the real Claude CLI through the Bot remains to be done. |
| 2026-10-28 | P5 real acceptance: Claude Code 2.1.312 (haiku), through the packed Runtime `e38e56bf` and a brand-new isolated test Bot (real user login, scratch cwd, explicit full-access/network/on-request, Claude in Chrome on), completed four turns in 23 seconds: a question (`user_input`, answered Blue), Write (`file_approval`, showing only the path and size, file written), the Bot's own `schedule_list` (`tool_approval`, server `cats-bot`), and a refused shell redirect (`command_approval`, file not created). Policy `verified` (reported `default`, reviewer `user`); saving workspace-write was rejected. Inventory: `cats-bot` injected, 22 `claude-in-chrome` tools, 7 claude.ai connectors, 34 built-in; browser `unknown`, computer use `unavailable`. Not tested: real Chrome browser operation (no browser was opened), a real MCP form/URL (only scripted and direct CLI probing), and the on-screen look of the `tool_approval` card on the note (it reuses the generic card). |
| 2026-10-29 | Note fix: the installed 0.2.2 note kept the last 4 terminal receipts as full cards after the transcript. Redacted, each said only "resolved · provider resolved" (about 170 px in a 460 px note), and they buried the latest reply. The note now shows only pending and responding requests; terminal receipts remain in the core and `cats-bot interactions`. A tool name that is a whole command line (Codex) is cut with an ellipsis instead of widening the transcript to 2377 px. |

*Created / last updated: 2026-10-29*
