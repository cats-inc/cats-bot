# PLAN-007: Desktop Experience Parity

## Metadata

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| Status        | Implemented and locally validated      |
| Owner         | Product owner                          |
| Related specs | SPEC-001, SPEC-002, SPEC-003, SPEC-005 |

## Overview

Implement the owner's 2026-10-29 seven-part correction in a dedicated worktree.
Cats Desktop and desktop-work-fleet are design references; Cats Bot stays
independent of the Platform application and its services.

## Implementation phases

- [x] Tray Check for Updates uses a native dialog for results and update actions.
- [x] Display language offers System, English and Traditional Chinese, with
      live updates across settings, conversations and tray.
- [x] Restore avatar position/visibility and each conversation's visibility,
      bounds and layer; explicitly hiding every conversation survives restart.
- [x] Provider-first onboarding runs packaged check/install helpers for only the
      selected provider; Codex checks Node/npm before its own installer.
- [x] Use Runtime's catalog entries and model controls without synthetic default
      rows. Offer Codex, Claude, Antigravity, Grok and Muse, in that order.
- [x] Remove floating-avatar hover tooltips while keeping accessible labels.
- [x] Use Conversation and Direct message consistently on product surfaces.
- [x] Regression tests, complete repository checks, isolated Windows acceptance
      and independent review.

## Compatibility and validation

Retain persisted conversation IDs/roles and legacy IPC routes to avoid breaking
existing data or clients. Presentation names change without rewriting transcripts
or user-assigned titles. New shell language/model-control preferences are optional,
with defaults for older files; no destructive data conversion is intended.
Existing providers outside the picker remain readable/executable, but cannot be
newly selected through the product UI. No version bump or publication is included.

Test windows and provider fixtures use disposable roots, never the installed
profile. Installer tests use check-only or deterministic mocks and do not install
or remove the owner's CLIs. Record native Windows evidence separately from
cross-platform contract tests.

## Validation results

- `npm run typecheck`, `npm test` (217 passed, none skipped), `npm run build`
  and `git diff --check` passed on Windows with Node 24.
- Real pinned Runtime integration verifies a saved Claude effort reaches the CLI,
  including recovery from a stale catalog revision. Catalog tests cover local
  overrides, per-entry controls and preservation of older targets.
- Two separate Electron processes with disposable roots passed provider-first
  onboarding, the Codex prerequisite sequence, live English/Traditional Chinese
  switching, exact model/effort choices, unrelated saves of legacy targets and
  absence of avatar tooltips. Restart preserves an all-hidden state, then restores
  mixed conversation bounds/layers and avatar position at 150% Windows scaling.
  Desktop and wallpaper windows are asserted attached to Explorer's corresponding
  native hosts, in addition to checking their saved preferences.
- The localized tray update dialog was observed through native Windows UI
  Automation and a window capture, then closed; Settings was not opened. Existing
  renderer acceptance also passed failure/retry, download progress, reload and
  cancelled/confirmed fixture installation.
- A real Node/npm helper check completed without installation. Installer writes
  use deterministic fixtures. Native installation and desktop UI acceptance on
  macOS/Linux have not been run locally; CI covers their contracts and packaging.
- Independent review completed with no remaining blocking findings after fixes;
  the reviewer also ran 35 focused tests. Private native evidence remains under
  ignored `tmp/`, not in the repository history.

## Progress log

| Date       | Update                                                                               |
| ---------- | ------------------------------------------------------------------------------------ |
| 2026-10-29 | Scope accepted by the owner's implementation request; worktree created from 01b7cfc. |
| 2026-10-29 | Implemented all seven corrections, documented ADR-006, and completed regression, isolated Windows acceptance and independent review. |
| 2026-11-01 | Ported cats-platform #364 (21bb92b2): the macOS tray update dialog no longer opens as a sheet on a centered 1x1 owner, which hung it from the screen's vertical middle. A transient window activates Cats Bot and is destroyed before the parentless alert opens at the native position; a quit during the wait returns the dismissal. Build and unit tests only; native macOS acceptance has not been run. |
