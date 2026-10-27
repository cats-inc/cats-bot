# Agent Skills

> Structured, reusable agent instructions following the [Agent Skills](https://agentskills.io) open standard.

## Overview

Agent Skills provide progressive disclosure of complex instructions. Instead of embedding long procedures inline in `AGENTS.md` or agent-specific files, each skill is a standalone `SKILL.md` with YAML frontmatter that agents discover automatically.

## How It Works

1. **Canonical source**: All skills live in `skills/` (version-controlled)
2. **Sync to agents**: Run `Sync-AgentSkills.ps1` to copy skills to each agent's discovery path
3. **Agent discovery**: Each agent finds skills in its own directory

Skill directories may include supporting files (for example `scripts/`, `references/`, or `assets/`). Sync copies the entire skill directory so agents can access all referenced files.

### Discovery Paths

| Agent | Discovery Path |
|-------|---------------|
| Claude Code | `.claude/skills/<name>/SKILL.md` |
| Codex | `.agents/skills/<name>/SKILL.md` |
| Antigravity CLI (agy) | `.agents/skills/<name>/SKILL.md` (shared with Codex) |

### Syncing Skills

```powershell
# Sync all skills to all agents
.\scripts\windows\Sync-AgentSkills.ps1

# Sync to a specific agent only
.\scripts\windows\Sync-AgentSkills.ps1 -Agent claude

# Compatibility flag: still replaces only matching canonical names
.\scripts\windows\Sync-AgentSkills.ps1 -Clean
```

On Linux/macOS run `bash scripts/linux/sync-agent-skills.sh` (or the macOS copy).
Matching skill names are replaced from canonical sources; unrelated skills remain.
Pending `*.bootstrap` proposals are excluded, and linked source/discovery paths are
rejected before copying. A live agent may need a refreshed session after sync.

## SKILL.md Format

Each skill is a directory containing a `SKILL.md` file:

```
skills/
  └── skill-name/
      └── SKILL.md
```

The `SKILL.md` file uses YAML frontmatter:

```yaml
---
name: skill-name          # Required: 1-64 chars, lowercase, hyphens, no leading/trailing hyphen, no consecutive hyphens, must match directory
description: What and when # Required: 1-1024 chars
allowed-tools: Read Bash   # Optional (experimental; support varies by agent implementation)
---
Markdown instructions...
```

Note: `allowed-tools` is experimental and may be ignored by some agents.

## Available Skills

<!-- Add your project-specific skills here -->

| Skill | Description |
|-------|-------------|
| - | No skills defined yet. Add skills to the `skills/` directory. |

## Adding a New Skill

1. Create a directory under `skills/` with the skill name (lowercase, hyphens)
2. Add a `SKILL.md` file with proper frontmatter
3. Run `Sync-AgentSkills.ps1` to deploy
4. Update this README with the new skill

---

*This directory follows the [Agent Skills](https://agentskills.io) standard.*
