<#
.SYNOPSIS
    Install or verify the native Windows Kimi Code CLI for Cats.

.DESCRIPTION
    Cats-owned packaged setup wrapper for Moonshot AI's Kimi Code CLI. The
    official installer (https://code.kimi.ai/kimi-code/install.ps1, the global
    mirror) places one ~160 MB kimi.exe in %USERPROFILE%\.kimi-code\bin
    (KIMI_INSTALL_DIR overrides the parent) and prepends that directory to the
    user PATH unless KIMI_NO_MODIFY_PATH is set.

    Detection, version reads and verification look only at that fixed path. A
    kimi elsewhere on PATH may be the archived Python kimi-cli (the official
    installer renames it kimi-legacy) or an npm/Homebrew build, so a PATH-only
    kimi counts as missing.

    `kimi --version` starts the whole binary, which takes 5-30 seconds on
    Windows, so it is read only when needed and with a bounded wait. -Upgrade
    asks <download site>/latest first (or KIMI_VERSION, in the installer's own
    order) and skips the 55 MB download when current.

    The official installer ends its catch block with Read-Host. The child runs
    -NonInteractive, so that prompt throws and the installer exits instead of
    waiting for a key no one can press.

    The installer renames the old kimi.exe to kimi.exe.bak, or to
    kimi.exe.<8 hex>.bak when the old backup is locked. Kimi deletes only the
    plain name on its own start, so a verified upgrade removes every unlocked
    backup here.

    Authentication is still owed after a fresh install: run `kimi login`
    (device-code flow). Mainland China accounts sign in with
    `kimi login --region mainland-cn`. Kimi Code runs shell commands through
    Git for Windows' Git Bash (KIMI_SHELL_PATH overrides); a missing Git Bash
    is reported as a warning, not a failure.

    Uninstall removes kimi.exe, its backups and the fd.exe Kimi extracts beside
    it. It never removes %USERPROFILE%\.kimi-code itself, which holds
    config.toml, credentials and sessions.
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

$KimiInstallerUrl = 'https://code.kimi.ai/kimi-code/install.ps1'
# `kimi --version` starts a 160 MB single-file binary; 30 s has been observed.
$KimiVersionProbeTimeoutMs = 60000

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

function Resolve-KimiInstallRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:KIMI_INSTALL_DIR)) { return $env:KIMI_INSTALL_DIR }
  return Join-Path $env:USERPROFILE '.kimi-code'
}

function Resolve-KimiBinDir {
  return Join-Path (Resolve-KimiInstallRoot) 'bin'
}

function Resolve-KimiExecutablePath {
  return Join-Path (Resolve-KimiBinDir) 'kimi.exe'
}

function Refresh-UserPath {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
    [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
}

function Get-KimiInstalledVersion {
  param([string]$ExecutablePath)
  if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) { return '' }
  try {
    $result = Invoke-HiddenCommand -FileName $ExecutablePath -ArgumentList @('--version') -TimeoutMs $KimiVersionProbeTimeoutMs
  } catch {
    # An antivirus block surfaces as a start failure.
    return ''
  }
  if ($result.ExitCode -ne 0) { return '' }
  return [regex]::Match("$($result.Output)", '\d+\.\d+\.\d+(?:-[A-Za-z0-9._]+)?').Value
}

function Detect-KimiInstall {
  $exePath = Resolve-KimiExecutablePath

  if ($InstallState -eq 'installed') {
    return [pscustomobject]@{
      installed = $true
      commandPath = $exePath
      detectedVersion = $DetectedVersion
    }
  }
  if ($InstallState -eq 'missing') {
    return [pscustomobject]@{
      installed = $false
      commandPath = $exePath
      detectedVersion = $DetectedVersion
    }
  }

  # Only the fixed path counts: see the header.
  $installed = Test-Path -LiteralPath $exePath -PathType Leaf
  $version = $DetectedVersion
  if ($installed -and [string]::IsNullOrWhiteSpace($version)) {
    $version = Get-KimiInstalledVersion -ExecutablePath $exePath
  }

  return [pscustomobject]@{
    installed = [bool]$installed
    commandPath = $exePath
    detectedVersion = $version
  }
}

function Add-KimiToUserPath {
  # The official installer already does this; honour its opt-out as well.
  if (-not [string]::IsNullOrWhiteSpace($env:KIMI_NO_MODIFY_PATH)) { return $false }
  $binDir = Resolve-KimiBinDir
  $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @(([string]$userPath) -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') } | Where-Object { $_ })
  if ($entries -notcontains $binDir.TrimEnd('\')) {
    if ([string]::IsNullOrWhiteSpace($userPath)) {
      [System.Environment]::SetEnvironmentVariable('Path', $binDir, 'User')
    } else {
      [System.Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
    }
  }
  Refresh-UserPath
  return $true
}

# The installer moves kimi.exe aside before copying the new one. When that
# copy fails (a full disk), only the backup is left; put it back so the
# "still at version X" report is true.
function Restore-KimiBackup {
  $exePath = Resolve-KimiExecutablePath
  if (Test-Path -LiteralPath $exePath -PathType Leaf) { return $null }
  $backup = Join-Path (Resolve-KimiBinDir) 'kimi.exe.bak'
  if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { return $null }
  try {
    Move-Item -LiteralPath $backup -Destination $exePath -ErrorAction Stop
    return 'kimi.exe disappeared during the replacement; restored the previous version from kimi.exe.bak.'
  } catch {
    return "kimi.exe disappeared during the replacement; the previous version is still at $backup."
  }
}

function Get-KimiBackupPaths {
  $binDir = Resolve-KimiBinDir
  if (-not (Test-Path -LiteralPath $binDir -PathType Container)) { return @() }
  return @(Get-ChildItem -LiteralPath $binDir -Filter 'kimi.exe*.bak' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^kimi\.exe(\.[0-9a-fA-F]{8}|\.\d+)?\.bak$' } |
    ForEach-Object { $_.FullName })
}

# Kimi's own start-up cleanup knows kimi.exe.bak and kimi.exe.<digits>.bak,
# never the kimi.exe.<hex>.bak the installer falls back to, so each upgrade
# would otherwise leave another 160 MB behind. Locked ones wait for next time.
function Remove-KimiBackups {
  $removed = 0
  foreach ($backup in (Get-KimiBackupPaths)) {
    try {
      Remove-Item -LiteralPath $backup -Force -ErrorAction Stop
      $removed++
    } catch {
      continue
    }
  }
  return $removed
}

function Test-KimiGitBash {
  if (-not [string]::IsNullOrWhiteSpace($env:KIMI_SHELL_PATH) -and (Test-Path -LiteralPath $env:KIMI_SHELL_PATH -PathType Leaf)) {
    return $true
  }
  $candidates = [System.Collections.Generic.List[string]]::new()
  $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($git -and $git.Source) {
    # git.exe usually sits in <Git>\cmd or <Git>\mingw64\bin; bash.exe is in <Git>\bin.
    $dir = Split-Path -Parent $git.Source
    for ($i = 0; $i -lt 3 -and $dir; $i++) {
      $candidates.Add((Join-Path $dir 'bin\bash.exe'))
      $dir = Split-Path -Parent $dir
    }
  }
  if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'Git\bin\bash.exe')) }
  if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')) }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $true }
  }
  return $false
}

function Invoke-KimiInstaller {
  if ($SkipInstaller) {
    return [pscustomobject]@{ skipped = $true; success = $true; exitCode = 0; stderr = '' }
  }

  $installerSource = $null
  try {
    $installerSource = Invoke-RestMethod $KimiInstallerUrl -TimeoutSec 60 -UseBasicParsing
  } catch {
    return [pscustomobject]@{
      skipped = $false
      success = $false
      exitCode = -1
      stderr = "Failed to download the Kimi Code installer: $($_.Exception.Message)"
    }
  }
  if ($installerSource -is [byte[]]) { $installerSource = [System.Text.Encoding]::UTF8.GetString($installerSource) }

  # Invoke-CatsRemoteInstaller starts the child -NonInteractive, so the
  # installer's `Read-Host "Press Enter to exit"` throws instead of waiting.
  return Invoke-CatsRemoteInstaller -ScriptText ([string]$installerSource)
}

if (-not $CheckOnly -and -not $Apply -and -not $Upgrade -and -not $Force -and -not $Uninstall) {
  $CheckOnly = $true
}

$mutationCount = @($Apply, $Upgrade, $Force | Where-Object { $_ }).Count
if ($Uninstall -and ($CheckOnly -or $mutationCount -gt 0)) {
  throw 'Install-KimiCode.ps1 -Uninstall is mutually exclusive with other modes.'
}
if ($CheckOnly -and $mutationCount -gt 0) {
  throw 'Install-KimiCode.ps1 accepts either -CheckOnly or one mutation mode.'
}
if ($mutationCount -gt 1) {
  throw 'Install-KimiCode.ps1 accepts at most one of -Apply / -Upgrade / -Force.'
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
  $extraPaths = [System.Collections.Generic.List[string]]::new()
  foreach ($backup in (Get-KimiBackupPaths)) { $extraPaths.Add($backup) }
  # Kimi extracts fd.exe into its own bin directory. Only the default tree is
  # known to be Kimi's; a custom KIMI_INSTALL_DIR may share bin with other tools.
  if ([string]::IsNullOrWhiteSpace($env:KIMI_INSTALL_DIR)) {
    $extraPaths.Add((Join-Path (Resolve-KimiBinDir) 'fd.exe'))
  }
  Invoke-PackagedProviderUninstall `
    -HelperId 'windows-kimi-native-installer' `
    -UserBinaryPath (Resolve-KimiExecutablePath) `
    -ExtraUserOwnedPaths $extraPaths.ToArray() `
    -RedetectCommand { Detect-KimiInstall } `
    -EmitJson:$Json `
    -DryRun:$DryRun
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin -and -not $AllowAdmin) {
  Write-StructuredResult -Result ([pscustomobject]@{
      helper = 'windows-kimi-native-installer'
      mode = $executionMode
      status = 'failed'
      installed = $false
      detectedVersion = $null
      commandPath = Resolve-KimiExecutablePath
      restartRequired = $false
      plannedActions = @()
      warnings = @('Refusing to run under an elevated shell without -AllowAdmin because Kimi Code CLI is intended for user-scoped installation.')
      appliedChanges = @()
      manualSteps = @()
      interruptions = @()
    }) -ExitCode 1
}

$detected = Detect-KimiInstall
$plannedActions = [System.Collections.Generic.List[string]]::new()
$appliedChanges = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$manualSteps = [System.Collections.Generic.List[string]]::new()

if ($Force) {
  $plannedActions.Add('reinstall_kimi_native')
} elseif ($Upgrade -and $detected.installed) {
  $plannedActions.Add('upgrade_kimi_native')
} elseif (-not $detected.installed) {
  $plannedActions.Add('install_kimi_native')
}

if ($CheckOnly) {
  Write-StructuredResult -Result ([pscustomobject]@{
      helper = 'windows-kimi-native-installer'
      mode = 'check'
      status = if ($detected.installed) { 'ready' } else { 'not_installed' }
      installed = [bool]$detected.installed
      detectedVersion = if ($detected.detectedVersion) { $detected.detectedVersion } else { $null }
      commandPath = $detected.commandPath
      restartRequired = $false
      plannedActions = $plannedActions.ToArray()
      warnings = @()
      appliedChanges = @()
      manualSteps = @()
      interruptions = @()
    }) -ExitCode 0
}

$catsInitialObservation = $detected.PSObject.Copy()
$wasInstalled = [bool]$detected.installed
$shouldInstall = $Force -or $Upgrade -or -not $detected.installed
if ($Upgrade -and -not $Force -and $detected.installed -and -not $SkipInstaller -and -not $DryRun) {
  $versionGate = Test-CatsNativeUpgrade -Provider 'kimi' -InstalledVersion $detected.detectedVersion
  $shouldInstall = $versionGate.shouldInstall
  if (-not $versionGate.known) { $warnings.Add('Could not compare the published version; the official installer will verify the update.') }
  if (-not $shouldInstall) { $plannedActions.Clear() }
}
$installFailed = $false
$installSkipped = $false
if ($shouldInstall) {
  if ($DryRun) {
    $warnings.Add('Dry-run requested; Kimi Code installer invocation was skipped.')
    $installSkipped = $true
  } else {
    $installResult = Invoke-KimiInstaller
    $installSkipped = [bool]$installResult.skipped
    $installFailed = (-not $installSkipped) -and (-not $installResult.success)
    if ($installSkipped) {
      $warnings.Add('Installer invocation was skipped by request.')
    } elseif ($installFailed) {
      $stderrSnippet = if ([string]::IsNullOrWhiteSpace($installResult.stderr)) {
        'no stderr captured'
      } else {
        ($installResult.stderr.Trim() -split "`r?`n" |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
          Select-Object -Last 8) -join ' | '
      }
      $warnings.Add("Kimi Code installer exited $($installResult.exitCode): $stderrSnippet")
      $restored = Restore-KimiBackup
      if ($restored) { $warnings.Add($restored) }
    }

    if (-not (Add-KimiToUserPath)) {
      $warnings.Add("KIMI_NO_MODIFY_PATH is set; add $(Resolve-KimiBinDir) to PATH yourself.")
      Refresh-UserPath
    }
    $detected = Detect-KimiInstall
    if (-not $installSkipped -and -not $installFailed) {
      if (-not $detected.installed) {
        $warnings.Add('Kimi Code installation completed but kimi.exe was not detected at the expected path.')
        $installFailed = $true
      } elseif ([string]::IsNullOrWhiteSpace($detected.detectedVersion)) {
        # Success is the version read afterwards, not the installer's exit code.
        $warnings.Add('kimi.exe is present but `kimi --version` reported no version; it may be blocked by antivirus.')
        $installFailed = $true
      } elseif ($Upgrade -or $Force) {
        $null = Remove-KimiBackups
      }
    }
  }

  if (-not $installFailed -and -not ($DryRun -and $shouldInstall)) {
    if ($Force) {
      $appliedChanges.Add('reinstall_kimi_native')
    } elseif ($Upgrade) {
      $appliedChanges.Add('upgrade_kimi_native')
    } else {
      $appliedChanges.Add('install_kimi_native')
    }
  }
}

if (-not $DryRun -and -not $installFailed -and $detected.installed -and -not (Test-KimiGitBash)) {
  $warnings.Add('Git Bash was not found. Kimi Code runs shell commands through Git for Windows; install Git or set KIMI_SHELL_PATH to bash.exe.')
}
if (-not $wasInstalled -and -not $installFailed -and -not $DryRun) {
  $manualSteps.Add('Run `kimi login` once to sign in (device-code flow). Mainland China accounts use `kimi login --region mainland-cn`.')
}
$interruptions = [System.Collections.Generic.List[object]]::new()
if ($shouldInstall -and -not $installFailed -and -not $DryRun) {
  $interruptions.Add([pscustomobject]@{
      kind = 'relaunch_required'
      summary = 'Run Detect Again after the Kimi Code install step if the command is not visible yet.'
      resumable = $true
      requiresRestart = $false
      requiresElevation = $false
    })
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
    helper = 'windows-kimi-native-installer'
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
