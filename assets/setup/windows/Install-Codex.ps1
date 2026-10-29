param(
  [switch]$CheckOnly,
  [switch]$Apply,
  [switch]$Upgrade,
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$DryRun,
  [switch]$Json,
  [switch]$AllowAdmin,
  [ValidateSet('auto', 'installed', 'missing')]
  [string]$InstallState = 'auto',
  [ValidateSet('auto', 'outdated', 'current')]
  [string]$OutdatedState = 'auto',
  [string]$DetectedVersion = '',
  [switch]$SkipNpmInvocation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_NpmCliInstaller.ps1')

Invoke-PackagedNpmCliInstall `
  -HelperId 'windows-codex-native-installer' `
  -PackageName '@openai/codex' `
  -CommandName 'codex' `
  -DisplayName 'OpenAI Codex CLI' `
  -CheckOnly:$CheckOnly `
  -Apply:$Apply `
  -Upgrade:$Upgrade `
  -Force:$Force `
  -Uninstall:$Uninstall `
  -DryRun:$DryRun `
  -Json:$Json `
  -AllowAdmin:$AllowAdmin `
  -InstallState $InstallState `
  -OutdatedState $OutdatedState `
  -DetectedVersion $DetectedVersion `
  -SkipNpmInvocation:$SkipNpmInvocation
