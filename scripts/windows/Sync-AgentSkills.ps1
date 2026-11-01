<#
.SYNOPSIS
    Synchronize recursive canonical skills while preserving unrelated discovery skills.
.PARAMETER ProjectRoot
    Repository containing AGENTS.md and skills/.
.PARAMETER Agent
    claude or codex; defaults to both.
.PARAMETER Clean
    Preserve unrelated skills, as with a normal sync.
.PARAMETER DryRun
    Validate and preview without writing.
.EXAMPLE
    .\scripts\windows\Sync-AgentSkills.ps1 -Agent codex -DryRun
#>
param([string]$ProjectRoot, [ValidateSet("claude", "codex")][string]$Agent, [switch]$Clean, [switch]$DryRun)
$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$Arguments = @((Join-Path $PSScriptRoot "../shared/sync-agent-skills.mjs"), "--project-root", $ProjectRoot)
if ($Agent) { $Arguments += @("--agent", $Agent) }
if ($Clean) { $Arguments += "--clean" }
if ($DryRun) { $Arguments += "--dry-run" }
& node @Arguments
exit $LASTEXITCODE
