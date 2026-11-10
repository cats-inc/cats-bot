# Implementation Plans

- [PLAN-013: Persistent conversation resume](PLAN-013-persistent-conversation-resume.md)
  — implemented, unpublished, 2026-11-11; resume saved identities after restart, distinguish terminal
  loss from temporary failure and validate against an exact Runtime candidate.

- [PLAN-006: Desktop control session MCP](PLAN-006-desktop-control-session-mcp.md)
  — planned, 2026-10-29; contract and profile, observe-only helper, core server,
  note/tray/CLI and native phase A acceptance, then input tools after owner sign-off.
  Implementation not authorized.

- [PLAN-004: Provider interactions and tool visibility](PLAN-004-provider-interactions-and-tool-visibility.md)
  — ready, 2026-10-28; core/CLI, life loop/recovery, shell
  and isolated native/packaged acceptance. All phases pending.

> This directory contains implementation plans that define _how_ to build features.

## Purpose

Implementation plans break down approved specifications into actionable tasks. They help:

- Coordinate work across multiple developers/agents
- Track progress through implementation phases
- Document technical decisions made during development

## When to Create a Plan

Create a plan when:

- A specification (SPEC) has been approved
- The feature requires multiple implementation phases
- Work needs to be coordinated across multiple contributors

## Workflow

```
1. Spec approved → Create plan
2. Break into phases → Define tasks
3. Implement → Update progress
4. Complete → Mark as done
```

## Naming Convention

```
PLAN-NNN-short-title.md

Examples:
PLAN-001-user-authentication.md
PLAN-002-api-rate-limiting.md
PLAN-003-database-migration.md
```

## Template

Use [000-template.md](./000-template.md) as the starting point for new plans.

## Index

| Plan                                                            | Title                                 | Status                          | Related Spec                                                             |
| --------------------------------------------------------------- | ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| [000-template](./000-template.md)                               | Template                              | -                               | -                                                                        |
| [PLAN-001](./PLAN-001-resident-bot-core-foundation.md)          | Resident Bot Core Foundation          | Draft                           | [SPEC-001](../specs/SPEC-001-resident-bot-core-and-global-execution.md)  |
| [PLAN-002](./PLAN-002-desktop-presence.md)                      | Desktop Presence                      | In progress                     | [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md) |
| [PLAN-003](./PLAN-003-react-renderer.md)                        | React Renderer                        | Done                            | [SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md)     |
| [PLAN-005](./PLAN-005-standard-preview-releases-and-updates.md) | Standard Preview Releases and Updates | Implemented; CI gate in PR #32  | [SPEC-005](../specs/SPEC-005-standard-preview-releases-and-updates.md)   |
| [PLAN-007](./PLAN-007-desktop-experience-parity.md)             | Desktop Experience Parity             | Implemented; validation in plan | [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md) |
| [PLAN-008](./PLAN-008-cats-bot-identity-and-data-root.md)       | Cats Bot Identity and Data Root       | Phases 1–3 done                 | [SPEC-007](../specs/SPEC-007-cats-bot-identity-and-data-root.md)         |
| [PLAN-009](./PLAN-009-hub-headless-cores-and-coordinator.md)    | Hub, Headless Cores and Coordinator   | Implemented; reviewed in PLAN-010 | [SPEC-008](../specs/SPEC-008-hub-and-bots.md), [SPEC-009](../specs/SPEC-009-boss-cat-role.md) |
| [PLAN-010](./PLAN-010-boss-cat-derived-ids-and-hub-settings.md) | Boss Cat, Derived Ids and Hub Settings | In progress | [SPEC-008](../specs/SPEC-008-hub-and-bots.md), [SPEC-009](../specs/SPEC-009-boss-cat-role.md) |
| [PLAN-011](./PLAN-011-setup-wizard.md) | Setup Wizard | Implemented; clean-machine acceptance pending | [SPEC-010](../specs/SPEC-010-setup-wizard.md) |
| [PLAN-012](./PLAN-012-agent-clis-in-cats-bot-settings.md) | Agent CLIs in Cats Bot Settings | Implemented; clean-machine acceptance pending | [SPEC-013](../specs/SPEC-013-agent-clis-in-cats-bot-settings.md) |
| [PLAN-014](./PLAN-014-bot-state-database-and-memory.md) | Bot State Database and Memory | Draft; not authorized | [SPEC-014](../specs/SPEC-014-bot-state-database-and-migration.md), [SPEC-015](../specs/SPEC-015-bot-memory-layers-recall-and-consolidation.md) |

<!-- Add new plans above this line -->

## For AI Agents

1. **Link to spec**: Always reference the related SPEC document
2. **Update progress**: Mark tasks complete as you work
3. **Log updates**: Add entries to the Progress Log section

---

_See also: [specs/](../specs/) for feature specifications_
