# PLAN-016: Linux dictation pack and dictation language

| Field | Value |
| --- | --- |
| Status | Draft; no slice authorized or started |
| Spec | [SPEC-016](../specs/SPEC-016-linux-dictation-pack-and-dictation-language-in-notes.md) |
| Decision | [ADR-029](../decisions/029-dictate-on-linux-with-the-linux-stt-pack-and-choose-the-dictation-language.md) |
| Platform plan | [PLAN-138](https://github.com/cats-inc/cats-platform/blob/main/docs/plans/PLAN-138-feature-packs-linux-dictation-and-dictation-language.md) |
| Created | 2026-11-16 |

This plan does not authorize implementation, a pin refresh, a version bump or a
release. Each slice starts only after the owner authorizes it and its gate has
passed.

## Gates

The gates follow SPEC-016 FR-A4 and ADR-029 D1.

- **G1 — language slice.** Platform's macOS and Windows helpers have
  `--list-languages` on Platform `main`, and SPEC-146 AC-04 has passed on a real
  Mac.
- **G2 — pack slice.** Platform PLAN-138 has reached milestone M2: Desktop's
  verifier and pack manager accept real `linux-stt` candidates, and Desktop's
  Linux dictation works on the reference board (ADR-029 D1).
- **G3 — release.** The owner has authorized the first `linux-stt` release in
  cats-plugins and a Bot release.

## Slices

0. **Vendor the helpers now (no gate).**
   - Move `native/macos-stt` and `native/windows-stt` under the synchronizer's
     cats-platform group, pinned to the current Platform commit. They are
     byte-identical to Platform's today (SPEC-016 FR-A1).
   - Verify offline that nothing changed (AC-01).
   - The existing helper build and verify scripts still pass (FR-E1).
1. **Language slice, macOS and Windows (after G1).**
   - Refresh the vendored helpers to the Platform commit with `--list-languages`.
   - Add `dictationLanguage` to `hub-state.json`, with the default and
     validation (FR-D3).
   - List languages in the shell with SPEC-146 FR-3 and FR-4's timeout and
     caching, and pass the arguments as SPEC-146 FR-5 says. Notes' locales are
     ignored.
   - Settings: the Voice input group with the language select only (FR-D1, first
     part), the bridge (FR-D4), and strings (FR-D2).
   - Generalize the composer notice action and use it for
     `language_not_supported` (FR-C2, second part).
   - Tests: the AC-05 language parts and the AC-03 notice for
     `language_not_supported`.
   - **Owner:** accept on a real Mac. Windows acceptance waits on Platform's
     SPEC-084 defect (AC-06).
2. **Pack slice (after G2).**
   - **Vendor the manager closure (FR-A1, FR-A2).**
     - If it has relative value imports, port it instead, and record the
       Platform commit in each file.
     - Either way, a test imports it under type stripping (AC-01).
   - **Port the controller and voice types (FR-A3, FR-C5):**
     - the pack helper path;
     - the cap, `limit_warning` and `processing`;
     - Platform's settled timeouts;
     - the language arguments;
     - `pack_required`.
   - **Lock** `assets/feature-packs.lock.json`, empty (FR-B1).
   - **Manager in the shell** at `<bot root>/feature-packs/`, with Electron
     `net` (FR-B2, FR-B3).
   - **Reset:** `feature-packs` stays out of the allowlist, and the Data tab
     lists it among what a reset keeps (FR-B4).
   - **The note:**
     - Linux microphone exposure from the lock, through preload arguments
       (FR-C1);
     - `pack_required` and `unsupported` notices with Open Settings (FR-C2);
     - composer states (FR-C3).
   - **Several notes (FR-C4).**
     - During `processing`, hiding a note does not cancel, and the text goes to
       the hidden note's draft.
     - Another note's start is rejected with `voice_busy` and a notice.
   - **Settings:** the Linux offline speech recognition row in Voice input
     (FR-D1, second part).
   - **Tests** under temporary roots only (FR-B5): AC-02, AC-03, AC-04 and the
     rest of AC-05.
3. **Real pack (after G2, operator on hardware).**
   - **Owner or assigned operator:** live dictation in Bot on Linux x64 and on
     the arm64 reference board, with a candidate pack.
     - The candidate is installed through a development-only lock, or the helper
       override for live checks.
     - Record the results here (AC-06).
4. **Release-bound (after G3).**
   - Copy the released lock fragments into `assets/feature-packs.lock.json` in
     the Bot release-preparation change. They are frozen with the other pins.
   - The same change updates the Bot records SPEC-016 lists:
     - SPEC-003 FR-10;
     - ADR-018 point 3, once ADR-029 is accepted;
     - ADR-024's notice action.
   - The Bot release notes state the new feature and the upgrade boundary. The
     upgrade boundary is additive: a new `feature-packs/` directory and an
     optional `dictationLanguage` field, with no migration.

## Owner actions

These are the owner's to perform, not agent checkboxes:

- Authorize each slice.
- Accept on a real Mac, and on Windows once SPEC-084 is fixed.
- Run the Linux acceptance on the reference board, or assign an operator.
- Authorize the `linux-stt` release and the Bot release.

## Platform follow-up this plan depends on

- **PLAN-138 vendorability.** PLAN-138 asks that the manager's relative imports
  stay inside its file closure. SPEC-016 FR-A2 is stricter: no relative value
  imports at all, only `node:` built-ins and erasable syntax. PLAN-138's wording
  should be tightened so Bot can vendor the closure verbatim, rather than fall
  back to porting.

## Validation

- `npm run typecheck` and the focused `node --test` files for each slice.
- The repository's test command (`npm ci && npm run typecheck && npm test &&
  npm run build`, from AGENTS.md) before handoff.
- The synchronizer's offline check.
- Packaging checks for any slice that touches helpers or `assets/`.

## Progress

| Date | Update |
| --- | --- |
| 2026-11-16 | Plan drafted; no slice started. |
