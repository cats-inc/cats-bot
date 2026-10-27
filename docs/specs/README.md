# Feature Specifications

> This directory contains feature specifications that define *what* to build and *why*.

## Purpose

Specifications define requirements before implementation begins. They help:

- Clarify what needs to be built
- Get stakeholder approval before coding
- Prevent scope creep during implementation
- Ensure AI agents understand requirements fully

## When to Create a Spec

Create a spec when:

- Adding a new feature with multiple components
- Making changes that affect multiple files or systems
- The feature requires user/stakeholder approval
- Requirements need to be documented for future reference

## Workflow

```
1. Identify need → Create spec
2. Define requirements → Get approval
3. Create plan → Implement
4. Mark as implemented
```

## Naming Convention

```
SPEC-NNN-short-title.md

Examples:
SPEC-001-user-registration.md
SPEC-002-payment-integration.md
SPEC-003-notification-system.md
```

## Template

Use [000-template.md](./000-template.md) as the starting point for new specs.

## Index

| Spec | Title | Status | Related Plan |
|------|-------|--------|--------------|
| [000-template](./000-template.md) | Template | - | - |
| [SPEC-001](./SPEC-001-resident-bot-core-and-global-execution.md) | Resident Bot Core and Global Execution Contract | Draft | [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md) |
| [SPEC-002](./SPEC-002-desktop-presence-settings-and-first-run.md) | Desktop Presence, Settings and First Run | Accepted | [PLAN-002](../plans/PLAN-002-desktop-presence.md) |
| [SPEC-003](./SPEC-003-note-reading-and-the-react-renderer.md) | Note Reading and the React Renderer | Accepted | [PLAN-003](../plans/PLAN-003-react-renderer.md) |
<!-- Add new specs above this line -->

## For AI Agents

1. **Before implementing**: Create spec for complex features
2. **Get approval**: Wait for review before proceeding to implementation
3. **Link to plan**: Reference the related PLAN document when created

---

*See also: [plans/](../plans/) for implementation plans*
