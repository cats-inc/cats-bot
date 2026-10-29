<#
.SYNOPSIS
    Prepare a user-scoped npm global prefix for packaged Cats setup flows.

.DESCRIPTION
    Rewrites the stable Windows npm prefix and PATH preparation knowledge from
    environment-bootstrap into a Cats-owned helper. The script is safe for
    packaged-host use because it supports a non-interactive check mode and
    structured JSON output.

.PARAMETER CheckOnly
    Report the current state without mutating npm config or user PATH.

.PARAMETER Apply
    Create the prefix directory, update the user-scoped npm prefix, and add the
    prefix directory to the user PATH when required.

.PARAMETER Json
    Emit a structured JSON result instead of human-readable console output.

.PARAMETER AllowAdmin
    Allow execution under an elevated shell. By default the script fails fast to
    keep the helper aligned with user-scoped packaged setup flows.

.PARAMETER UserHome
    Override the user home directory used to derive the desired npm prefix.

.PARAMETER DesiredPrefix
    Override the desired npm global prefix path.

.PARAMETER CurrentPrefix
    Override the current npm prefix for deterministic check-mode tests.

.PARAMETER CurrentUserPath
    Override the current user PATH value for deterministic check-mode tests.

.PARAMETER SkipNodeCheck
    Skip probing node/npm commands. Useful for test fixtures that only validate
    path and prefix mapping logic.
#>
param(
  [switch]$CheckOnly,
  [switch]$Apply,
  [switch]$Json,
  [switch]$AllowAdmin,
  [string]$UserHome = $env:USERPROFILE,
  [string]$DesiredPrefix = '',
  [string]$CurrentPrefix = '',
  [string]$CurrentUserPath = '',
  [switch]$SkipNodeCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Get-DesiredPrefix {
  if (-not [string]::IsNullOrWhiteSpace($DesiredPrefix)) {
    $resolvedPrefix = Resolve-Path -LiteralPath $DesiredPrefix -ErrorAction SilentlyContinue
    if ($null -ne $resolvedPrefix) {
      return $resolvedPrefix.Path
    }
    return $DesiredPrefix
  }

  return Join-Path $UserHome '.npm-global'
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

  $normalizedExpected = Normalize-PathValue -Path $Expected
  foreach ($entry in $Entries) {
    if ((Normalize-PathValue -Path $entry).ToLowerInvariant() -eq $normalizedExpected.ToLowerInvariant()) {
      return $true
    }
  }

  return $false
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
    Write-Host "Desired prefix: $($Result.desiredPrefix)"
    Write-Host "Restart required: $($Result.restartRequired)"
    foreach ($warning in $Result.warnings) {
      Write-Warning $warning
    }
    foreach ($change in $Result.plannedChanges) {
      Write-Host "Planned change: $change"
    }
  }

  exit $ExitCode
}

if (-not $CheckOnly -and -not $Apply) {
  $CheckOnly = $true
}

if ($CheckOnly -and $Apply) {
  throw 'Setup-NodeGlobalPrefix.ps1 accepts either -CheckOnly or -Apply, not both.'
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$desiredPrefixPath = Get-DesiredPrefix
$pathProbe = if ($PSBoundParameters.ContainsKey('CurrentUserPath')) {
  $CurrentUserPath
} else {
  [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
$prefixProbe = if ($PSBoundParameters.ContainsKey('CurrentPrefix')) {
  $CurrentPrefix
} else {
  ''
}
$warnings = [System.Collections.Generic.List[string]]::new()
$plannedChanges = [System.Collections.Generic.List[string]]::new()
$nodeVersion = $null
$npmVersion = $null
$status = 'ready'
$restartRequired = $false
$executionMode = if ($Apply) { 'apply' } else { 'check' }

if ($isAdmin -and -not $AllowAdmin) {
  $result = [pscustomobject]@{
    helper = 'windows-npm-prefix-helper'
    mode = $executionMode
    status = 'failed'
    desiredPrefix = $desiredPrefixPath
    currentPrefix = $prefixProbe
    currentUserPath = $pathProbe
    restartRequired = $false
    plannedChanges = @()
    warnings = @(
      'Refusing to run under an elevated shell without -AllowAdmin because this helper is intended for user-scoped setup.'
    )
    nodeVersion = $null
    npmVersion = $null
    appliedChanges = @()
  }
  Write-StructuredResult -Result $result -ExitCode 1
}

if (-not $SkipNodeCheck) {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
    [System.Environment]::GetEnvironmentVariable('Path', 'Machine')

  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  $npmCommand = Get-Command npm -ErrorAction SilentlyContinue

  if ($null -eq $nodeCommand -or $null -eq $npmCommand) {
    $missingNodeExitCode = if ($Apply) { 1 } else { 0 }
    $result = [pscustomobject]@{
      helper = 'windows-npm-prefix-helper'
      mode = $executionMode
      status = 'not_installed'
      desiredPrefix = $desiredPrefixPath
      currentPrefix = $prefixProbe
      currentUserPath = $pathProbe
      restartRequired = $false
      plannedChanges = @()
      warnings = @('Node.js and npm must be installed before npm-global CLI tools can be configured.')
      nodeVersion = $null
      npmVersion = $null
      appliedChanges = @()
    }
    Write-StructuredResult -Result $result -ExitCode $missingNodeExitCode
  }

  $nodeVersion = (& node -v).Trim()
  $npmVersion = (& npm -v).Trim()

  if (-not $PSBoundParameters.ContainsKey('CurrentPrefix')) {
    $prefixProbe = ((& npm config get prefix --location=user 2>$null) | Out-String).Trim()
  }
}

if (-not $PSBoundParameters.ContainsKey('DesiredPrefix') -and $prefixProbe) {
  $existingPrefix = [IO.Path]::GetFullPath($prefixProbe)
  $userRoot = [IO.Path]::GetFullPath($UserHome).TrimEnd('\') + '\'
  $npmrc = if ($env:NPM_CONFIG_USERCONFIG) { $env:NPM_CONFIG_USERCONFIG } else { Join-Path $UserHome '.npmrc' }
  $explicitPrefix = $env:NPM_CONFIG_PREFIX -or ((Test-Path -LiteralPath $npmrc -PathType Leaf) -and
    (Select-String -LiteralPath $npmrc -Pattern '^\s*prefix\s*=' -Quiet))
  if ($explicitPrefix -or $existingPrefix.StartsWith($userRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $desiredPrefixPath = $existingPrefix
  }
}
$pathEntries = Get-PathEntries -PathValue $pathProbe
$needsDirectory = -not (Test-Path -LiteralPath $desiredPrefixPath -PathType Container)
$needsPrefixUpdate = (Normalize-PathValue -Path $prefixProbe).ToLowerInvariant() -ne
  (Normalize-PathValue -Path $desiredPrefixPath).ToLowerInvariant()
$needsPathUpdate = -not (Test-PathEntryPresent -Entries $pathEntries -Expected $desiredPrefixPath)

if ($needsDirectory) {
  $plannedChanges.Add("Create npm global prefix directory at $desiredPrefixPath")
}
if ($needsPrefixUpdate) {
  $plannedChanges.Add("Set user-scoped npm prefix to $desiredPrefixPath")
}
if ($needsPathUpdate) {
  $plannedChanges.Add("Add $desiredPrefixPath to the user PATH")
}

if ($CheckOnly) {
  if ($plannedChanges.Count -gt 0) {
    $status = 'changes_required'
    $restartRequired = $needsPathUpdate
  }

  $result = [pscustomobject]@{
    helper = 'windows-npm-prefix-helper'
    mode = 'check'
    status = $status
    desiredPrefix = $desiredPrefixPath
    currentPrefix = $prefixProbe
    currentUserPath = $pathProbe
    restartRequired = $restartRequired
    plannedChanges = $plannedChanges.ToArray()
    warnings = $warnings.ToArray()
    nodeVersion = $nodeVersion
    npmVersion = $npmVersion
    appliedChanges = @()
  }
  Write-StructuredResult -Result $result -ExitCode 0
}

$appliedChanges = [System.Collections.Generic.List[string]]::new()

if ($needsDirectory) {
  New-Item -ItemType Directory -Path $desiredPrefixPath -Force | Out-Null
  $appliedChanges.Add("Created $desiredPrefixPath")
}

if ($needsPrefixUpdate) {
  & npm config set prefix "$desiredPrefixPath" --location=user | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to set npm prefix to $desiredPrefixPath"
  }
  $appliedChanges.Add("Configured npm prefix to $desiredPrefixPath")
}

if ($needsPathUpdate) {
  $updatedUserPath = if ([string]::IsNullOrWhiteSpace($pathProbe)) {
    $desiredPrefixPath
  } else {
    "$desiredPrefixPath;$pathProbe"
  }
  [System.Environment]::SetEnvironmentVariable('Path', $updatedUserPath, 'User')
  $env:Path = $updatedUserPath + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $appliedChanges.Add("Updated user PATH with $desiredPrefixPath")
}

$restartRequired = ($appliedChanges.Count -gt 0)
$finalStatus = if ($restartRequired) { 'restart_required' } else { 'ready' }
$result = [pscustomobject]@{
  helper = 'windows-npm-prefix-helper'
  mode = 'apply'
  status = $finalStatus
  desiredPrefix = $desiredPrefixPath
  currentPrefix = if ($needsPrefixUpdate) { $desiredPrefixPath } else { $prefixProbe }
  currentUserPath = if ($needsPathUpdate) {
    [System.Environment]::GetEnvironmentVariable('Path', 'User')
  } else {
    $pathProbe
  }
  restartRequired = $restartRequired
  plannedChanges = @()
  warnings = $warnings.ToArray()
  nodeVersion = $nodeVersion
  npmVersion = $npmVersion
  appliedChanges = $appliedChanges.ToArray()
}
Write-StructuredResult -Result $result -ExitCode 0
