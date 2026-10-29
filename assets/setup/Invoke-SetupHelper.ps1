<#
.SYNOPSIS
    Run one packaged Cats Bot provider helper with refreshed host PATH.
.DESCRIPTION
    Only the five supported providers and Codex prerequisites are accepted.
    No command strings or additional arguments are accepted from the UI.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('node', 'npm', 'codex', 'claude', 'antigravity', 'grok', 'muse')]
  [string]$Helper,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$scripts = @{
  node = 'Install-Node.ps1'; npm = 'Setup-NodeGlobalPrefix.ps1';
  codex = 'Install-Codex.ps1'; claude = 'Install-ClaudeCode.ps1';
  antigravity = 'Install-Antigravity.ps1'; grok = 'Install-Grok.ps1'; muse = 'Install-MetaCli.ps1'
}
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machinePath;$userPath;$env:Path"
$scriptPath = Join-Path (Join-Path $PSScriptRoot 'windows') $scripts[$Helper]
if ($Apply) { & $scriptPath -Apply -Json } else { & $scriptPath -CheckOnly -Json }
exit $LASTEXITCODE
