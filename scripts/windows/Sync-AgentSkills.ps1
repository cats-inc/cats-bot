<#
.SYNOPSIS
    Publishes canonical skills and their resources to local agent discovery paths.
.DESCRIPTION
    Replaces matching skill directories only. Unrelated discovery skills are preserved.
    Rejects symbolic links and junctions in source or destination trees before copying.
.PARAMETER ProjectRoot
    Project containing AGENTS.md and skills/. Defaults to this script's project.
.PARAMETER Agent
    Optional host: claude or codex. Defaults to both. The codex path (.agents) is
    also read by Antigravity CLI (agy).
.PARAMETER Clean
    Compatibility flag. Like a normal sync, replaces only matching canonical skills;
    never removes the entire discovery directory or unrelated skills.
.EXAMPLE
    .\scripts\windows\Sync-AgentSkills.ps1 -Agent codex
.EXAMPLE
    .\scripts\windows\Sync-AgentSkills.ps1 -ProjectRoot "C:/Projects/child"
#>
param(
    [string]$ProjectRoot,
    [ValidateSet("claude", "codex")]
    [string]$Agent,
    [switch]$Clean
)
$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).ProviderPath
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "AGENTS.md") -PathType Leaf)) {
    throw "ProjectRoot must contain AGENTS.md."
}
function Assert-NoLinks {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $Item = Get-Item -LiteralPath $Path -Force
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing linked skill path: $Path"
    }
    if ($Item.PSIsContainer) {
        foreach ($Child in Get-ChildItem -LiteralPath $Path -Force) {
            Assert-NoLinks $Child.FullName
        }
    }
}
$SkillsDir = Join-Path $ProjectRoot "skills"
Assert-NoLinks $SkillsDir
$SkillDirs = @(Get-ChildItem -LiteralPath $SkillsDir -Directory | Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName "SKILL.md") -PathType Leaf
})
$AgentPaths = @{ claude = ".claude"; codex = ".agents" }
$SelectedAgents = @($AgentPaths.Keys)
if ($Agent) { $SelectedAgents = @($Agent) }
# Preflight every target before mutating any host.
foreach ($AgentName in $SelectedAgents) {
    $HostRoot = Join-Path $ProjectRoot $AgentPaths[$AgentName]
    if (Test-Path -LiteralPath $HostRoot) {
        if ((Get-Item -LiteralPath $HostRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing linked discovery root: $HostRoot"
        }
    }
    Assert-NoLinks (Join-Path $HostRoot "skills")
}
foreach ($Skill in $SkillDirs) {
    if ($Skill.Name -notmatch "^[a-z0-9]+(?:-[a-z0-9]+)*$" -or $Skill.Name.Length -gt 64) {
        throw "Invalid skill directory name: $($Skill.Name)"
    }
}
foreach ($AgentName in $SelectedAgents) {
    $TargetDir = Join-Path (Join-Path $ProjectRoot $AgentPaths[$AgentName]) "skills"
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    foreach ($Skill in $SkillDirs) {
        $SkillTarget = [IO.Path]::GetFullPath((Join-Path $TargetDir $Skill.Name))
        if (-not $SkillTarget.StartsWith($TargetDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Skill target escapes discovery directory: $SkillTarget"
        }
        if (Test-Path -LiteralPath $SkillTarget) {
            Remove-Item -LiteralPath $SkillTarget -Recurse -Force
        }
        New-Item -ItemType Directory -Path $SkillTarget -Force | Out-Null
        foreach ($Source in Get-ChildItem -LiteralPath $Skill.FullName -Recurse -File -Force) {
            if ($Source.Name.EndsWith(".bootstrap", [StringComparison]::OrdinalIgnoreCase)) { continue }
            $RelativePath = $Source.FullName.Substring($Skill.FullName.Length + 1)
            $Destination = Join-Path $SkillTarget $RelativePath
            New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
            Copy-Item -LiteralPath $Source.FullName -Destination $Destination -Force
        }
    }
    Write-Output "Synced $($SkillDirs.Count) skills to $AgentName."
}
