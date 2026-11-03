# PLAN-011: Setup Wizard

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Implemented; clean-machine acceptance pending |
| **Owner** | Product owner |
| **Assigned To** | Claude |
| **Reviewer** | Independent agent before each merge |

## Related Spec

[SPEC-010: Setup Wizard](../specs/SPEC-010-setup-wizard.md), under
[ADR-015](../decisions/015-make-creating-a-cat-bot-a-wizard-whose-scripts-the-owner-ticks.md).

## Overview

The owner reviewed an interactive mock through three rounds on 2026-11-04 and approved it.
Each phase is one PR with auto-merge, and the app works between them: the old page keeps
running on the new backend until Phase 3 replaces it.

## Implementation Phases

### Phase 1: The text rule

**Goal:** a name and a persona follow one rule everywhere (SPEC-010 FR-19, FR-20).

- [x] `src/shared/botText.ts` with the rule, its messages and their translations.
- [x] Enforce it in `validateSetupInput`, `createProfile`, `applyProfilePatch` and the Boss
      Cat tool. Keep unchanged stored values working.
- [x] Make profile text one line in the heartbeat prompt.
- [x] Show the problem in the Bot tab and block saving.

### Phase 2: The setup backend

**Goal:** the page's new contract, with the old page still working (FR-6 to FR-15, FR-17,
FR-22).

- [x] `setup:providers` returns the fixed list with no PATH scan.
- [x] Reading order, row order, the optional step and its removal from `canFinish` and from
      install prerequisites.
- [x] Steps carry the plan, applied changes, script identity and sign-in state.
- [x] Log events for each run, sent to the asking window and to the hub's diagnostics.
- [x] `setup:cancel`, `setup:openTerminal`, `setup:environment`, `setup:restart`, `setup:draft`.
- [x] `startAtLogin` in `SetupInput`; the window's size and minimum.

### Phase 3: The wizard

**Goal:** the three pages and the log (FR-1 to FR-5, FR-8 to FR-18, FR-21).

- [x] `src/renderer/settings/setup/`, replacing `SetupPage.tsx`, with its strings translated.
- [x] `ModelField` follows Cats Chat (FR-16).
- [x] The Bot tab checks only when asked (FR-21).
- [x] The color tokens from the mock, in `settings.css`.
- [x] `scripts/test-setup-wizard-renderer.mjs`: hidden, isolated, with fake helpers. Update
      `scripts/test-desktop-parity.mjs`.

### Phase 4: Acceptance and documents

**Goal:** what can be shown on real machines, and documents that match.

- [x] Drive the real main process, preload and helpers in an isolated `CATS_BOT_HOME`, on the
      read-only path. No script that changes this machine runs.
- [x] `docs/setup-guide.md`, `docs/testing.md`, and the pending notes in SPEC-002, SPEC-008,
      SPEC-009 and ADR-006.
- [ ] Still needs a person or a clean machine. None of this has been run:
  - installs through the wizard on a clean Windows 11 VM, including declining UAC;
  - first runs on macOS and Linux, which have no clean-machine acceptance on record;
  - opening a real terminal on each OS, and signing in through it;
  - start at login left unticked on an installed copy;
  - restarting Cats Bot from the wizard, on an installed copy.

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/shared/botText.ts` | Create | The FR-19 rule |
| `src/shared/providerSetup.ts` | Modify | Step and log contracts |
| `src/renderer/settings/setup/setupFacts.ts` | Create | Summary, tags and manual command per step and OS |
| `src/shared/language.ts` | Modify | New strings; drop the catalog label's translation |
| `src/core/profile/profile.ts` | Modify | Enforce the rule on new or changed values |
| `src/core/life/heartbeat.ts` | Modify | One-line profile text in the prompt |
| `src/shell/electron/providerSetup.ts` | Modify | Reading order, optional step, log events |
| `src/shell/electron/setupTerminal.ts` | Create | Fixed sign-in commands per OS |
| `src/shell/electron/setupDraft.ts` | Create | The draft kept across a restart |
| `src/shell/electron/setup.ts`, `main.ts` | Modify | IPC, window size, start at login |
| `src/shell/electron/settingsWindow.ts` | Modify | A window's own minimum size |
| `assets/preload.cjs`, `src/renderer/bridge.ts` | Modify | The new setup calls |
| `src/renderer/settings/setup/*` | Create | The wizard |
| `src/renderer/settings/SetupPage.tsx` | Delete | Replaced |
| `src/renderer/settings/ModelField.tsx`, `settingsLogic.ts` | Modify | Cats Chat's rules |
| `src/renderer/settings/ProviderInstallation.tsx` | Modify | Check only when asked |
| `src/renderer/settings.css` | Modify | Wizard styles and tokens |
| `tests/**` | Modify | Each behavior above |

## Technical Decisions

- **Refuse, do not strip.** Stripping hidden characters would hide the attempt from the owner.
- **Enforce at the core too.** `createProfile` and `applyProfilePatch` cover the CLI and any
  host, and comparing with the stored value keeps old profiles working.
- **`Install` keeps its per-step IPC.** The page runs the queue, so "Stop after this one" and
  the fresh check after each step need no new backend state.
- **Log events, not streams.** Helpers report at the end, so an entry opens at start and is
  completed when the helper returns.
- **Static facts in a shared module.** Summaries and tags are product text per OS. What the
  helper reports is shown verbatim beside them.

## Testing Strategy

- **Unit:** the rule's boundaries and each refused character class; reading order and optional
  handling; log events; terminal command tables per OS; draft validation; model field labels.
- **Renderer:** `scripts/test-setup-wizard-renderer.mjs` with fake helpers.
- **Manual:** the Phase 4 list. It is reported as not done until someone does it.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Opening a terminal differs by OS and desktop | Medium | Fall back to a copyable command when none is found |
| The rule refuses a stored name on an unrelated save | High | Compare with the stored value; tested |
| Checking everything after Node.js meets a helper that assumed npm was ready | Medium | Checks only read; a failed read shows as that row's failure |
| Removing the PowerShell gate hides a real need | Medium | Sign-in opens Command Prompt; Windows acceptance covers it |

## Progress Log

| Date | Update |
|------|--------|
| 2026-11-04 | Plan created after the owner approved the mock |
| 2026-11-04 | Phase 1 merged (#116). Independent review found a stored name could not survive an unrelated save; fixed before merge |
| 2026-11-04 | Phase 2 reviewed: a throwing log listener, a repeatable restart, an unremovable draft and an early-exit terminal, all fixed before merge |
| 2026-11-04 | Phase 3: `scripts/test-setup-wizard-renderer.mjs` passes 66 of 66 with fake helpers |
| 2026-11-04 | Review of the 0.5.0 bump: variation selectors and strung-together joiners could hide text, "Try again" could run a row that only failed its check, and a failed check or terminal left the log closed, all fixed before dispatch. The script passes 78 of 78, now including Ctrl+Z after a preset |
| 2026-11-04 | Phase 4: the real main process, preload, page and read-only helpers, hidden and in an isolated home, on Codex, Claude and Grok: nothing ran before the button, each check reported this machine's real state, and nothing changed. Installs were not run |
