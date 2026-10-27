# Claude-Specific Instructions

> **If you are NOT Claude, please ignore this file.**

## Prerequisites

**MUST** read `AGENTS.md` first for cross-agent guidelines before reading this file.

## Role Awareness

Check the **Project Roles** table in `AGENTS.md`.
- If a **Conductor** is assigned (and it's not you), act as a Specialist: prioritize their tasks and strictly follow their architectural plans.
- If **you** are the Conductor, you are responsible for orchestration, task management, and status tracking.

## Command Aliases

- `dyu` - **MUST** confirm you have read `AGENTS.md` and this file. **MUST** respond with exactly: "I am Claude, and I understand."
- `mbf` - **Merge Bootstrap Files**:
  1. Find all `*.bootstrap` files in the project
  2. For each `.bootstrap` file, compare with its corresponding file and merge appropriate content
  3. Delete each `.bootstrap` file after successful merge
  4. Find all `.gitkeep` files and check if their parent directory contains other files - if so, delete the `.gitkeep` file
  5. Report summary of changes when complete

## Output Formatting Rules

- **MUST** 使用條列式 (bullet list) 而非表格，除非是模擬圖表或表格真正必要
- **MUST NOT** 濫用表格語法（`|` 和 `-----`）
- **SHOULD** 用縮排條列取代多欄表格
- 例外情況：比較多個選項的優缺點、數據對照表、API 參數規格等真正需要表格的場景

## About This File

This file contains Claude-specific configurations and instructions that should not be applied by other AI agents (Gemini, Codex, etc.).

Only Claude should read and maintain this file.

---

## Claude-Specific Configurations

### Behavioral Guidelines

- **MUST** read AGENTS.md at the start of every session
- **MUST** follow the Development Workflow defined in AGENTS.md
- **MUST NOT** skip testing when code changes are made
- **MUST NOT** modify other agents' files (GEMINI.md, CODEX.md)
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

### Agent Skills

Claude Code discovers skills from `.claude/skills/<name>/SKILL.md`. The canonical source is the `skills/` directory at the project root.

To sync skills after changes:
```powershell
.\scripts\windows\Sync-AgentSkills.ps1
```

### MCP Server Configurations

```json
{
  "mcpServers": {
    // Add Claude-specific MCP server configurations here if needed
  }
}
```

### Preferred Behaviors

- **Precision over speed**: Take time to understand requirements fully
- **Test before commit**: Always validate changes work as expected
- **Document decisions**: Use ADRs for architectural choices
- **Communicate clearly**: Report progress and blockers promptly

### Project-Specific Context

(Add any project-specific context or conventions that Claude should be aware of)

---

## Maintenance

This file is maintained by Claude only. Other agents should not modify this file.

Last updated: <!-- Update this when making changes -->
