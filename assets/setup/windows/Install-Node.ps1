<#
.SYNOPSIS
    Install or upgrade Node.js LTS for the packaged Cats Windows host.

.DESCRIPTION
    Adapts the environment-bootstrap Install-NodeJS-Admin.ps1 flow into the
    packaged-helper contract used by Settings>Runtime. The helper installs
    Node.js LTS via winget when available and falls back to the official
    nodejs.org MSI when winget cannot drive the install. A successful install
    also brings npm, which the rest of the npm-global CLI helpers depend on.

    Node.js installs into Program Files and therefore needs Administrator
    rights for the actual mutation. CheckOnly stays user-scoped so the
    Settings>Runtime UI can probe state without prompting for UAC. When
    -Apply / -Upgrade / -Force is used, the helper self-elevates through
    Start-Process -Verb RunAs unless it is already running elevated.

    -Uninstall is intentionally omitted: removing Node.js mid-flight would
    break the packaged Cats runtime and every npm-global CLI helper, so
    uninstalling it must remain a manual step.
#>
param(
  [switch]$CheckOnly,
  [switch]$Apply,
  [switch]$Upgrade,
  [switch]$Force,
  [switch]$Json,
  [switch]$DryRun,
  [ValidateSet('auto', 'installed', 'missing')]
  [string]$InstallState = 'auto',
  [string]$DetectedVersion = '',
  [switch]$SkipNodeProbe,
  [switch]$SkipElevation,
  [string]$ResultRelayPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_HiddenProcess.ps1')

$HelperId = 'windows-node-host-installer'
$DisplayName = 'Node.js LTS'
$WingetPackageId = 'OpenJS.NodeJS.LTS'
$NodeDistIndexUrl = 'https://nodejs.org/dist/index.json'

function Write-StructuredResult {
  param(
    [pscustomobject]$Result,
    [int]$ExitCode
  )

  $payload = $Result | ConvertTo-Json -Depth 10

  if (-not [string]::IsNullOrEmpty($ResultRelayPath)) {
    [System.IO.File]::WriteAllText($ResultRelayPath, $payload)
  }

  if ($Json) {
    $payload
  } else {
    Write-Host "Helper: $($Result.helper)"
    Write-Host "Mode: $($Result.mode)"
    Write-Host "Status: $($Result.status)"
    Write-Host "Installed: $($Result.installed)"
    if ($Result.detectedVersion) {
      Write-Host "Detected version: $($Result.detectedVersion)"
    }
    foreach ($warning in $Result.warnings) {
      Write-Warning $warning
    }
    foreach ($change in $Result.plannedActions) {
      Write-Host "Planned action: $change"
    }
  }

  exit $ExitCode
}

function New-Result {
  param(
    [string]$Mode,
    [string]$Status,
    [bool]$Installed,
    [string]$DetectedVersion = '',
    [string]$CommandPath = '',
    [string[]]$PlannedActions = @(),
    [string[]]$AppliedChanges = @(),
    [string[]]$Warnings = @(),
    [string[]]$ManualSteps = @(),
    [object[]]$Interruptions = @()
  )

  return [pscustomobject]@{
    helper = $HelperId
    displayName = $DisplayName
    mode = $Mode
    status = $Status
    installed = $Installed
    commandPath = $CommandPath
    detectedVersion = $DetectedVersion
    plannedActions = $PlannedActions
    appliedChanges = $AppliedChanges
    warnings = $Warnings
    manualSteps = $ManualSteps
    interruptions = $Interruptions
  }
}

function Resolve-NodeCommandPath {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    return ''
  }
  return [string]$cmd.Source
}

function Get-NodeDetectedVersion {
  param(
    [string]$Override
  )

  if (-not [string]::IsNullOrWhiteSpace($Override)) {
    return $Override
  }

  if ($SkipNodeProbe) {
    return ''
  }

  try {
    $raw = (& node -v 2>$null)
    if ([string]::IsNullOrWhiteSpace($raw)) {
      return ''
    }
    return ($raw -replace '^v', '').Trim()
  } catch {
    return ''
  }
}

function Test-NodeInstalled {
  param(
    [string]$Mode
  )

  if ($InstallState -eq 'installed') {
    return $true
  }
  if ($InstallState -eq 'missing') {
    return $false
  }

  if ($SkipNodeProbe) {
    return $false
  }

  return [bool](Get-Command node -ErrorAction SilentlyContinue) -and
    [bool](Get-Command npm -ErrorAction SilentlyContinue)
}

if (-not $CheckOnly -and -not $Apply -and -not $Upgrade -and -not $Force) {
  $CheckOnly = $true
}

$mutationCount = @($Apply, $Upgrade, $Force | Where-Object { $_ }).Count
if ($CheckOnly -and $mutationCount -gt 0) {
  throw 'Install-Node.ps1 accepts either -CheckOnly or one mutation mode.'
}
if ($mutationCount -gt 1) {
  throw 'Install-Node.ps1 accepts at most one of -Apply / -Upgrade / -Force.'
}

$mode = if ($CheckOnly) {
  'check'
} elseif ($Force) {
  'force'
} elseif ($Upgrade) {
  'upgrade'
} else {
  'apply'
}

# Each invocation inherits the long-lived Desktop host's environment. Include
# newly installed system/user commands before check-only detection as well.
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
  [System.Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
$installed = Test-NodeInstalled -Mode $mode
$detected = Get-NodeDetectedVersion -Override $DetectedVersion
$commandPath = if ($SkipNodeProbe) { '' } else { Resolve-NodeCommandPath }

if ($mode -eq 'check') {
  $status = if ($installed) { 'ready' } else { 'changes_required' }
  $planned = if ($installed) { @() } else { @('install_node_lts') }
  Write-StructuredResult -Result (New-Result `
    -Mode $mode `
    -Status $status `
    -Installed $installed `
    -DetectedVersion $detected `
    -CommandPath $commandPath `
    -PlannedActions $planned `
  ) -ExitCode 0
}

if ($mode -eq 'apply' -and $installed) {
  Write-StructuredResult -Result (New-Result `
    -Mode $mode `
    -Status 'ready' `
    -Installed $true `
    -DetectedVersion $detected `
    -CommandPath $commandPath `
  ) -ExitCode 0
}

# Self-elevate for mutation operations
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $SkipElevation) {
  # Relay the elevated child's structured result through a temp file so the
  # parent (which inherits the un-elevated stdout pipe) can re-emit the JSON
  # without losing it to the elevated console window.
  $relayPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(),
    "cats-helper-relay-$([System.Guid]::NewGuid().ToString('N')).json")

  $relayArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($CheckOnly) { $relayArgs += '-CheckOnly' }
  if ($Apply) { $relayArgs += '-Apply' }
  if ($Upgrade) { $relayArgs += '-Upgrade' }
  if ($Force) { $relayArgs += '-Force' }
  if ($DryRun) { $relayArgs += '-DryRun' }
  if ($Json) { $relayArgs += '-Json' }
  if ($PSBoundParameters.ContainsKey('InstallState')) { $relayArgs += @('-InstallState', $InstallState) }
  if ($PSBoundParameters.ContainsKey('DetectedVersion')) { $relayArgs += @('-DetectedVersion', $DetectedVersion) }
  if ($SkipNodeProbe) { $relayArgs += '-SkipNodeProbe' }
  $relayArgs += '-SkipElevation'
  $relayArgs += @('-ResultRelayPath', $relayPath)

  try {
    $process = Start-Process -FilePath 'powershell.exe' `
      -ArgumentList $relayArgs `
      -Verb RunAs `
      -Wait `
      -PassThru
    if ([System.IO.File]::Exists($relayPath)) {
      $relayed = [System.IO.File]::ReadAllText($relayPath)
      [System.IO.File]::Delete($relayPath)
      if ($Json -and -not [string]::IsNullOrWhiteSpace($relayed)) {
        Write-Output $relayed
      } elseif (-not $Json -and -not [string]::IsNullOrWhiteSpace($relayed)) {
        try {
          $relayedResult = $relayed | ConvertFrom-Json
          Write-Host "Helper: $($relayedResult.helper)"
          Write-Host "Mode: $($relayedResult.mode)"
          Write-Host "Status: $($relayedResult.status)"
        } catch {
          # If the child crashed before writing, fall through to the synthesized failure result below.
        }
      }
    }
    exit $process.ExitCode
  } catch {
    if ([System.IO.File]::Exists($relayPath)) {
      [System.IO.File]::Delete($relayPath)
    }
    Write-StructuredResult -Result (New-Result `
      -Mode $mode `
      -Status 'changes_required' `
      -Installed $installed `
      -DetectedVersion $detected `
      -CommandPath $commandPath `
      -Warnings @('Administrator elevation was cancelled or failed.') `
      -Interruptions @([pscustomobject]@{ kind = 'elevation_required'; reason = $_.Exception.Message }) `
    ) -ExitCode 1
  }
}

# === Elevated execution path ===
$applied = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$installSuccess = $false

$wingetExists = [bool](Get-Command winget -ErrorAction SilentlyContinue)

if ($wingetExists -and -not $SkipNodeProbe) {
  try {
    $wingetArgs = if ($mode -eq 'upgrade' -and $installed) {
      @('upgrade', '--id', $WingetPackageId, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements')
    } else {
      $args = @('install', '--id', $WingetPackageId, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements')
      if ($mode -eq 'force') {
        $args += '--force'
      }
      $args
    }

    $wingetResult = Invoke-HiddenCommand -FileName 'winget' -ArgumentList $wingetArgs
    $wingetExit = $wingetResult.ExitCode

    # Winget exit codes: 0 = success; -1978335189 (0x8A15002B) = already up-to-date; 1 = no upgrade available
    if ($wingetExit -eq 0) {
      $installSuccess = $true
      $applied.Add("winget_${mode}_${WingetPackageId}")
    } elseif ($wingetExit -eq -1978335189 -or ($mode -eq 'upgrade' -and $wingetExit -eq 1)) {
      $installSuccess = $true
      $applied.Add("already_up_to_date_${WingetPackageId}")
    } else {
      $warnings.Add("winget exited $wingetExit; falling back to direct download.")
    }
  } catch {
    $warnings.Add("winget invocation failed: $($_.Exception.Message); falling back to direct download.")
  }
}

if (-not $installSuccess -and -not $SkipNodeProbe) {
  try {
    $releases = Invoke-RestMethod -Uri $NodeDistIndexUrl -UseBasicParsing -TimeoutSec 30
    $ltsRelease = $releases | Where-Object { $_.lts -ne $false } | Select-Object -First 1
    if ($null -eq $ltsRelease) {
      throw 'No LTS release found in the Node.js dist index.'
    }
    $ltsVersion = $ltsRelease.version -replace '^v', ''
    $msiUrl = "https://nodejs.org/dist/v$ltsVersion/node-v$ltsVersion-x64.msi"
    $msiPath = Join-Path $env:TEMP "node-v$ltsVersion-x64.msi"

    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
    $applied.Add("downloaded_msi_v$ltsVersion")

    $msiArgs = @('/i', $msiPath, '/qn', '/norestart')
    if ($mode -eq 'force') {
      $msiArgs += @('REINSTALLMODE=vamus', 'REINSTALL=ALL')
    }

    $msiResult = Invoke-HiddenCommand -FileName 'msiexec.exe' -ArgumentList $msiArgs
    if ($msiResult.ExitCode -eq 0) {
      $installSuccess = $true
      $applied.Add("msi_install_v$ltsVersion")
    } else {
      $warnings.Add("msiexec exited $($msiResult.ExitCode).")
    }
  } catch {
    $warnings.Add("Direct download failed: $($_.Exception.Message)")
  }
}

if (-not $installSuccess) {
  Write-StructuredResult -Result (New-Result `
    -Mode $mode `
    -Status 'failed' `
    -Installed $installed `
    -DetectedVersion $detected `
    -CommandPath $commandPath `
    -AppliedChanges $applied.ToArray() `
    -Warnings $warnings.ToArray() `
    -ManualSteps @('Install Node.js LTS manually from https://nodejs.org/.') `
  ) -ExitCode 1
}

# Refresh PATH so subsequent helpers can find the new node binary
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
  [System.Environment]::GetEnvironmentVariable('Path', 'User')

$postCommandPath = Resolve-NodeCommandPath
$postVersion = Get-NodeDetectedVersion -Override ''

Write-StructuredResult -Result (New-Result `
  -Mode $mode `
  -Status 'ready' `
  -Installed $true `
  -DetectedVersion $postVersion `
  -CommandPath $postCommandPath `
  -AppliedChanges $applied.ToArray() `
  -Warnings $warnings.ToArray() `
  -Interruptions @([pscustomobject]@{ kind = 'relaunch_required'; reason = 'PATH was extended; relaunch downstream tools.' }) `
) -ExitCode 0
