# Documentation Index

The follow-on [shared Platform proposal](architecture.md#proposed-shared-platform-consumption-2026-10-29)
links Platform's ADR-142, SPEC-134 and PLAN-127 package-consumption design.
It proposes versioned setup/native/host reuse while preserving the independent
Bot ecosystem and PR #51's Hub/core authority. No shared-package cutover is implemented.

The next design (2026-10-29, not implemented) gives Cats Bot its own identity
and `~/.catsbot` root ([ADR-007](decisions/007-give-cats-bot-its-own-identity-and-data-root.md),
[SPEC-007](specs/SPEC-007-cats-bot-identity-and-data-root.md),
[PLAN-008](plans/PLAN-008-cats-bot-identity-and-data-root.md)). It also runs
every bot as a headless core under one hub, with a transferable coordinator role
and per-bot execution environments, native only at first
([ADR-008](decisions/008-run-every-bot-as-a-headless-core-under-one-hub.md),
[ADR-009](decisions/009-give-one-bot-a-bounded-coordinator-role.md),
[ADR-010](decisions/010-bind-each-bot-to-an-execution-environment.md),
[SPEC-008](specs/SPEC-008-hub-and-bots.md),
[SPEC-009](specs/SPEC-009-coordinator-role.md),
[PLAN-009](plans/PLAN-009-hub-headless-cores-and-coordinator.md)).

[Desktop experience parity](plans/PLAN-007-desktop-experience-parity.md) tracks
provider-first packaged setup, Runtime catalog controls, language selection,
native tray update dialogs and conversation/avatar restoration.
[ADR-006](decisions/006-share-runtime-catalogs-and-package-provider-setup-helpers.md)
records the shared catalog/helper contracts and compatibility policy.

[Provider interactions and tool visibility](specs/SPEC-004-provider-interactions-and-tool-visibility.md)
is approved for sliced implementation (2026-10-28) for headless owner replies, safe waiting
and recovery, note/tray UI and effective tool/permission diagnostics.
[PLAN-004](plans/PLAN-004-provider-interactions-and-tool-visibility.md) integrates
Runtime SPEC-039 independently of Platform. The headless control, policy and
receipt lifecycle are implemented; native operation and renderer acceptance
remain tracked in the plan. See [provider control API](provider-interactions.md).

> This directory contains all project documentation.

## Root-Level Documents

These important documents live in the project root:

| Document                      | Status   | Description                             |
| ----------------------------- | -------- | --------------------------------------- |
| [PROGRESS.md](../PROGRESS.md) | Template | Implementation status and work packages |
| [ROADMAP.md](../ROADMAP.md)   | Template | Project roadmap and milestones          |

## Core Documents

| Document                             | Status   | Description                                        |
| ------------------------------------ | -------- | -------------------------------------------------- |
| [requirements.md](./requirements.md) | Template | Requirements specification                         |
| [architecture.md](./architecture.md) | Complete | Components, data flow and patterns of the bot core |
| [api.md](./api.md)                   | Template | API specification (REST/WebSocket)                 |

## Development Guides

| Document                                           | Status   | Description                                                              |
| -------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| [setup-guide.md](./setup-guide.md)                 | Complete | Install, verify, build and run commands                                  |
| [testing.md](./testing.md)                         | Complete | Test types, commands and state-hygiene rules                             |
| [deployment.md](./deployment.md)                   | Complete | Manual Standard Preview publication, signing and application updates     |
| [security-guidelines.md](./security-guidelines.md) | Template | Security policies                                                        |
| [mcp-config.md](./mcp-config.md)                   | Template | MCP server configuration                                                 |
| [services.md](./services.md)                       | Complete | Dynamic loopback listeners and the environment variables that place them |
| [SCRIPT-STANDARDS.md](./SCRIPT-STANDARDS.md)       | Template | Script standards and naming                                              |

## Scripts

The `scripts/` directory contains platform-specific scripts for your project:

| Directory          | Platform | Purpose                   |
| ------------------ | -------- | ------------------------- |
| `scripts/windows/` | Windows  | PowerShell scripts (.ps1) |
| `scripts/linux/`   | Linux    | Bash scripts (.sh)        |
| `scripts/macos/`   | macOS    | Bash scripts (.sh)        |

Add your project-specific automation scripts here.

## Agent Guidance and Protocol Examples

| Document                           | Status    | Description                                               |
| ---------------------------------- | --------- | --------------------------------------------------------- |
| [AGENT-GUIDE.md](./AGENT-GUIDE.md) | Bootstrap | Agent collaboration guide                                 |
| [terminology.md](./terminology.md) | Template  | AAIF/A2A/MCP terminology                                  |
| [a2a/](./a2a/)                     | Optional  | Integration pointer; full examples require the a2a flavor |
| [specs/](./specs/)                 | Directory | Feature specifications                                    |
| [plans/](./plans/)                 | Directory | Implementation plans                                      |
| [decisions/](./decisions/)         | Directory | Architecture Decision Records                             |

**Legend**:

- Complete - project-specific content is written
- Draft - partially written; needs review
- Template - placeholder content; needs project details
- Bootstrap - generic guidance supplied by the bootstrap; usable as-is
- Directory - container for individual records
- Optional - requires an additional flavor
- Research - evidence and recommendations; not an accepted architecture decision

## Research

| Document                                                                                              | Status    | Description                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [research/](./research/)                                                                              | Directory | Research notes and external sources                                                                                                                  |
| [Standalone living bot feasibility](./research/2026-10-27-standalone-living-bot-feasibility.md)       | Research  | Read-only survey of cats-runtime, cats-platform and desktop-work-fleet; Catlas versus companion, runtime wakeup limits, dependency-direction options |
| [Resident bot architecture assessment](./research/2026-10-27-resident-bot-architecture-assessment.md) | Research  | Independent source-based recommendations for bot lifetime, Runtime integration, global model settings and desktop presentation                       |

## Decision Records

The [0.2.0 Standard Preview release notes](releases/v0.2.0.md) define its exact
download matrix, signing policy, Runtime pin and migration/recovery instructions.

Standard Preview delivery and host-owned Check for Updates are defined by
[ADR-004](decisions/004-publish-standard-previews-with-host-owned-updates.md),
[SPEC-005](specs/SPEC-005-standard-preview-releases-and-updates.md) and
[PLAN-005](plans/PLAN-005-standard-preview-releases-and-updates.md).

| Document                                                                                             | Status      | Description                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| [ADR-001](./decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md) | Accepted    | Resident bot core over cats-runtime, disposable presentation, one global execution target; fuses both research documents |
| [SPEC-001](./specs/SPEC-001-resident-bot-core-and-global-execution.md)                               | Accepted    | Behavioural contract for the bot core, alive mechanisms, global retarget and the presentation API                        |
| [PLAN-001](./plans/PLAN-001-resident-bot-core-foundation.md)                                         | In progress | Phases 0 to 5 from toolchain to minimal shell; desktop presence reserved for a later ADR                                 |

## Context-Driven Development

For complex features, use the spec-plan-implement workflow:

1. **Spec** (`specs/SPEC-NNN-title.md`): Define what to build and why
2. **Plan** (`plans/PLAN-NNN-title.md`): Define how to build it
3. **Implement**: Follow the plan, update progress

This ensures AI agents understand requirements before writing code.

## For AI Agents

When working on this project:

1. Check this index to understand what documentation exists
2. Create missing documents as needed
3. Update this index when adding new documents
4. Follow templates provided in each file

## Document Standards

- Use Markdown format
- Include a clear title and purpose at the top
- Keep documents focused and concise
- Update the "Last updated" date when modifying
