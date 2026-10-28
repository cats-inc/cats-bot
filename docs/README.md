# Documentation Index

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

| Document | Status | Description |
|----------|--------|-------------|
| [PROGRESS.md](../PROGRESS.md) | Template | Implementation status and work packages |
| [ROADMAP.md](../ROADMAP.md) | Template | Project roadmap and milestones |

## Core Documents

| Document | Status | Description |
|----------|--------|-------------|
| [requirements.md](./requirements.md) | Template | Requirements specification |
| [architecture.md](./architecture.md) | Complete | Components, data flow and patterns of the bot core |
| [api.md](./api.md) | Template | API specification (REST/WebSocket) |

## Development Guides

| Document | Status | Description |
|----------|--------|-------------|
| [setup-guide.md](./setup-guide.md) | Complete | Install, verify, build and run commands |
| [testing.md](./testing.md) | Complete | Test types, commands and state-hygiene rules |
| [deployment.md](./deployment.md) | Template | Deployment instructions |
| [security-guidelines.md](./security-guidelines.md) | Template | Security policies |
| [mcp-config.md](./mcp-config.md) | Template | MCP server configuration |
| [services.md](./services.md) | Complete | Dynamic loopback listeners and the environment variables that place them |
| [SCRIPT-STANDARDS.md](./SCRIPT-STANDARDS.md) | Template | Script standards and naming |

## Scripts

The `scripts/` directory contains platform-specific scripts for your project:

| Directory | Platform | Purpose |
|-----------|----------|---------|
| `scripts/windows/` | Windows | PowerShell scripts (.ps1) |
| `scripts/linux/` | Linux | Bash scripts (.sh) |
| `scripts/macos/` | macOS | Bash scripts (.sh) |

Add your project-specific automation scripts here.

## Agent Guidance and Protocol Examples

| Document | Status | Description |
|----------|--------|-------------|
| [AGENT-GUIDE.md](./AGENT-GUIDE.md) | Bootstrap | Agent collaboration guide |
| [terminology.md](./terminology.md) | Template | AAIF/A2A/MCP terminology |
| [a2a/](./a2a/) | Optional | Integration pointer; full examples require the a2a flavor |
| [specs/](./specs/) | Directory | Feature specifications |
| [plans/](./plans/) | Directory | Implementation plans |
| [decisions/](./decisions/) | Directory | Architecture Decision Records |

**Legend**:

- Complete - project-specific content is written
- Draft - partially written; needs review
- Template - placeholder content; needs project details
- Bootstrap - generic guidance supplied by the bootstrap; usable as-is
- Directory - container for individual records
- Optional - requires an additional flavor
- Research - evidence and recommendations; not an accepted architecture decision

## Research

| Document | Status | Description |
|----------|--------|-------------|
| [research/](./research/) | Directory | Research notes and external sources |
| [Standalone living bot feasibility](./research/2026-10-27-standalone-living-bot-feasibility.md) | Research | Read-only survey of cats-runtime, cats-platform and desktop-work-fleet; Catlas versus companion, runtime wakeup limits, dependency-direction options |
| [Resident bot architecture assessment](./research/2026-10-27-resident-bot-architecture-assessment.md) | Research | Independent source-based recommendations for bot lifetime, Runtime integration, global model settings and desktop presentation |

## Decision Records

| Document | Status | Description |
|----------|--------|-------------|
| [ADR-001](./decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md) | Accepted | Resident bot core over cats-runtime, disposable presentation, one global execution target; fuses both research documents |
| [SPEC-001](./specs/SPEC-001-resident-bot-core-and-global-execution.md) | Accepted | Behavioural contract for the bot core, alive mechanisms, global retarget and the presentation API |
| [PLAN-001](./plans/PLAN-001-resident-bot-core-foundation.md) | In progress | Phases 0 to 5 from toolchain to minimal shell; desktop presence reserved for a later ADR |

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
