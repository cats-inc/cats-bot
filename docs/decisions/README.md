# Architecture Decision Records (ADR)

> This directory contains Architecture Decision Records for documenting significant technical decisions.

## Purpose

ADRs capture the context, decision, and consequences of architectural choices. They help:

- Future developers understand *why* decisions were made
- Prevent re-discussing settled decisions
- Create institutional memory across sessions and team members

## When to Create an ADR

Create an ADR when:

- Choosing a framework, library, or technology
- Making architectural decisions (patterns, structure)
- Deciding between multiple valid alternatives
- Making decisions that are difficult to reverse

## Naming Convention

```
ADR-NNN-short-title.md

Examples:
ADR-001-use-postgresql-database.md
ADR-002-adopt-hexagonal-architecture.md
ADR-003-jwt-authentication.md
```

## Template

Use [000-template.md](./000-template.md) as the starting point for new ADRs.

## Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [000-template](./000-template.md) | Template | - | - |
| [001](./001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md) | Build a Resident Bot Core on cats-runtime with Disposable Presentation | Proposed | 2026-10-27 |
| [002](./002-give-the-bot-a-desktop-presence-in-the-electron-shell.md) | Give the Bot a Desktop Presence in the Electron Shell | Accepted | 2026-10-28 |
| [003](./003-build-the-renderer-with-react-and-vite-like-cats-desktop.md) | Build the Renderer with React and Vite, Like Cats Desktop | Accepted | 2026-10-28 |
| [004](./004-publish-standard-previews-with-host-owned-updates.md) | Publish Standard Previews with Host-Owned Updates | Accepted | 2026-10-28 |
| [005](./005-give-the-bot-owner-consented-desktop-control.md) | Give the Bot Owner-Consented Desktop Control | Accepted | 2026-10-29 |
<!-- Add new ADRs above this line -->

## For AI Agents

1. **Before making a decision**: Check this directory for existing relevant records
2. **After making a decision**: Create a new ADR using the template
3. **Update the index**: Add the new ADR to the table above

---

*See also: [AGENTS.md](../../AGENTS.md) for decision-making protocols*
