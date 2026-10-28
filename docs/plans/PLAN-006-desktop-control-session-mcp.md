# PLAN-006: Desktop Control Session MCP

## Metadata

| Field | Value |
| --- | --- |
| Status | Planned; implementation not authorized |
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

- [ ] Freeze SPEC-133's cross-implementation contract together with Platform PLAN-126 P0,
  and record which version this plan follows.
- [ ] Decide the profile field for BDC-02, whether it needs a schema change, and the
  protected upgrade path if it does.
- [ ] Confirm which Runtime capability snapshot fields decide BDC-04 for Claude Code and
  Codex.
- [ ] Define the grant request snapshot and response in `BotHostApi` and the CLI commands
  for grants and stop.

**Exit:** contract version, profile decision and host API shapes have fixtures, and the
owner confirms.

### P1 — Helper (observe)

- [ ] Create `native/windows-desktop-control/` with the observation ops, exclusions
  (including BDC-08), UIPI checks, per-monitor DPI awareness v2 and lock detection.
- [ ] Package it as a Windows-only electron-builder extra resource and sign it under
  ADR-004.
- [ ] Helper tests, including the covering-window capture check (B4).

**Exit:** the helper alone passes B4 on Windows.

### P2 — Bot core

- [ ] Profile and conversation switches (BDC-02, BDC-03).
- [ ] Helper supervision: lazy start, idle exit and crash restart limit.
- [ ] The `cats-desktop` server beside `cats-bot` (BDC-06) and its injection and turn
  decisions (BDC-04, BDC-05).
- [ ] Grant requests through `BotHostApi`, the in-memory grant table and the global gate
  (BDC-07, BDC-09).
- [ ] Redaction in the journal, receipts, logs and Telegram notices (BDC-12) and the
  capability entry (BDC-13).
- [ ] Core tests with a fake helper for B1–B3, B6 and B8.

**Exit:** core tests pass.

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
