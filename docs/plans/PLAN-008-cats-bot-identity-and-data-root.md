# PLAN-008: Cats Bot Identity and Data Root

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Draft |
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

- [ ] 0.1: No open PRs and no worktrees other than this work's own.
- [x] 0.2: SPEC-007 open questions answered on 2026-10-29: `CATS_BOT_HOME` is
      the ecosystem root, and 0.3.0 waits for PLAN-009.

### Phase 1: Repository changes (one PR)

- [ ] 1.1: `src/core/store/paths.ts`: ecosystem root `~/.catsbot`, bots under
      `bots/`, `CATS_BOT_HOME`; remove `CATS_BOTS_HOME`. Add a segment-aware
      containment helper if any path check needs one (SPEC-007 FR-5).
- [ ] 1.2: `src/core/runtime/supervisor.ts`: `--managed-by cats-bot`.
- [ ] 1.3: `package.json` (name, `build.appId`, any `cats-bots` strings) and the
      lockfile root name; `src/shell/electron/main.ts` AUMID
      `io.catsinc.catsbot.<botId>` (the hub layout of SPEC-008 changes it again).
- [ ] 1.4: Release identity: `src/shell/electron/update/adapter.ts` feed,
      `src/shell/electron/update/release.ts` (`UPDATE_REPOSITORY`),
      `scripts/build-preview.mjs`, `scripts/release-contract.mjs`,
      `scripts/create-source-bundle.py` (source folder name and BUILDING text),
      `scripts/third-party-notices.ts`, and the generated-file marker in
      `src/core/runtime/providersConfig.ts`. The workflows name only
      `cats-inc/cats-runtime`; their display name "Bots Standard Preview" may be
      renamed with them.
- [ ] 1.5: `src/cli/main.ts` help text, `src/core/bot.ts` (passes the bots
      home to path resolution), `src/core/hostEnv.ts` (`CATS_BOT_PROVIDER_*`),
      `tests/support/fixture-cli/claude-fixture.mjs` (`CATS_BOT_FIXTURE_*`) and
      every test listed below.
- [ ] 1.6: Docs that describe current behavior: README, `docs/setup-guide.md`,
      `docs/services.md`, `docs/testing.md`, `docs/deployment.md`,
      `docs/architecture.md`, SPEC-001 FR-2/FR-5, SPEC-005, and test-hygiene
      lines in PLAN-001/PLAN-004/PLAN-006 that tell agents which real folder to
      avoid. Decision records (ADR-001 and the new ADR-007), progress-log rows,
      release notes and research stay as written, as history.
- [ ] 1.7: `npm ci && npm run typecheck && npm test && npm run build`.
      A grep over `src/`, `tests/`, `scripts/`, `assets/`, `package.json`,
      README and the guides in 1.6 finds no `cats-bots`, `CATS_BOTS_`,
      `.cats/bots` or `io.catsinc.cats-bot`; `docs/decisions/`, progress logs,
      `docs/releases/` and `docs/research/` are excluded as history.
      An isolated shell start creates only `<CATS_BOT_HOME>/bots/<id>/` and its
      Electron user data under `%APPDATA%\Cats Bot`.

**Deliverables**: merged PR; the code no longer names the old identity.

### Phase 2: GitHub (owner-confirmed, irreversible)

- [ ] 2.1: Owner confirms deleting releases v0.2.0–v0.2.4 and their tags; delete
      them.
- [ ] 2.2: Rename the repository to `cats-inc/cats-bot`. Nothing may depend on
      the automatic redirect.
- [ ] 2.3: Verify organization secrets with selected-repository access (macOS
      signing) still include the renamed repository, the tag ruleset still
      applies, and the CI and release workflows resolve under the new name.

**Deliverables**: renamed repository with no releases.

### Phase 3: Workspace and other repositories

- [ ] 3.1: cats-one: `config/developer-workspace.json` (id, path,
      `packageName`), `scripts/shared/workspace-inventory.mjs`, README,
      `docs/architecture.md`, `docs/setup-guide.md`; regenerate AGENTS.md and run
      workspace sync.
- [ ] 3.2: cats-platform `docs/deployment.md`: shared macOS secrets are scoped to
      `cats-platform` and `cats-bot`. Historical ADR/SPEC/PLAN mentions in
      cats-platform and cats-runtime stay as written.
- [ ] 3.3: Rename the local checkout folder to `cats-bot`, update remotes, and
      update project memory that names the old repository.

**Deliverables**: the workspace builds and syncs with the new member name.

### Phase 4: First 0.3.0 release (after PLAN-009 6.1–6.3, per SPEC-007 FR-8)

- [ ] 4.1: Release notes per SPEC-007 FR-8; owner reinstalls on the
      development machine and removes `~/.cats/bots` by hand.

## Files to Create/Modify

Phase 1 occurrences found on 2026-10-29 (`2d17069`):

| File | Action | Description |
|------|--------|-------------|
| `src/core/store/paths.ts` | Modify | Root, layout, `CATS_BOT_HOME` |
| `src/core/runtime/supervisor.ts`, `src/core/runtime/providersConfig.ts`, `src/core/bot.ts` | Modify | `--managed-by`, names |
| `src/shell/electron/main.ts`, `src/shell/electron/update/adapter.ts`, `src/shell/electron/update/release.ts` | Modify | AUMID, feed, release identity |
| `src/cli/main.ts` | Modify | Help text and defaults |
| `src/core/hostEnv.ts`, `tests/support/fixture-cli/claude-fixture.mjs` | Modify | `CATS_BOT_PROVIDER_*`, `CATS_BOT_FIXTURE_*` |
| `package.json`, `package-lock.json` | Modify | Name, appId |
| `scripts/build-preview.mjs`, `scripts/release-contract.mjs`, `scripts/create-source-bundle.py`, `scripts/third-party-notices.ts` | Modify | Repository identity |
| `tests/core/store.test.ts`, `tests/core/secrets.test.ts`, `tests/core/providers.test.ts`, `tests/core/bot.test.ts`, `tests/core/profile.test.ts`, `tests/core/life.test.ts`, `tests/core/telegram.test.ts`, `tests/core/providerInteractions.test.ts`, `tests/core/desktopControlCore.test.ts` | Modify | Environment variable and paths |
| `tests/shell/updates.test.ts`, `tests/shell/trayMenu.test.ts`, `tests/shell/windowsDesktopControl.test.ts`, `tests/integration/tools.test.ts`, `tests/integration/runtime.test.ts`, `tests/integration/multinote.test.ts`, `tests/support/harness.ts` | Modify | Same |
| README and the docs in 1.6 | Modify | Current behavior |

## Technical Decisions

- No compatibility shims: an old variable or path is ignored, not translated
  (ADR-007).
- AUMID changes twice (here, then in PLAN-009) rather than waiting, so this
  plan stays independent of the hub. No release ships between them, so only
  development builds see the intermediate form.

## Testing Strategy

- **Unit Tests**: path resolution with and without `CATS_BOT_HOME`; the old
  variable has no effect; segment-aware containment.
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

## Progress Log

| Date | Update |
|------|--------|
| 2026-10-29 | Plan created from the owner's decisions; nothing implemented. |
| 2026-10-29 | Owner answered SPEC-007's open questions: `CATS_BOT_HOME` is `~/.catsbot`; 0.3.0 ships with the hub. |
| 2026-10-29 | Review fix: Phase 4 follows PLAN-009 tasks 6.1–6.3, so the two plans no longer wait on each other. |

---

*Created: 2026-10-29*
*Author: Claude*
