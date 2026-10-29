<#
.SYNOPSIS
    Install or verify the native Windows Claude Code CLI for Cats.

.DESCRIPTION
    Rewrites the stable native Claude Code installer knowledge from
    environment-bootstrap into a Cats-owned packaged setup helper. The helper
    supports check-only mode for packaged-host orchestration, removes legacy
    npm-installed Claude shims that can shadow the native binary, and emits a
    structured JSON result for resume-safe setup flows.

.PARAMETER CheckOnly
    Report Claude Code readiness without mutating the local machine.

.PARAMETER Apply
    Install Claude Code if it is missing and clean legacy npm shims if present.

.PARAMETER Upgrade
    Re-run the official installer when Claude Code is already present.

.PARAMETER Force
    Force a reinstall by re-running the official installer.

.PARAMETER Uninstall
    Remove the user-scoped Claude Code CLI binary and any legacy npm shims.
    Auth files, API keys, and provider configuration files are left in place.

.PARAMETER Json
    Emit a structured JSON result.

.PARAMETER AllowAdmin
    Allow execution under an elevated shell.

.PARAMETER InstallState
    Override installation detection for deterministic tests.

.PARAMETER NpmShimState
    Override legacy npm shim detection for deterministic tests.

.PARAMETER DetectedVersion
    Override the detected version for deterministic tests.

.PARAMETER AuthState
    Override post-install authentication detection for deterministic tests.

.PARAMETER SkipInstaller
    Skip the actual installer invocation. Intended for deterministic tests.

.PARAMETER SkipNpmCleanup
    Skip removal of legacy npm-installed Claude shims. Intended for
    deterministic tests.
#>
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
  [ValidateSet('auto', 'present', 'missing')]
  [string]$NpmShimState = 'auto',
  [string]$DetectedVersion = '',
  [ValidateSet('auto', 'authenticated', 'auth_required')]
  [string]$AuthState = 'auto',
  [switch]$SkipInstaller,
  [switch]$SkipNpmCleanup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_HiddenProcess.ps1')
. (Join-Path $PSScriptRoot '_NativeInstallerSupport.ps1')

function Write-StructuredResult {
  param(
    [pscustomobject]$Result,
    [int]$ExitCode
  )

  if (Get-Variable -Name catsInitialObservation -Scope Script -ErrorAction SilentlyContinue) {
    Add-CatsNativeObservation -Result $Result -Before $script:catsInitialObservation -Attempted ([bool]$script:shouldInstall) -Skipped ([bool]$SkipInstaller)
  }

  if ($Json) {
    $Result | ConvertTo-Json -Depth 10
  } else {
    Write-Host "Mode: $($Result.mode)"
    Write-Host "Status: $($Result.status)"
    Write-Host "Installed: $($Result.installed)"
    if ($Result.detectedVersion) {
      Write-Host "Version: $($Result.detectedVersion)"
    }
    foreach ($action in $Result.plannedActions) {
      Write-Host "Planned action: $action"
    }
    foreach ($change in $Result.appliedChanges) {
      Write-Host "Applied change: $change"
    }
    foreach ($warning in $Result.warnings) {
      Write-Host "Warning: $warning"
    }
    foreach ($step in $Result.manualSteps) {
      Write-Host "Manual step: $step"
    }
  }

  exit $ExitCode
}

function Resolve-ClaudeExecutablePath {
  return Join-Path $env:USERPROFILE '.local\bin\claude.exe'
}

function Refresh-UserPath {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
    [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
}

function Get-ClaudeNpmCandidateRoots {
  $candidates = [System.Collections.Generic.List[string]]::new()
  try {
    $currentPrefix = (npm config get prefix 2>$null | Out-String).Trim()
    if (-not [string]::IsNullOrWhiteSpace($currentPrefix)) {
      $candidates.Add($currentPrefix)
    }
  } catch {
  }

  $defaultNpmDir = Join-Path $env:APPDATA 'npm'
  if (-not $candidates.Contains($defaultNpmDir)) {
    $candidates.Add($defaultNpmDir)
  }

  return $candidates.ToArray()
}

function Get-ClaudeNpmArtifacts {
  $artifacts = [System.Collections.Generic.List[string]]::new()
  foreach ($root in Get-ClaudeNpmCandidateRoots) {
    foreach ($path in @(
        (Join-Path $root 'claude'),
        (Join-Path $root 'claude.cmd'),
        (Join-Path $root 'claude.ps1'),
        (Join-Path $root 'node_modules\@anthropic-ai\claude-code')
      )) {
      if (Test-Path -LiteralPath $path) {
        $artifacts.Add($path)
      }
    }
  }
  return $artifacts.ToArray()
}

function Test-ClaudeNpmShimPresent {
  if ($NpmShimState -eq 'present') {
    return $true
  }
  if ($NpmShimState -eq 'missing') {
    return $false
  }
  return @(Get-ClaudeNpmArtifacts).Count -gt 0
}

function Remove-ClaudeNpmShim {
  if ($SkipNpmCleanup) {
    return $false
  }

  $artifacts = @(Get-ClaudeNpmArtifacts)
  if ($artifacts.Count -eq 0) {
    return $false
  }

  try {
    npm uninstall -g @anthropic-ai/claude-code 2>&1 | Out-Null
  } catch {
  }

  foreach ($artifact in $artifacts) {
    Remove-Item -LiteralPath $artifact -Recurse -Force -ErrorAction SilentlyContinue
  }

  return $true
}

function Detect-ClaudeInstall {
  $claudeExecutablePath = Resolve-ClaudeExecutablePath

  if ($InstallState -eq 'installed') {
    return [pscustomobject]@{
      installed = $true
      commandPath = $claudeExecutablePath
      detectedVersion = $DetectedVersion
    }
  }

  if ($InstallState -eq 'missing') {
    return [pscustomobject]@{
      installed = $false
      commandPath = $claudeExecutablePath
      detectedVersion = $DetectedVersion
    }
  }

  Refresh-UserPath
  $command = Get-Command claude -ErrorAction SilentlyContinue
  $installed = $null -ne $command -or (Test-Path -LiteralPath $claudeExecutablePath -PathType Leaf)
  $version = $DetectedVersion
  $commandPath = if ($null -ne $command) { $command.Source } else { $claudeExecutablePath }
  $commandSource = if ($null -ne $command) { $command.Source } else { '' }
  $versionProbePath = Resolve-HiddenVersionProbePath `
    -PreferredPath $commandSource `
    -FallbackPath $claudeExecutablePath

  if ($installed -and [string]::IsNullOrWhiteSpace($version) -and $versionProbePath) {
    try {
      $version = Get-HiddenCommandText -FileName $versionProbePath -ArgumentList @('--version')
    } catch {
      $version = ''
    }
  }

  return [pscustomobject]@{
    installed = $installed
    commandPath = $commandPath
    detectedVersion = $version
  }
}

function Test-ClaudeAuthSatisfied {
  switch ($AuthState) {
    'authenticated' {
      return $true
    }
    'auth_required' {
      return $false
    }
  }

  return -not [string]::IsNullOrWhiteSpace($env:ANTHROPIC_API_KEY)
}

function Invoke-ClaudeInstaller {
  if ($SkipInstaller) {
    return [pscustomobject]@{
      usedWingetFallback = $false
      skipped = $true
    }
  }

  try {
    $installScript = Invoke-RestMethod 'https://claude.ai/install.ps1'
    $child = Invoke-CatsRemoteInstaller -ScriptText $installScript
    if (-not $child.success) { throw $child.stderr }
    return [pscustomobject]@{
      usedWingetFallback = $false
      skipped = $false
    }
  } catch {
    $wingetCommand = Get-Command winget -ErrorAction SilentlyContinue
    if ($null -eq $wingetCommand) {
      throw
    }

    winget install Anthropic.ClaudeCode --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
      throw "Claude Code winget fallback failed with exit code $LASTEXITCODE."
    }

    return [pscustomobject]@{
      usedWingetFallback = $true
      skipped = $false
    }
  }
}

if (-not $CheckOnly -and -not $Apply -and -not $Upgrade -and -not $Force -and -not $Uninstall) {
  $CheckOnly = $true
}

if ($Uninstall -and ($CheckOnly -or $Apply -or $Upgrade -or $Force)) {
  throw 'Install-ClaudeCode.ps1 -Uninstall is mutually exclusive with other modes.'
}

if ($CheckOnly -and ($Apply -or $Upgrade -or $Force)) {
  throw 'Install-ClaudeCode.ps1 accepts either -CheckOnly or one mutation mode.'
}

if ($Force -and $Upgrade) {
  $Upgrade = $false
}

$executionMode = if ($Uninstall) {
  'uninstall'
} elseif ($CheckOnly) {
  'check'
} elseif ($Force) {
  'force'
} elseif ($Upgrade) {
  'upgrade'
} else {
  'apply'
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin -and -not $AllowAdmin) {
  $result = [pscustomobject]@{
    helper = 'windows-claude-native-installer'
    mode = $executionMode
    status = 'failed'
    installed = $false
    detectedVersion = $null
    commandPath = Resolve-ClaudeExecutablePath
    restartRequired = $false
    plannedActions = @()
    warnings = @(
      'Refusing to run under an elevated shell without -AllowAdmin because Claude Code is intended for user-scoped installation.'
    )
    appliedChanges = @()
    manualSteps = @()
    interruptions = @()
    cleanedNpmShim = $false
    usedWingetFallback = $false
  }
  Write-StructuredResult -Result $result -ExitCode 1
}

$detected = Detect-ClaudeInstall
$npmShimPresent = Test-ClaudeNpmShimPresent
$plannedActions = [System.Collections.Generic.List[string]]::new()
$appliedChanges = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$manualSteps = [System.Collections.Generic.List[string]]::new()
$usedWingetFallback = $false
$authSatisfied = [bool]$detected.installed -and (Test-ClaudeAuthSatisfied)

if ($Uninstall) {
  $userBinary = Resolve-ClaudeExecutablePath
  $hasUserBinary = Test-Path -LiteralPath $userBinary -PathType Leaf
  $npmArtifacts = @(Get-ClaudeNpmArtifacts)

  if ($hasUserBinary) { $plannedActions.Add("remove:$userBinary") | Out-Null }
  foreach ($artifact in $npmArtifacts) { $plannedActions.Add("remove:$artifact") | Out-Null }

  if ($DryRun) {
    $previewStatus = if (-not $hasUserBinary -and $npmArtifacts.Count -eq 0 -and -not $detected.installed) {
      'not_installed'
    } else {
      'preview'
    }
    if ($detected.installed -and -not $hasUserBinary -and $npmArtifacts.Count -eq 0) {
      $warnings.Add("system_install_remains_at:$($detected.commandPath)") | Out-Null
      $manualSteps.Add("Claude Code install at $($detected.commandPath) cannot be removed by this helper; uninstall it through its installer.") | Out-Null
    }
    $result = [pscustomobject]@{
      helper = 'windows-claude-native-installer'
      mode = 'uninstall'
      status = $previewStatus
      installed = [bool]$detected.installed
      detectedVersion = $null
      commandPath = $detected.commandPath
      restartRequired = $false
      plannedActions = $plannedActions.ToArray()
      warnings = $warnings.ToArray()
      appliedChanges = @()
      manualSteps = $manualSteps.ToArray()
      interruptions = @()
      cleanedNpmShim = $false
      usedWingetFallback = $false
    }
    Write-StructuredResult -Result $result -ExitCode 0
  }

  if (-not $hasUserBinary -and $npmArtifacts.Count -eq 0 -and -not $detected.installed) {
    $result = [pscustomobject]@{
      helper = 'windows-claude-native-installer'
      mode = 'uninstall'
      status = 'not_installed'
      installed = $false
      detectedVersion = $null
      commandPath = $userBinary
      restartRequired = $false
      plannedActions = @()
      warnings = @()
      appliedChanges = @()
      manualSteps = @()
      interruptions = @()
      cleanedNpmShim = $false
      usedWingetFallback = $false
    }
    Write-StructuredResult -Result $result -ExitCode 0
  }

  if ($hasUserBinary) {
    try {
      Remove-Item -LiteralPath $userBinary -Force -ErrorAction Stop
      $appliedChanges.Add("removed:$userBinary") | Out-Null
    } catch {
      $warnings.Add("failed_to_remove:$userBinary") | Out-Null
    }
  }

  $cleanedNpm = $false
  if ($npmArtifacts.Count -gt 0) {
    $cleanedNpm = Remove-ClaudeNpmShim
    if ($cleanedNpm) {
      foreach ($artifact in $npmArtifacts) { $appliedChanges.Add("removed:$artifact") | Out-Null }
    } else {
      foreach ($artifact in $npmArtifacts) { $warnings.Add("failed_to_remove:$artifact") | Out-Null }
    }
  }

  Refresh-UserPath
  $detectedAfter = Detect-ClaudeInstall
  $finalStatus = if ($detectedAfter.installed) {
    $warnings.Add("system_install_remains_at:$($detectedAfter.commandPath)") | Out-Null
    'changes_required'
  } elseif ($warnings.Count -gt 0) {
    'changes_required'
  } else {
    'uninstalled'
  }

  $finalManualSteps = if ($detectedAfter.installed) {
    @("Remove the remaining Claude Code install at $($detectedAfter.commandPath) using its installer or package manager.")
  } else {
    @()
  }

  $result = [pscustomobject]@{
    helper = 'windows-claude-native-installer'
    mode = 'uninstall'
    status = $finalStatus
    installed = [bool]$detectedAfter.installed
    detectedVersion = $null
    commandPath = $detectedAfter.commandPath
    restartRequired = $false
    plannedActions = $plannedActions.ToArray()
    warnings = $warnings.ToArray()
    appliedChanges = $appliedChanges.ToArray()
    manualSteps = $finalManualSteps
    interruptions = @()
    cleanedNpmShim = $cleanedNpm
    usedWingetFallback = $false
  }
  Write-StructuredResult -Result $result -ExitCode 0
}

if ($npmShimPresent) {
  $plannedActions.Add('remove_legacy_npm_claude_shim')
}
if (-not $detected.installed) {
  $plannedActions.Add('install_claude_code_native')
}

if ($CheckOnly) {
  $status = if ($detected.installed -and -not $npmShimPresent) {
    if ($authSatisfied) { 'ready' } else { 'auth_required' }
  } elseif ($detected.installed) {
    'changes_required'
  } else {
    'not_installed'
  }
  $checkManualSteps = [System.Collections.Generic.List[string]]::new()
  $checkInterruptions = [System.Collections.Generic.List[object]]::new()
  if ($status -eq 'auth_required') {
    $checkManualSteps.Add('Run claude to complete the browser sign-in flow, or configure ANTHROPIC_API_KEY before first use.')
    $checkInterruptions.Add([pscustomobject]@{
        kind = 'auth_required'
        summary = 'Complete the Claude Code sign-in flow or configure ANTHROPIC_API_KEY, then rerun the packaged setup check.'
        resumable = $true
        requiresRestart = $false
        requiresElevation = $false
      })
  }

  $result = [pscustomobject]@{
    helper = 'windows-claude-native-installer'
    mode = 'check'
    status = $status
    installed = [bool]$detected.installed
    detectedVersion = if ($detected.detectedVersion) { $detected.detectedVersion } else { $null }
    commandPath = $detected.commandPath
    restartRequired = $false
    plannedActions = $plannedActions.ToArray()
    warnings = @()
    appliedChanges = @()
    manualSteps = $checkManualSteps.ToArray()
    interruptions = $checkInterruptions.ToArray()
    cleanedNpmShim = $false
    usedWingetFallback = $false
  }
  Write-StructuredResult -Result $result -ExitCode 0
}

if ($DryRun) {
  Write-CatsNativePreview -Helper 'windows-claude-native-installer' -Mode $executionMode -Detected $detected -Actions $plannedActions.ToArray() -EmitJson ([bool]$Json)
}

$cleanedNpmShim = $false
if ($npmShimPresent) {
  $cleanedNpmShim = Remove-ClaudeNpmShim
  if ($cleanedNpmShim) {
    $appliedChanges.Add('remove_legacy_npm_claude_shim')
  } elseif ($SkipNpmCleanup) {
    $warnings.Add('Legacy npm-installed Claude shims were left in place because cleanup was skipped.')
  }
}

$installFailed = $false
$catsInitialObservation = $detected.PSObject.Copy()
$shouldInstall = $Force -or $Upgrade -or -not $detected.installed
$installFailed = $false
if ($shouldInstall) {
  $installResult = try { Invoke-ClaudeInstaller } catch { [pscustomobject]@{ skipped = $false; success = $false; stderr = [string]$_.Exception.Message; usedPowerShell51Fallback = $false; usedWingetFallback = $false } }
  if ($installResult.PSObject.Properties['success'] -and -not $installResult.success) {
    $installFailed = $true
    $warnings.Add($installResult.stderr)
  }
  $usedWingetFallback = [bool]$installResult.usedWingetFallback
  if ($usedWingetFallback) {
    $warnings.Add('Claude Code installer required the winget fallback path.')
  }
  if ($installResult.skipped) {
    $warnings.Add('Installer invocation was skipped by request.')
  }

  Start-Sleep -Seconds 2
  $detected = Detect-ClaudeInstall
  if (-not $detected.installed -and -not $SkipInstaller -and -not $installFailed) {
    $warnings.Add('Claude Code installation completed but claude was still not detected.')
    $installFailed = $true
  }

  if ($Force) {
    $appliedChanges.Add('reinstall_claude_code_native')
  } elseif ($Upgrade) {
    $appliedChanges.Add('upgrade_claude_code_native')
  } else {
    $appliedChanges.Add('install_claude_code_native')
  }
}

$manualSteps.Add('Run `claude` to complete the browser sign-in flow, or configure ANTHROPIC_API_KEY before first use.')
$authSatisfied = [bool]$detected.installed -and (Test-ClaudeAuthSatisfied)
$interruptions = [System.Collections.Generic.List[object]]::new()
if ($shouldInstall -or $cleanedNpmShim) {
  $interruptions.Add([pscustomobject]@{
      kind = 'relaunch_required'
      summary = 'Run Detect Again after the Claude Code install step if the command is not visible yet.'
      resumable = $true
      requiresRestart = $false
      requiresElevation = $false
    })
}
if (-not $authSatisfied) {
  $interruptions.Add([pscustomobject]@{
      kind = 'auth_required'
      summary = 'Complete the Claude Code sign-in flow or configure ANTHROPIC_API_KEY, then rerun the packaged setup check.'
      resumable = $true
      requiresRestart = $false
      requiresElevation = $false
    })
}
$restartRequired = $false

$result = [pscustomobject]@{
  helper = 'windows-claude-native-installer'
  mode = $executionMode
  status = if ($installFailed) { 'failed' } elseif ($interruptions.Count -gt 0) { [string]$interruptions[0].kind } else { 'ready' }
  installed = [bool]$detected.installed
  detectedVersion = if ($detected.detectedVersion) { $detected.detectedVersion } else { $null }
  commandPath = $detected.commandPath
  restartRequired = $restartRequired
  plannedActions = @()
  warnings = $warnings.ToArray()
  appliedChanges = $appliedChanges.ToArray()
  manualSteps = $manualSteps.ToArray()
  interruptions = $interruptions.ToArray()
  cleanedNpmShim = $cleanedNpmShim
  usedWingetFallback = $usedWingetFallback
}
Write-StructuredResult -Result $result -ExitCode $(if ($installFailed) { 1 } else { 0 })
