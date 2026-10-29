<#
.SYNOPSIS
    Install or verify the native Windows Meta Muse CLI for Cats.

.DESCRIPTION
    Cats-owned packaged setup wrapper for Meta's Muse CLI. The official
    installer at https://dev.meta.ai/install.ps1 writes a muse.cmd shim plus
    .muse-launcher.ps1 into %LOCALAPPDATA%\Programs\muse (overridable with
    MUSE_INSTALL_DIR) and adds that directory to the User PATH. The launcher
    then downloads the actual agent, muse-bin-<version>.exe, beside itself and
    records the version in .muse-version.

    Two consequences drive this helper.

    Detection requires the binary, not the shim. The installer writes the shim
    and launcher first and downloads the agent last, so a run that fails in
    between leaves a shim with nothing behind it. Reporting that as installed
    would skip the reinstall that repairs it.

    The version is read from .muse-version and `muse` is never executed. The
    launcher forwards every argument straight to the agent binary, so a flag
    that binary does not recognise opens the interactive TUI instead of
    failing -- which in packaged setup, with no console a prompt can reach, is
    an unbounded hang rather than an error.
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
  [string]$DetectedVersion = '',
  [switch]$SkipInstaller
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_HiddenProcess.ps1')
. (Join-Path $PSScriptRoot '_NativeInstallerSupport.ps1')
. (Join-Path $PSScriptRoot '_PackagedUninstall.ps1')

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
    if ($Result.detectedVersion) { Write-Host "Version: $($Result.detectedVersion)" }
    foreach ($action in $Result.plannedActions) { Write-Host "Planned action: $action" }
    foreach ($warning in $Result.warnings) { Write-Host "Warning: $warning" }
    foreach ($step in $Result.manualSteps) { Write-Host "Manual step: $step" }
  }

  exit $ExitCode
}

function Resolve-MuseInstallDir {
  if (-not [string]::IsNullOrWhiteSpace($env:MUSE_INSTALL_DIR)) {
    return $env:MUSE_INSTALL_DIR
  }
  return Join-Path $env:LOCALAPPDATA 'Programs\muse'
}

function Resolve-MuseShimPath {
  return Join-Path (Resolve-MuseInstallDir) 'muse.cmd'
}

function Resolve-MuseLauncherPath {
  return Join-Path (Resolve-MuseInstallDir) '.muse-launcher.ps1'
}

function Resolve-MuseVersionFilePath {
  return Join-Path (Resolve-MuseInstallDir) '.muse-version'
}

function Get-MuseRecordedVersion {
  $versionFile = Resolve-MuseVersionFilePath
  if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) { return '' }
  try {
    $version = (Get-Content -LiteralPath $versionFile -Raw -ErrorAction Stop).Trim()
    if ([string]::IsNullOrWhiteSpace($version)) { return '' }
    return $version
  } catch {
    return ''
  }
}

function Get-MuseAgentBinaryPath {
  $version = Get-MuseRecordedVersion
  if ([string]::IsNullOrWhiteSpace($version)) { return '' }
  return Join-Path (Resolve-MuseInstallDir) "muse-bin-$version.exe"
}

# Everything the launcher owns in the install directory, so uninstall does not
# leave gigabytes of downloaded agent builds behind after removing the shim.
function Get-MuseOwnedPaths {
  $installDir = Resolve-MuseInstallDir
  $paths = [System.Collections.Generic.List[string]]::new()
  $paths.Add((Resolve-MuseLauncherPath)) | Out-Null
  if (-not (Test-Path -LiteralPath $installDir -PathType Container)) {
    return $paths.ToArray()
  }
  foreach ($pattern in @('muse-bin-*.exe', '.muse-*')) {
    foreach ($item in Get-ChildItem -LiteralPath $installDir -Filter $pattern -Force -ErrorAction SilentlyContinue) {
      if (-not $paths.Contains($item.FullName)) {
        $paths.Add($item.FullName) | Out-Null
      }
    }
  }
  return $paths.ToArray()
}

function Update-UserPathEnvironment {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
    [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
}

function Get-MuseInstallState {
  $shimPath = Resolve-MuseShimPath

  if ($InstallState -eq 'installed') {
    return [pscustomobject]@{
      installed = $true
      commandPath = $shimPath
      detectedVersion = $DetectedVersion
      partial = $false
    }
  }
  if ($InstallState -eq 'missing') {
    return [pscustomobject]@{
      installed = $false
      commandPath = $shimPath
      detectedVersion = $DetectedVersion
      partial = $false
    }
  }

  Update-UserPathEnvironment
  $version = if ([string]::IsNullOrWhiteSpace($DetectedVersion)) {
    Get-MuseRecordedVersion
  } else {
    $DetectedVersion
  }

  $shimPresent = Test-Path -LiteralPath $shimPath -PathType Leaf
  $agentBinary = Get-MuseAgentBinaryPath
  $agentPresent = (-not [string]::IsNullOrWhiteSpace($agentBinary)) -and
    (Test-Path -LiteralPath $agentBinary -PathType Leaf)

  if ($shimPresent -and $agentPresent) {
    return [pscustomobject]@{
      installed = $true
      commandPath = $shimPath
      detectedVersion = $version
      partial = $false
    }
  }

  if ($shimPresent) {
    # Shim without an agent build: the last install died partway through.
    return [pscustomobject]@{
      installed = $false
      commandPath = $shimPath
      detectedVersion = $version
      partial = $true
    }
  }

  # Nothing in the expected directory, but the operator may have muse elsewhere.
  $command = Get-Command muse -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return [pscustomobject]@{
      installed = $true
      commandPath = $command.Source
      detectedVersion = $version
      partial = $false
    }
  }

  return [pscustomobject]@{
    installed = $false
    commandPath = $shimPath
    detectedVersion = $version
    partial = $false
  }
}

function Add-MuseToUserPath {
  $installDir = Resolve-MuseInstallDir
  $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrWhiteSpace($userPath)) {
    [System.Environment]::SetEnvironmentVariable('Path', $installDir, 'User')
  } elseif ($userPath -notlike "*$installDir*") {
    [System.Environment]::SetEnvironmentVariable('Path', "$installDir;$userPath", 'User')
  }
  Update-UserPathEnvironment
}

function Invoke-MuseInstaller {
  if ($SkipInstaller) {
    return [pscustomobject]@{ skipped = $true; success = $true; exitCode = 0; stderr = '' }
  }

  $tempScript = [System.IO.Path]::Combine(
    [System.IO.Path]::GetTempPath(),
    "cats-muse-install-$([System.Guid]::NewGuid().ToString('N')).ps1"
  )
  $stdoutPath = "$tempScript.stdout"
  $stderrPath = "$tempScript.stderr"
  # The official install.ps1 opens with Set-StrictMode -Version Latest and calls
  # exit 1 on failure, so it runs in its own process rather than taking this
  # script down with it.
  $bootstrap = @'
& {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    Invoke-RestMethod 'https://dev.meta.ai/install.ps1' | Invoke-Expression
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}
'@

  try {
    [System.IO.File]::WriteAllText(
      $tempScript,
      $bootstrap,
      [System.Text.UTF8Encoding]::new($false)
    )
    # The muse launcher runs under Windows PowerShell 5.1. A PSModulePath
    # inherited from PowerShell 7 breaks its download step and leaves a shim
    # with no agent build, so the installer is run under 5.1 as well.
    $powerShellExe = 'powershell.exe'
    $process = Start-Process -FilePath $powerShellExe `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tempScript) `
      -Wait -PassThru -NoNewWindow `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath
    $stderrRaw = if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
      Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
    } else { $null }

    return [pscustomobject]@{
      skipped = $false
      success = ($process.ExitCode -eq 0)
      exitCode = $process.ExitCode
      stderr = if ($null -eq $stderrRaw) { '' } else { [string]$stderrRaw }
    }
  } catch {
    return [pscustomobject]@{
      skipped = $false
      success = $false
      exitCode = -1
      stderr = "Failed to invoke Meta Muse installer: $($_.Exception.Message)"
    }
  } finally {
    foreach ($path in @($tempScript, $stdoutPath, $stderrPath)) {
      if (Test-Path -LiteralPath $path -PathType Leaf) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

if (-not $CheckOnly -and -not $Apply -and -not $Upgrade -and -not $Force -and -not $Uninstall) {
  $CheckOnly = $true
}

$mutationCount = @($Apply, $Upgrade, $Force | Where-Object { $_ }).Count
if ($Uninstall -and ($CheckOnly -or $mutationCount -gt 0)) {
  throw 'Install-MetaCli.ps1 -Uninstall is mutually exclusive with other modes.'
}
if ($CheckOnly -and $mutationCount -gt 0) {
  throw 'Install-MetaCli.ps1 accepts either -CheckOnly or one mutation mode.'
}
if ($mutationCount -gt 1) {
  throw 'Install-MetaCli.ps1 accepts at most one of -Apply / -Upgrade / -Force.'
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

if ($Uninstall) {
  Invoke-PackagedProviderUninstall `
    -HelperId 'windows-muse-native-installer' `
    -UserBinaryPath (Resolve-MuseShimPath) `
    -ExtraUserOwnedPaths (Get-MuseOwnedPaths) `
    -RedetectCommand { Get-MuseInstallState } `
    -EmitJson:$Json `
    -DryRun:$DryRun
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin -and -not $AllowAdmin) {
  Write-StructuredResult -Result ([pscustomobject]@{
      helper = 'windows-muse-native-installer'
      mode = $executionMode
      status = 'failed'
      installed = $false
      detectedVersion = $null
      commandPath = Resolve-MuseShimPath
      restartRequired = $false
      plannedActions = @()
      warnings = @('Refusing to run under an elevated shell without -AllowAdmin because Meta Muse CLI is intended for user-scoped installation.')
      appliedChanges = @()
      manualSteps = @()
      interruptions = @()
    }) -ExitCode 1
}

$detected = Get-MuseInstallState
$plannedActions = [System.Collections.Generic.List[string]]::new()
$appliedChanges = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$manualSteps = [System.Collections.Generic.List[string]]::new()

if ($detected.partial) {
  $warnings.Add('Found muse.cmd with no matching muse-bin-<version>.exe; the previous install did not finish and will be repaired.') | Out-Null
}

if ($Force) {
  $plannedActions.Add('reinstall_muse_native') | Out-Null
} elseif ($Upgrade -and $detected.installed) {
  $plannedActions.Add('upgrade_muse_native') | Out-Null
} elseif (-not $detected.installed) {
  $plannedActions.Add('install_muse_native') | Out-Null
}

if ($CheckOnly) {
  Write-StructuredResult -Result ([pscustomobject]@{
      helper = 'windows-muse-native-installer'
      mode = 'check'
      status = if ($detected.installed) { 'ready' } else { 'not_installed' }
      installed = [bool]$detected.installed
      detectedVersion = if ($detected.detectedVersion) { $detected.detectedVersion } else { $null }
      commandPath = $detected.commandPath
      restartRequired = $false
      plannedActions = $plannedActions.ToArray()
      warnings = $warnings.ToArray()
      appliedChanges = @()
      manualSteps = @()
      interruptions = @()
    }) -ExitCode 0
}

$installFailed = $false
$catsInitialObservation = $detected.PSObject.Copy()
$shouldInstall = $Force -or $Upgrade -or -not $detected.installed
$installFailed = $false
$installSkipped = $false
if ($shouldInstall) {
  if ($DryRun) {
    $warnings.Add('Dry-run requested; Meta Muse installer invocation was skipped.') | Out-Null
    $installSkipped = $true
  } else {
    $previousVersion = $detected.detectedVersion
    $installResult = Invoke-MuseInstaller
    $installSkipped = [bool]$installResult.skipped
    $installFailed = (-not $installSkipped) -and (-not $installResult.success)
    if ($installSkipped) {
      $warnings.Add('Installer invocation was skipped by request.') | Out-Null
    } elseif ($installFailed) {
      $stderrSnippet = if ([string]::IsNullOrWhiteSpace($installResult.stderr)) {
        'no stderr captured'
      } else {
        ($installResult.stderr.Trim() -split "`r?`n" |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
          Select-Object -Last 8) -join ' | '
      }
      $warnings.Add("Meta Muse installer exited $($installResult.exitCode): $stderrSnippet") | Out-Null
    }

    Start-Sleep -Seconds 3
    Add-MuseToUserPath
    $detected = Get-MuseInstallState
    if (-not $detected.installed -and -not $installSkipped -and -not $installFailed) {
      if ($detected.partial) {
        $warnings.Add('Meta Muse installation wrote muse.cmd but the launcher did not fetch muse-bin-<version>.exe.') | Out-Null
      } else {
        $warnings.Add('Meta Muse installation completed but muse.cmd was not found at the expected path.') | Out-Null
      }
      $installFailed = $true
    } elseif (
      $Upgrade -and $detected.installed -and $previousVersion -and
      $detected.detectedVersion -eq $previousVersion
    ) {
      $warnings.Add("Meta Muse CLI is already on the latest build: $($detected.detectedVersion).") | Out-Null
    }
  }

  if (-not $installFailed -and -not ($DryRun -and $shouldInstall)) {
    if ($Force) {
      $appliedChanges.Add('reinstall_muse_native') | Out-Null
    } elseif ($Upgrade) {
      $appliedChanges.Add('upgrade_muse_native') | Out-Null
    } else {
      $appliedChanges.Add('install_muse_native') | Out-Null
    }
  }
}

$manualSteps.Add('Run `muse login` once to sign in to a Meta account; the credential is stored in ~/.config/muse/auth.json.') | Out-Null
$interruptions = [System.Collections.Generic.List[object]]::new()
if ($shouldInstall -and -not $installFailed -and -not $DryRun) {
  $interruptions.Add([pscustomobject]@{
      kind = 'relaunch_required'
      summary = 'Run Detect Again after the Meta Muse install step if the command is not visible yet.'
      resumable = $true
      requiresRestart = $false
      requiresElevation = $false
    }) | Out-Null
}

$status = if ($installFailed) {
  'failed'
} elseif ($DryRun -and $shouldInstall) {
  'preview'
} elseif ($interruptions.Count -gt 0) {
  [string]$interruptions[0].kind
} else {
  'ready'
}

Write-StructuredResult -Result ([pscustomobject]@{
    helper = 'windows-muse-native-installer'
    mode = $executionMode
    status = $status
    installed = [bool]$detected.installed
    detectedVersion = if ($detected.detectedVersion) { $detected.detectedVersion } else { $null }
    commandPath = $detected.commandPath
    restartRequired = $false
    plannedActions = $plannedActions.ToArray()
    warnings = $warnings.ToArray()
    appliedChanges = $appliedChanges.ToArray()
    manualSteps = $manualSteps.ToArray()
    interruptions = $interruptions.ToArray()
  }) -ExitCode $(if ($installFailed) { 1 } else { 0 })
