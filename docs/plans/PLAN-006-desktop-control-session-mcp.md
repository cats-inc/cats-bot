# PLAN-006: Desktop Control Session MCP

## Metadata

| Field | Value |
| --- | --- |
| Status | Phase A delivered and recorded (P0–P4); phase B (P5): helper, server, hold state and indicator in review, native acceptance (B7) pending |
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

- [x] Note: conversation switch, grant prompts, the control banner with "Stop". A strip under
  the header appears while the profile switch is on, or while the conversation has grants or
  waiting requests; it holds the conversation switch, the DC-18 status with its reason, the
  granted apps and Stop whenever there are grants or waiting requests (phase A has no hold).
  Grant cards sit beside the provider requests with the app, its path, its publisher or
  "unsigned", the observe-only limit and the bot's reason; Allow and Deny call only
  `respondDesktopGrant`. Settings > Bot gains the profile switch, hidden off Windows and
  disabled with the reason where the helper cannot run, but always switchable off.
- [x] Tray: control state and stop. "Desktop control requests (N)" opens the note that waits,
  "Stop desktop control" stops every conversation while the profile switch is on, the tooltip
  says when desktop control is on or a request waits, and a new request in an unfocused note
  shows a bubble that names no app.
- [x] CLI: grant answers, stop, and the new capability entry in `cats-bot capabilities`.
  `cats-bot desktop <conversation>` prints the state as JSON; `--enable`/`--disable`,
  `--grant <requestId> allow|deny` and `--stop` (`--all` for every conversation) go through
  the running Bot's control endpoint. `cats-bot capabilities` already prints P2's
  `desktopControl` entry.

**Exit:** renderer and CLI tests pass, and an isolated shell smoke test passes.

P3 record (2026-10-29): host commands and control endpoint operations carry the four
`BotHostApi` methods; a note acts only on its own conversation, and Settings reads only the
profile-level state, so Settings, the floating cat and the provider path cannot answer a
grant. `tests/shell/desktopControlIpc.test.ts` covers argument checks and which window may
send each command; `tests/shell/trayMenu.test.ts` the tray items; `tests/renderer/desktopControl.test.ts`
the note and Settings wording and visibility rules; `tests/core/desktopControlCore.test.ts` runs
`cats-bot desktop` as a child process against a running core with the fake helper (state,
switch, grant, unknown request, usage errors, `--stop --all`, the stopped-Bot path) and checks
that `respond` cannot answer a grant. The isolated shell smoke test started the unpackaged
shell with a temporary `CATS_BOTS_HOME` and `userData`, the scripted fixture CLI and no helper
build, so the real helper could not start, and drove the note and settings pages only through
the DevTools protocol: 20 of 20 checks passed (Settings shows the switch disabled with
`helper_missing`, the note shows the unavailable reason once the profile switch is on, the
window rules hold, `cats-bot desktop` and `capabilities` read the running shell, a turn still
completes, and `cats-bot quit` ends the shell). Grant cards and Stop were therefore not seen
in the real shell; their rendering is part of P4. The tray menu was checked only through its
builder. The repository has no localization, so the strings are English only.
`npm run typecheck`, `npm test` (186 tests) and `npm run build` pass on Windows.

### P4 — Phase A native acceptance

- [x] Run B1–B6 and B8 on a real Windows machine with a real Claude Code, in a test Bot with
  an isolated data root. See the record below.
- [x] Record the Defender result, redacted samples and any items that did not pass.

**Exit:** the owner confirms phase A and authorizes phase B.

P4 record (2026-10-29, Windows 11, Claude Code 2.1.312 `haiku` with the owner's own sign-in):

- **Setup**:
  - A test Bot was created with `cats-bot init` under a temporary `CATS_BOTS_HOME`.
  - Its profile was edited to set an explicit full-access/network/`on-request` `providerPolicy` and `desktopControl.enabled`, since no CLI path changes the profile switch.
  - `cats-bot run` started it with its own private Runtime, and the P3 build's helper ran against two throwaway windows.
  - A script acted as the owner only through the CLI: `respond` with "Allow once", and `desktop --grant ... allow`.
- **Results**: 12/12 checks passed.
  - B2: `desktop home --enable` turned the conversation on. Each of the 4 desktop tool calls in the owner turn produced a `tool_approval` naming server `cats-desktop`. A scheduled turn got `not_owner_present`.
  - B3: the app grant came only through `desktop --grant`.
  - Phase A tools: the reply named the blue background, "Probe button" and "visible text", and reported the masked field's value as null. The password never reached the model.
  - B8: the transcript kept 5 tool-result summaries and no screenshot bytes.
  - BDC-13: `capabilities` carried `desktopControl` with status `injected`.
  - B5: `desktop --stop` cleared the grants, and the next owner turn got `stopped`. `quit` revoked the conversation and the Runtime exited cleanly.
  - Defender recorded no detection.
- **Not exercised natively**:
  - B1 off Windows.
  - B6, the global gate while a grant waits (covered by core tests).
  - The lock pause.
  - The note and tray UI with a live helper (P3's shell smoke ran without one).
  - A packaged installer's helper and Codex.

### P5 — Phase B (act)

- [x] Add the input ops and tools from SPEC-133 R5 to the helper and the server. The helper's
  sources now match Platform's phase B helper (cats-platform#341): `Input.cs`, `Clipboard.cs`,
  the `Native.cs`, `Uia.cs` and `Program.cs` changes, and `native-check/input-check.mjs` with its
  probe app. The README and both native checks keep the Bot's own wording. The server adds
  `click`, `invoke_element`, `type_text`, `key`, `scroll`, `clipboard_read` and `clipboard_write`
  with SPEC-133's schemas, key allowlist and "Phase B server rules". Helper codes that are tool
  codes reach the model unchanged.
- [x] Hold state, operator-active pause and the control banner during input. The first input
  tool of an owner turn holds control until the core finishes that work item. Stop from the
  note's banner, the tray or `cats-bot desktop --stop` revokes grants and releases control, and
  sends the helper `cancel` only for a conversation that held control. The tray's first item
  and tooltip and a banner in the note name the held app. See SPEC-006 "P5 Implementation
  Details".
- [ ] Guard fixtures and native acceptance against a throwaway test window (B7).

**Exit:** B7 passes and is recorded; anything that did not pass is stated as such.

P5 record (2026-10-29, fixtures only):

- **Helper**: `dotnet build -c Release` of the helper and of the probe app reported 0 warnings and
  0 errors. Neither native check ran, so no input was sent to a real desktop.
- **Service tests** in `tests/core/desktopControl.test.ts` (14 tests) port Platform's two phase B
  scenarios to a fake helper:
  - Coordinates convert with the capture-time bounds; points outside the image, unknown
    snapshots and snapshots older than 60 seconds give `stale_snapshot`.
  - Element ids map to the helper's `readId`, and an unknown prefix gives `window_changed`.
  - An observe-only app gives `observe_only`. `operator_active`, `locked` and a turn that is not
    the owner's send nothing to the helper.
  - `password_field` and `covered` from the helper reach the model unchanged.
  - The clipboard round-trips without reaching state or logs. The parsers use the shared
    argument error wording.
  - Holding starts with the first input tool and ends with that work item; the clipboard holds
    nothing.
  - Stop sends `cancel` only for a conversation that held control and cuts typing in progress.
    Later calls return `stopped`. A turn that ends while its typing still runs, and turning the
    conversation off while it holds control, also cancel.
- **Core tests** in `tests/core/desktopControlCore.test.ts` (9 tests): a real work item holds
  control (`holding` in the capability entry, the state and the events) and releases it when
  it ends. `cats-bot desktop home --stop` during a held turn cancels the helper op and revokes
  the grant. B8 now also covers typed and clipboard text in tool inputs and results.
- **UI tests**: `tests/renderer/desktopControl.test.ts` (6 tests) covers the note's banner and
  Stop; `tests/shell/trayMenu.test.ts` (6 tests) covers the tray's first Stop item, the app
  name and the tooltip.
- **Full checks**: `npm run typecheck`, `npm test` (191 of 191) and `npm run build` pass on
  Windows. The repository has no lint script.

## Validation

Use temporary state only; no real profile or installed application is changed. Record the
checks each slice actually ran. Native, packaged and fixture evidence prove different things,
so report them separately.

*Created: 2026-10-29. Planned; implementation not authorized.*
