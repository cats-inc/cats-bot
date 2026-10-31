<#
.SYNOPSIS
    Prepare a clean Windows host so user-launched CLIs work in PowerShell.

.DESCRIPTION
    After Cats's bridge installs CLIs (claude, codex, kiro-cli, cursor-agent, ...),
    the user still needs two things to invoke them from their own PowerShell or
    cmd terminal (e.g. for first-time `claude auth login`):

      1. ExecutionPolicy unblocked. A clean Windows install defaults to
         Restricted, which blocks .ps1 / .psm1 shims that several CLIs ship as.

      2. User PATH updated. Some installers drop binaries under per-user
         directories (~/.local/bin, %LOCALAPPDATA%/Kiro-Cli, etc.) that are not
         on the default PATH, so a fresh terminal cannot find the executables.

    This helper is idempotent and user-scoped. It never touches the Machine
    policy or Machine PATH and never elevates without -AllowAdmin.

.PARAMETER CheckOnly
    Report the current state without mutating policy or PATH.

.PARAMETER Apply
    Set ExecutionPolicy to RemoteSigned (CurrentUser scope) and append any
    missing CLI directories to the user PATH.

.PARAMETER Json
    Emit a structured JSON result instead of human-readable console output.

.PARAMETER AllowAdmin
    Allow execution under an elevated shell. Defaults to refusing because the
    helper is intended to keep changes user-scoped.

.PARAMETER UserHome
    Override the user home directory (defaults to $env:USERPROFILE).

.PARAMETER LocalAppData
    Override the LOCALAPPDATA directory (defaults to $env:LOCALAPPDATA).

.PARAMETER CurrentUserPath
    Override the current user PATH for deterministic check-mode tests.

.PARAMETER CurrentExecutionPolicy
    Override the current ExecutionPolicy reading for deterministic tests.
#>
param(
  [switch]$CheckOnly,
  [switch]$Apply,
  [switch]$Json,
  [switch]$AllowAdmin,
  [string]$UserHome = $env:USERPROFILE,
  [string]$LocalAppData = $env:LOCALAPPDATA,
  [string]$CurrentUserPath = '',
  [string]$CurrentExecutionPolicy = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$HelperId = 'windows-cli-readiness-helper'
$DesiredPolicy = 'RemoteSigned'
$AcceptablePolicies = @('RemoteSigned', 'Unrestricted', 'Bypass')
$ExecutionPolicyRegistrySubKey = 'Software\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell'

function Read-CurrentUserExecutionPolicy {
  # Read the registry directly instead of calling Get-ExecutionPolicy. When the
  # bridge spawns powershell.exe with redirected I/O and an inherited PSModulePath
  # that points at PowerShell 7's modules, Microsoft.PowerShell.Security fails to
  # autoload — taking Get-ExecutionPolicy / Set-ExecutionPolicy down with it.
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ExecutionPolicyRegistrySubKey)
    if ($null -eq $key) {
      return 'Undefined'
    }
    try {
      $value = $key.GetValue('ExecutionPolicy')
    } finally {
      $key.Dispose()
    }
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) {
      return 'Undefined'
    }
    return [string]$value
  } catch {
    return 'Undefined'
  }
}

function Set-CurrentUserExecutionPolicyRegistry {
  param([string]$Policy)

  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($ExecutionPolicyRegistrySubKey)
  if ($null -eq $key) {
    throw "Failed to open or create HKCU:\$ExecutionPolicyRegistrySubKey"
  }
  try {
    $key.SetValue('ExecutionPolicy', $Policy, [Microsoft.Win32.RegistryValueKind]::String)
  } finally {
    $key.Dispose()
  }
}

function Normalize-PathValue {
  param(
    [AllowNull()]
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return ''
  }

  return $Path.Trim().TrimEnd('\')
}

function Get-PathEntries {
  param(
    [AllowNull()]
    [string]$PathValue
  )

  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return @()
  }

  return $PathValue.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries)
}

function Test-PathEntryPresent {
  param(
    [string[]]$Entries,
    [string]$Expected
  )

  $normalizedExpected = (Normalize-PathValue -Path $Expected).ToLowerInvariant()
  foreach ($entry in $Entries) {
    if ((Normalize-PathValue -Path $entry).ToLowerInvariant() -eq $normalizedExpected) {
      return $true
    }
  }

  return $false
}

function Get-CandidatePathEntries {
  param(
    [string]$HomeDir,
    [string]$LocalApp
  )

  $candidates = [System.Collections.Generic.List[string]]::new()

  if (-not [string]::IsNullOrWhiteSpace($HomeDir)) {
    [void]$candidates.Add((Join-Path $HomeDir '.local\bin'))
  }
  if (-not [string]::IsNullOrWhiteSpace($LocalApp)) {
    [void]$candidates.Add((Join-Path $LocalApp 'Kiro-Cli'))
    [void]$candidates.Add((Join-Path $LocalApp 'cursor-agent'))
  }

  return $candidates.ToArray()
}

function Write-StructuredResult {
  param(
    [pscustomobject]$Result,
    [int]$ExitCode
  )

  if ($Json) {
    $Result | ConvertTo-Json -Depth 10
  } else {
    Write-Host "Mode: $($Result.mode)"
    Write-Host "Status: $($Result.status)"
    Write-Host "Current policy: $($Result.currentExecutionPolicy)"
    Write-Host "Desired policy: $($Result.desiredExecutionPolicy)"
    Write-Host "Restart required: $($Result.restartRequired)"
    foreach ($warning in $Result.warnings) {
      Write-Warning $warning
    }
    foreach ($change in $Result.plannedChanges) {
      Write-Host "Planned change: $change"
    }
    foreach ($change in $Result.appliedChanges) {
      Write-Host "Applied change: $change"
    }
  }

  exit $ExitCode
}

if (-not $CheckOnly -and -not $Apply) {
  $CheckOnly = $true
}

if ($CheckOnly -and $Apply) {
  throw 'Setup-CliReadiness.ps1 accepts either -CheckOnly or -Apply, not both.'
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$executionMode = if ($Apply) { 'apply' } else { 'check' }

if ($isAdmin -and -not $AllowAdmin) {
  $result = [pscustomobject]@{
    helper = $HelperId
    mode = $executionMode
    status = 'failed'
    currentExecutionPolicy = ''
    desiredExecutionPolicy = $DesiredPolicy
    currentUserPath = ''
    candidatePathEntries = @()
    missingPathEntries = @()
    restartRequired = $false
    plannedChanges = @()
    appliedChanges = @()
    warnings = @(
      'Refusing to run under an elevated shell without -AllowAdmin because this helper is intended for user-scoped setup.'
    )
  }
  Write-StructuredResult -Result $result -ExitCode 1
}

$currentPolicy = if ($PSBoundParameters.ContainsKey('CurrentExecutionPolicy')) {
  $CurrentExecutionPolicy
} else {
  Read-CurrentUserExecutionPolicy
}

$pathProbe = if ($PSBoundParameters.ContainsKey('CurrentUserPath')) {
  $CurrentUserPath
} else {
  [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
$pathEntries = Get-PathEntries -PathValue $pathProbe
$candidatePathEntries = Get-CandidatePathEntries -HomeDir $UserHome -LocalApp $LocalAppData

$policyNeedsUpdate = -not ($AcceptablePolicies -contains $currentPolicy)
$missingPathEntries = [System.Collections.Generic.List[string]]::new()
foreach ($candidate in $candidatePathEntries) {
  if (Test-PathEntryPresent -Entries $pathEntries -Expected $candidate) {
    continue
  }
  # Add unconditionally so users can run this helper before installing the
  # native CLIs. Windows' PATH lookup silently ignores entries pointing at
  # non-existent directories, so seeding ahead of install has no side effect
  # but lets the next fresh terminal see the binaries the moment they appear.
  [void]$missingPathEntries.Add($candidate)
}

$plannedChanges = [System.Collections.Generic.List[string]]::new()
if ($policyNeedsUpdate) {
  [void]$plannedChanges.Add("Set CurrentUser ExecutionPolicy to $DesiredPolicy (currently '$currentPolicy')")
}
foreach ($entry in $missingPathEntries) {
  [void]$plannedChanges.Add("Add $entry to user PATH")
}

if ($CheckOnly) {
  $checkStatus = if ($plannedChanges.Count -gt 0) { 'changes_required' } else { 'ready' }
  $checkRestartRequired = $missingPathEntries.Count -gt 0
  $result = [pscustomobject]@{
    helper = $HelperId
    mode = 'check'
    status = $checkStatus
    currentExecutionPolicy = $currentPolicy
    desiredExecutionPolicy = $DesiredPolicy
    currentUserPath = $pathProbe
    candidatePathEntries = $candidatePathEntries
    missingPathEntries = $missingPathEntries.ToArray()
    restartRequired = $checkRestartRequired
    plannedChanges = $plannedChanges.ToArray()
    appliedChanges = @()
    warnings = @()
  }
  Write-StructuredResult -Result $result -ExitCode 0
}

$appliedChanges = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

if ($policyNeedsUpdate) {
  try {
    Set-CurrentUserExecutionPolicyRegistry -Policy $DesiredPolicy
    [void]$appliedChanges.Add("Set CurrentUser ExecutionPolicy to $DesiredPolicy")
    $currentPolicy = $DesiredPolicy
  } catch {
    [void]$warnings.Add("Failed to set ExecutionPolicy: $($_.Exception.Message)")
  }
}

if ($missingPathEntries.Count -gt 0) {
  $existingPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $existingEntries = Get-PathEntries -PathValue $existingPath
  $combinedEntries = [System.Collections.Generic.List[string]]::new()
  foreach ($entry in $missingPathEntries) {
    [void]$combinedEntries.Add($entry)
  }
  foreach ($entry in $existingEntries) {
    [void]$combinedEntries.Add($entry)
  }
  $updatedPath = ($combinedEntries -join ';')
  try {
    [System.Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User')
    $env:Path = $updatedPath + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    foreach ($entry in $missingPathEntries) {
      [void]$appliedChanges.Add("Added $entry to user PATH")
    }
    $pathProbe = $updatedPath
  } catch {
    [void]$warnings.Add("Failed to update user PATH: $($_.Exception.Message)")
  }
}

$restartRequired = $missingPathEntries.Count -gt 0
$finalStatus = if ($warnings.Count -gt 0) {
  'partial'
} elseif ($restartRequired) {
  'restart_required'
} else {
  'ready'
}

$result = [pscustomobject]@{
  helper = $HelperId
  mode = 'apply'
  status = $finalStatus
  currentExecutionPolicy = $currentPolicy
  desiredExecutionPolicy = $DesiredPolicy
  currentUserPath = $pathProbe
  candidatePathEntries = $candidatePathEntries
  missingPathEntries = @()
  restartRequired = $restartRequired
  plannedChanges = @()
  appliedChanges = $appliedChanges.ToArray()
  warnings = $warnings.ToArray()
}
Write-StructuredResult -Result $result -ExitCode 0
