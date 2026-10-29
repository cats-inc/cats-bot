# PLAN-008: Cats Bot Identity and Data Root

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Phases 1–3 and 1b done (2026-10-30) except acceptance 1b.4; Phase 4 waits for PLAN-009 6.1–6.3 |
| **Owner** | Product owner |
| **Assigned To** | Unassigned |
| **Reviewer** | Independent agent |

## Related Spec

[SPEC-007: Cats Bot Identity and Data Root](../specs/SPEC-007-cats-bot-identity-and-data-root.md),
decided in [ADR-007](../decisions/007-give-cats-bot-its-own-identity-and-data-root.md).

## Overview

A mostly mechanical rename plus one default-path change, done as a clean break.
Repository edits land in one PR; the GitHub rename, release deletion and
workspace updates are separate, ordered steps because they act outside the
repository. Start only when no other branch or worktree is open in this
repository, so the local folder rename cannot strand anyone's work.

## Implementation Phases

### Phase 0: Preconditions

- [x] 0.1: No open PRs and no worktrees other than this work's own (checked
      2026-10-30; check again before 3.3).
- [x] 0.2: SPEC-007 open questions answered on 2026-10-29: `CATS_BOT_HOME` is
      the ecosystem root, and 0.3.0 waits for PLAN-009.

### Phase 1: Repository changes (one PR)

- [x] 1.1: `src/core/store/paths.ts`: ecosystem root `~/.catsbot`, bots under
      `bots/`, `CATS_BOT_HOME`; remove `CATS_BOTS_HOME`. Add a segment-aware
      containment helper if any path check needs one (SPEC-007 FR-5). No path
      check compares the data root, so none was added.
- [x] 1.2: `src/core/runtime/supervisor.ts`: `--managed-by cats-bot`.
- [x] 1.3: `package.json` (name, `build.appId`, any `cats-bots` strings) and the
      lockfile root name; `src/shell/electron/main.ts` AUMID
      `io.catsinc.catsbot.<botId>` (the hub layout of SPEC-008 changes it again).
- [x] 1.4: Release identity: `src/shell/electron/update/adapter.ts` feed,
      `src/shell/electron/update/release.ts` (`UPDATE_REPOSITORY`),
      `scripts/build-preview.mjs`, `scripts/release-contract.mjs`,
      `scripts/create-source-bundle.py` (source folder name and BUILDING text),
      `scripts/third-party-notices.ts`, and the generated-file marker in
      `src/core/runtime/providersConfig.ts`. The workflows name only
      `cats-inc/cats-runtime`; the preview workflow became `bot-preview.yml`,
      named "Cats Bot Standard Preview", the name `build-preview.mjs` requires.
- [x] 1.5: `src/cli/main.ts` help text, `src/core/bot.ts` (passes the bots
      home to path resolution), `src/core/hostEnv.ts` (`CATS_BOT_PROVIDER_*`),
      `tests/support/fixture-cli/claude-fixture.mjs` (`CATS_BOT_FIXTURE_*`) and
      every test listed below.
- [x] 1.6: Docs that describe current behavior: README, `docs/setup-guide.md`,
      `docs/services.md`, `docs/testing.md`, `docs/deployment.md`,
      `docs/architecture.md`, SPEC-001 FR-2/FR-5, SPEC-005, and test-hygiene
      lines that tell agents which real folder to avoid (AGENTS.md, PLAN-001;
      PLAN-004 and PLAN-006 name it only in records). Decision records (ADR-001
      and the new ADR-007), progress-log rows, release notes and research stay
      as written, as history.
- [x] 1.7: `npm ci && npm run typecheck && npm test && npm run build`.
      A grep over `src/`, `tests/`, `scripts/`, `assets/`, `package.json`,
      README and the guides in 1.6 finds no `cats-bots`, `CATS_BOTS_`,
      `.cats/bots` or `io.catsinc.cats-bot`; `docs/decisions/`, progress logs,
      `docs/releases/` and `docs/research/` are excluded as history. The only
      matches left are the tests proving `CATS_BOTS_HOME` and
      `CATS_BOTS_PROVIDER_*` are ignored. An isolated shell start creates only
      `<CATS_BOT_HOME>/bots/<id>/`; the smoke passed `--user-data-dir` so the
      owner's `%APPDATA%\Cats Bot` stayed untouched.

**Deliverables**: merged PR; the code no longer names the old identity.

### Phase 1b: Uninstaller (owner request, 2026-10-30)

- [x] 1b.1: `assets/installer/installer.nsh`: the "Remove all user data" page and
      its gated removal of `~/.catsbot`, `%APPDATA%\Cats Bot` and the update
      cache `%LOCALAPPDATA%\cats-bot-updater` (SPEC-007 FR-9), after
      cats-platform's uninstaller. `build.extraMetadata.name` is `cats-bot`,
      which names that cache. Removal goes through `rd /s`, never NSIS's
      `RMDir /r`, which empties the targets of junctions inside the tree; what
      cannot be removed is reported. A per-machine install skips the page.
- [x] 1b.2: Every per-user uninstall that is not an update removes the Run
      values named `io.catsinc.catsbot` and `io.catsinc.catsbot.<botId>` that
      start this installation, with their StartupApproved values. A packaged
      start registers Start at login again while the owner has it on.
- [x] 1b.3: `tests/shell/installer.test.ts` ties the page, the guards, the three
      roots and the login-entry names to the app's and electron-builder's own
      names. Local checks on 2026-10-30:
      - A local x64 electron-builder NSIS build compiled the uninstaller and
        installer without warnings; its `app-update.yml` names the
        `cats-bot-updater` cache, and the packaged name is `cats-bot`.
      - Throwaway NSIS builds ran the macros against test registry keys and
        temporary folders. The login cleanup stepped past an unnamed default
        value and an undeletable value, removed only this installation's
        values case-insensitively with their StartupApproved values, and kept
        another folder's, a look-alike `Cats Bot2` folder's, the 0.2.x name
        and Desktop's `Cats`. The root removal kept the target of a junction
        inside a root and of a root that is itself a junction, removed
        read-only files, and ignored a missing root.
      - An NSIS `RMDir /r` control run emptied a junction's target, which is
        why it is not used.
- [ ] 1b.4: Interactive uninstall in a disposable Windows account or sandbox,
      never on the owner's profile: unchecked keeps every root; checked
      removes them and keeps the target of a junction in a bot workspace;
      installing over a copy keeps Start at login; a reinstall that kept the
      data starts at login again after the first launch. Run with PLAN-009 6.2,
      before 0.3.0.

**Deliverables**: when asked, 0.3.0's uninstaller removes Cats Bot's data,
update cache and login entries, and never anything outside them.

### Phase 2: GitHub (owner-confirmed, irreversible)

- [x] 2.1: Delete releases v0.2.0–v0.2.5 and their tags. The owner confirmed all
      six on 2026-10-30; v0.2.5 was published after this plan was written. All
      six were deleted after the Phase 1 merge.
- [x] 2.2: Rename the repository to `cats-inc/cats-bot`. Nothing may depend on
      the automatic redirect.
- [x] 2.3: Verify organization secrets with selected-repository access (macOS
      signing) still include the renamed repository, branch protection still
      requires `node (ubuntu-latest)`, `node (windows-latest)` and `validate` (no
      ruleset applies to this repository, checked 2026-10-30), and the CI and
      release workflows resolve under the new name. After the rename all five
      secrets were listed for `cats-inc/cats-bot`, the three checks were
      unchanged and "Cats Bot Standard Preview" was an active workflow; the
      first CI run under the new name is the PR that records this.

**Deliverables**: renamed repository with no releases.

### Phase 3: Workspace and other repositories

- [x] 3.1: cats-one: `config/developer-workspace.json` (id, path,
      `packageName`), `scripts/shared/workspace-inventory.mjs`, README,
      `docs/architecture.md`, `docs/setup-guide.md`; regenerate AGENTS.md and run
      workspace sync. Sync requires each member's folder and package name to match
      its id, so it fails from the Phase 1 merge until 3.1 and 3.3 are both done;
      do them together. Merged as cats-one #31.
- [x] 3.2: cats-platform `docs/deployment.md`: shared macOS secrets are scoped to
      `cats-platform` and `cats-bot`. Historical ADR/SPEC/PLAN mentions in
      cats-platform and cats-runtime stay as written. Merged as cats-platform
      #352.
- [x] 3.3: Rename the local checkout folder to `cats-bot`, update remotes, and
      update project memory that names the old repository. Workspace sync then
      regenerated the parent AGENTS.md with `cats-bot/`.

**Deliverables**: the workspace builds and syncs with the new member name.

### Phase 4: First 0.3.0 release (after PLAN-009 6.1–6.3, per SPEC-007 FR-8)

- [ ] 4.1: Release notes per SPEC-007 FR-8. On the development machine the owner
      turns off Start at login in 0.2.5 (on 2026-10-30 its entry was
      `io.catsinc.cats-bot.mochi` under `HKCU\...\CurrentVersion\Run`),
      uninstalls 0.2.5 without updating it in place, installs 0.3.0 and removes
      `~/.cats/bots` by hand.

## Files to Create/Modify

Phase 1 changed these files on 2026-10-30 (from `01b5d87`):

| File | Action | Description |
|------|--------|-------------|
| `src/core/store/paths.ts`, `src/index.ts` | Modify | Root, layout, `CATS_BOT_HOME`, `resolveCatsBotHome`, `botRootIn` |
| `src/core/bot.ts` | Modify | `initializeBot` places the bot in the given bots folder |
| `src/core/runtime/supervisor.ts`, `src/core/runtime/providersConfig.ts`, `src/core/runtime/client.ts` | Modify | `--managed-by`, generated-file marker, `startup.managedBy` type |
| `src/shell/electron/main.ts`, `src/shell/electron/update/adapter.ts`, `src/shell/electron/update/release.ts` | Modify | AUMID, feed, release identity |
| `src/cli/main.ts` | Modify | Help text |
| `src/core/hostEnv.ts`, `tests/support/fixture-cli/claude-fixture.mjs` | Modify | `CATS_BOT_PROVIDER_*`, `CATS_BOT_FIXTURE_*` |
| `package.json`, `package-lock.json` | Modify | Name, URLs, appId |
| `.github/workflows/bot-preview.yml` (was `bots-preview.yml`), `scripts/build-preview.mjs`, `scripts/release-contract.mjs`, `scripts/create-source-bundle.py`, `scripts/third-party-notices.ts` | Modify | Repository and workflow identity |
| `tests/support/harness.ts` | Modify | Temporary `CATS_BOT_HOME` with bots in `bots/` |
| `tests/core/store.test.ts`, `tests/core/hostEnv.test.ts`, `tests/integration/runtime.test.ts` | Modify, Create | Root resolution, old variables ignored, `managedBy` |
| `tests/core/secrets.test.ts`, `tests/core/providers.test.ts`, `tests/core/bot.test.ts`, `tests/core/profile.test.ts`, `tests/core/life.test.ts`, `tests/core/telegram.test.ts`, `tests/core/providerInteractions.test.ts`, `tests/core/desktopControlCore.test.ts` | Modify | Environment variables and temporary prefixes |
| `tests/shell/trayMenu.test.ts`, `tests/shell/windowsDesktopControl.test.ts`, `tests/integration/tools.test.ts`, `tests/integration/multinote.test.ts` | Modify | Same |
| `tests/shell/releasePipeline.test.ts`, `tests/shell/updates.test.ts` | Modify | Contract, packaged identity check, updater feed and workflow name agree |
| README, AGENTS.md and the docs in 1.6 | Modify | Current behavior |
| `assets/installer/installer.nsh`, `tests/shell/installer.test.ts`, `package.json` (`extraMetadata`), `src/shell/electron/main.ts` (Phase 1b) | Modify, Create | Remove all user data without following links; login entries and their re-registration |
| ADR-001, ADR-004, ADR-007, SPEC-007, PLAN-008, `docs/README.md`, the spec and plan indexes | Modify | Status lines; releases to delete are v0.2.0–v0.2.5; 0.2.x upgrade steps |

## Technical Decisions

- No compatibility shims: an old variable or path is ignored, not translated
  (ADR-007).
- AUMID changes twice (here, then in PLAN-009) rather than waiting, so this
  plan stays independent of the hub. No release ships between them, so only
  development builds see the intermediate form. A development build with Start
  at login on keeps a login entry named after the AUMID it ran with; turn it off
  before switching builds.
- The release repository and preview workflow name live in
  `scripts/release-contract.mjs`; `build-preview.mjs` uses them, and
  `tests/shell/releasePipeline.test.ts` checks the updater identity and the
  workflow file against them.

## Testing Strategy

- **Unit Tests**: path resolution with and without `CATS_BOT_HOME`; the old
  variables have no effect; the release contract, packaged identity check,
  updater feed and preview workflow name agree. No path check compares the
  data root, so there is no containment test.
- **Integration Tests**: the packed Runtime starts with the new `--managed-by`
  and `runtime/` under the new bot root.
- **Manual Testing**: isolated Windows shell start; release workflow dry run
  (`build-preview.mjs` candidate) under the renamed repository.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| A missed old name breaks updates or the release guard | High | Phase 1.7 grep plus the release contract tests |
| Renaming the folder strands another agent's worktree | Medium | Phase 0.1; rename last |
| Secrets lose repository access after rename | Medium | Phase 2.3 check before any release |
| Owner's machine keeps a 0.2.x uninstall entry pointing at the new install | Medium | SPEC-007 FR-8 instructions; uninstall first |
| The uninstaller removes data the owner wanted to keep | High | Unchecked by default; only the three roots, never through a link; never during an update, a reinstall or a per-machine uninstall; checks 1b.3 and acceptance 1b.4 |
| 0.2.x offers 0.3.0 through GitHub's rename redirect, or its login entry starts 0.3.0 against an empty root | Medium | SPEC-007 FR-8: no in-app update from 0.2.x, Start at login off before uninstalling |

## Progress Log

| Date | Update |
|------|--------|
| 2026-10-29 | Plan created from the owner's decisions; nothing implemented. |
| 2026-10-29 | Owner answered SPEC-007's open questions: `CATS_BOT_HOME` is `~/.catsbot`; 0.3.0 ships with the hub. |
| 2026-10-29 | Review fix: Phase 4 follows PLAN-009 tasks 6.1–6.3, so the two plans no longer wait on each other. |
| 2026-10-30 | Phase 1 implemented. `npm ci`, typecheck, 237 tests and the build passed on Windows. The isolated shell start (temporary `CATS_BOT_HOME` and `--user-data-dir`, fixture CLI) created only `bots/smoke/`, its Runtime exited cleanly on `cats-bot quit`, and `~/.catsbot`, `~/.cats/bots` and `%APPDATA%\Cats Bot` were unchanged. The owner confirmed deleting v0.2.0–v0.2.5. |
| 2026-10-30 | Independent review: no code defects. Its fixes: one release identity source with a regression test, the 0.2.x login-entry and redirect steps in SPEC-007 FR-8, ADR-001/ADR-004 status lines. Bot ids are not validated (pre-existing; `..` resolves into the hub's namespace), left for the owner to schedule. |
| 2026-10-30 | Phase 1 merged as #60. Phases 2–3 done: releases and tags v0.2.0–v0.2.5 deleted, the repository renamed to `cats-inc/cats-bot` (secrets, branch protection and workflows checked), cats-one #31 and cats-platform #352 merged, the local folder renamed and the workspace synced. The owner scheduled bot-id validation as PLAN-009 task 1.6 (SPEC-008 FR-27). |
| 2026-10-30 | Phase 1b at the owner's request: the uninstaller offers Remove all user data like Desktop's and removes Cats Bot's login entries (SPEC-007 FR-9). An independent review found that NSIS's `RMDir /r` empties junction targets, confirmed locally, so removal moved to `rd /s`; it also added the update cache (renamed `cats-bot-updater`), StartupApproved values, the per-machine guard, the loop fixes and the login re-registration. The interactive uninstall (1b.4) is still to run. |

---

*Created: 2026-10-29*
*Author: Claude*
