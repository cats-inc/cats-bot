# PLAN-005: Standard Preview Releases and Updates

## Metadata

| Field | Value |
| --- | --- |
| Status | In progress |
| Owner | Bot Electron host and release pipeline |
| Spec | [SPEC-005](../specs/SPEC-005-standard-preview-releases-and-updates.md) |

## Slices

- [x] P1: immutable release inputs, platform packaging, Standard signing,
  workflow_dispatch draft/build/validate/publish pipeline and release SOP.
- [x] P2: host-owned updater, distribution capabilities, installation exclusion,
  explicit download/install, drain and failure recovery.
- [ ] P3: Settings/tray/preload wiring, focused and CI tests, isolated Windows
  renderer/package acceptance and independent review.

## Validation and release boundary

Use temporary state only. No real profile or installed application is replaced.
Keep source, CI package, native UI and installed upgrade evidence distinct. The
existing schema-2 migration requires the next authorized release to be at least
0.2.0; this task does not change version fields or dispatch publication.

## Progress

- 2026-10-28: Started from Bot `926c845`. Owner selected all three desktop OSes.
  Bot repository is public; no repository-level signing secrets were listed.
  Existing protected Runtime pin is `e38e56bfd54fe783df22a5e0d914b14d186ee6bf`.
  Desktop updater/signing behavior and electron-builder v26 documentation were
  checked; implementation and acceptance follow below.
- Local validation: typecheck, build and 148 tests pass. Isolated Windows
  unpacked packaging and real Electron renderer/preload checks pass (check
  failure/retry, download/progress, reload and install cancellation/confirmation
  using a fixture installer). Independent review ran 44 tests and reproduced
  native cache recovery using pinned electron-updater; no open blockers.
- Review corrections include monotonic release serialization, explicit Windows
  architecture installers, non-Windows Koffi exclusion, Runtime startup/stop
  fencing, persistent installation recovery and trusted SHA512 cache revalidation
  before draining the Bot. Three-OS CI packaging remains the merge gate.
