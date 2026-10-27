# Gemini-Specific Instructions

> **If you are NOT Gemini, please ignore this file.**

## Prerequisites

**MUST** read `AGENTS.md` first for cross-agent guidelines before reading this file.

## Role Awareness

Check the **Project Roles** table in `AGENTS.md`.
- If a **Conductor** is assigned (and it's not you), act as a Specialist: prioritize their tasks and strictly follow their architectural plans.
- If **you** are the Conductor, you are responsible for orchestration, task management, and status tracking.

## Command Aliases

| Alias | Action |
|-------|--------|
| `dyu` | **MUST** confirm you have read `AGENTS.md` and this file. **MUST** respond with exactly: "I am Gemini, and I understand." |

## About This File

This file contains Gemini-specific configurations and instructions that should not be applied by other AI agents (Claude, Codex, etc.).

Only Gemini should read and maintain this file.

---

## Gemini-Specific Configurations

### Behavioral Guidelines

- **MUST** read AGENTS.md at the start of every session
- **MUST** follow the Development Workflow defined in AGENTS.md
- **MUST NOT** skip testing when code changes are made
- **MUST NOT** modify other agents' files (CLAUDE.md, CODEX.md)
- **SHOULD** ask for clarification when requirements are ambiguous
- **SHOULD** propose approach before implementing major changes

### Conductor Responsibilities

If assigned as Conductor in Project Roles table:
- **MUST** maintain README.md "Current Status" section
- **MUST** create and assign tasks in `docs/plans/`
- **MUST** document major decisions in `docs/decisions/`
- **MUST NOT** make unilateral architectural decisions without documentation

### Code Modification Rules

- **MUST** update tests when modifying code
- **MUST** update documentation when changing public APIs
- **MUST** follow coding conventions specified in AGENTS.md
- **SHOULD** make minimal, focused changes
- **SHOULD** commit frequently with clear messages

### Preferred Behaviors

- **Thoroughness**: Ensure all edge cases are considered
- **Test coverage**: Validate both happy path and error cases
- **Documentation**: Keep docs synchronized with code changes
- **Collaboration**: Coordinate with other agents when needed

### Project-Specific Context

(Add any project-specific context or conventions that Gemini should be aware of)

### Agent Skills

Antigravity CLI (agy, the Gemini CLI successor) discovers skills from `.agents/skills/<name>/SKILL.md`, the same path Codex uses. The canonical source is the `skills/` directory at the project root.

To sync skills after changes:
```powershell
.\scripts\windows\Sync-AgentSkills.ps1
```

### Personal Memory

(This section is for Gemini to record long-term observations or preferences specific to this user/project)

---

## Maintenance

This file is maintained by Gemini only. Other agents should not modify this file.

Last updated: <!-- Update this when making changes -->
