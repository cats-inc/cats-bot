# PLAN-006: Desktop Control Session MCP

## Metadata

| Field | Value |
| --- | --- |
| Status | In progress; P0 complete, P1 and P2 in review, P3–P4 authorized, P5 needs owner sign-off after P4 |
| Owner | Bot core, headless CLI, Electron shell |
| Spec | [SPEC-006](../specs/SPEC-006-desktop-control-session-mcp.md) |
| Decision | [ADR-005](../decisions/005-give-the-bot-owner-consented-desktop-control.md) |
| Counterpart | [Platform PLAN-126](../../../cats-platform/docs/plans/PLAN-126-desktop-control-session-mcp.md) |

## Overview

Deliver phase A (observe) first; phase B (act) starts only after native acceptance passes
and the owner confirms it. Reuse the `cats-bot` server pattern, SPEC-004's interaction and
capability plumbing, the global gate and ADR-004's packaging and signing. Nothing is
imported from Platform; the shared behavior comes from Platform SPEC-133's
cross-implementation contract. This plan includes no version bump or release.

## Slices

### P0 — Contract and profile

- [x] Freeze SPEC-133's cross-implementation contract together with Platform PLAN-126 P0,
  and record which version this plan follows (2026-10-29).
- [x] Decide the profile field for BDC-02, whether it needs a schema change, and the
  protected upgrade path if it does (no change; see SPEC-006 "P0 Decisions").
- [x] Confirm which Runtime capability snapshot fields decide BDC-04 for Claude Code and
  Codex.
- [x] Define the grant request snapshot and response in `BotHostApi` and the CLI commands
  for grants and stop.

**Exit:** contract version, profile decision and host API shapes have fixtures, and the
owner confirms.

P0 record (2026-10-29): the owner authorized continuous slices through every phase that does
not need them, which covers this exit's confirmation. Fixtures land with the code in P1 and P2.

### P1 — Helper (observe)

- [x] Create `native/windows-desktop-control/` with the observation ops (`hello`,
  `resolve_apps`, `list_windows`, `capture_window`, `read_ui`, `open_app`, `state` and
  `cancel`), the SPEC-133 exclusion lists, per-monitor DPI awareness v2 and lock detection.
  The sources are the Bot's own copy of the Platform helper with the same protocol, behavior
  and lists; nothing is built or loaded from Platform. BDC-08 adds no list entries: the
  Bot's own processes and executables, and Cats Desktop's, reach the helper through `hello`
  at runtime, which the P2 supervisor supplies. UIPI only blocks input, so the
  `elevated_target` check moves to P5 with the input ops.
- [x] Package it as a Windows-only electron-builder extra resource.
  `scripts/windows-desktop-control.mjs` publishes it self-contained per architecture into
  `build/native-windows/<arch>/` and stages the .NET runtime's license texts beside it;
  `dist:win`, `dist:dir` and `build-preview.mjs` publish it before electron-builder and read
  the package back (helper present, same PE architecture as `Cats Bot.exe`, notices complete).
  macOS and Linux packaging never run dotnet. electron-builder signs the helper with the app
  when Windows credentials exist (ADR-004), and signed releases check its Authenticode
  signature; no signed build has run yet.
- [x] Helper tests, including the covering-window capture check (B4).

**Exit:** the helper alone passes B4 on Windows.

P1 record (2026-10-29): `dotnet build -c Release` reported 0 warnings and 0 errors.
`native-check/check.mjs` passed 13/13 on Windows 11, against the Release build and again
against the helper inside a packaged x64 `--dir` candidate: the overlap of a red covering
window contained 0 red pixels (B4), password values were absent, the localized name 記事本
resolved to the packaged Notepad, and PowerShell resolved as observe only.
`tests/shell/windowsDesktopControl.test.ts` covers publishing, notice staging, the packaged
architecture check, the non-Windows path and the frozen exclusion lists without running dotnet.
arm64 publishing and the installer targets run only in CI and release builds.

### P2 — Bot core

- [x] Profile and conversation switches (BDC-02, BDC-03): `desktopControl: { enabled }`
  in profile schema 2, off when absent or invalid, changed through `updateProfile` without
  a configuration revision; `desktop-control.json` holds the conversation switches.
- [x] Helper supervision: lazy start, idle exit and crash restart limit, plus a failed
  handshake that keeps the helper unavailable until the feature is turned off and on.
  The Electron shell passes the packaged helper path; a checkout uses its Release build.
- [x] The `cats-desktop` server beside `cats-bot` (BDC-06) and its injection and turn
  decisions (BDC-04, BDC-05). The descriptor is decided before every send and travels in
  the send's `mcpServers`, because a session has no capability snapshot before it exists.
- [x] Grant requests through `BotHostApi`, the in-memory grant table and the global gate
  (BDC-07, BDC-09).
- [x] Redaction in the journal, receipts, logs and Telegram notices (BDC-12) and the
  capability entry (BDC-13). The transcript keeps a summary instead of a desktop tool's
  result, since Runtime reports Claude Code's tool results with the image data.
- [x] Core tests with a fake helper for B1–B3, B6 and B8.

**Exit:** core tests pass.

P2 record (2026-10-29): `tests/core/desktopControl.test.ts` ports Platform's
desktop-control scenarios to the Bot's own code with a fake helper: the DC-04 gate, the
descriptor and owner-present rules, grants that join, expire after their TTL and stop at five
per conversation, the five tools, stop (including a helper answer that arrives after it),
lock, off and unavailable states, the crash limit, the handshake failure and the switch
store. `tests/core/desktopControlCore.test.ts` runs a `BotCore` on a scripted in-process
Runtime client: B1 (off by default; unavailable on macOS, Linux, without the helper and after
a failed handshake), B2 (only owner messages with source `owner` are served; Telegram,
heartbeat, schedule and recovery reruns get `not_owner_present`; the descriptor is identical
on every send and dropped when the policy pre-approves tools), B3 (grants only through
`respondDesktopGrant`, cleared by stop, both switches and a core restart; the Bot and Cats
Desktop are refused), B6 (a waiting grant holds heartbeats and schedules, owner messages still
run, held work resumes after the answer) and B8 (no screenshot bytes, UI values, window
titles or bearer tokens in the transcript, turn events, journal, logs or Telegram notice).
Mutating the owner-present rule, the gate or the transcript redaction fails these tests.
P2 also fixed a receipt store defect found on the way: a `tool_approval` receipt made the
store unreadable, so the Bot could not reopen after any Claude Code tool approval, which
every desktop tool call produces. `npm run typecheck`, `npm test` (176 tests, including the
integration tests on the pinned Runtime) and `npm run build` pass on Windows. No real helper,
provider CLI or desktop was used; the real-desktop checks are P4.

### P3 — Note, tray and CLI

- [ ] Note: conversation switch, grant prompts, the control banner with "Stop".
- [ ] Tray: control state and stop.
- [ ] CLI: grant answers, stop, and the new capability entry in `cats-bot capabilities`.

**Exit:** renderer and CLI tests pass, and an isolated shell smoke test passes.

### P4 — Phase A native acceptance

- [ ] Run B1–B6 and B8 on a real Windows machine with a real Claude Code, in a test Bot with
  an isolated data root.
- [ ] Record the Defender result, redacted samples and any items that did not pass.

**Exit:** the owner confirms phase A and authorizes phase B.

### P5 — Phase B (act)

- [ ] Add the input ops and tools from SPEC-133 R5 to the helper and the server.
- [ ] Hold state, operator-active pause and the control banner during input.
- [ ] Guard fixtures and native acceptance against a throwaway test window (B7).

**Exit:** B7 passes and is recorded; anything that did not pass is stated as such.

## Validation

Use temporary state only; no real profile or installed application is changed. Record the
checks each slice actually ran. Native, packaged and fixture evidence prove different things,
so report them separately.

*Created: 2026-10-29. Planned; implementation not authorized.*
