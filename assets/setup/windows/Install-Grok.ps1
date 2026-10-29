<#
.SYNOPSIS
    Install or verify the native Windows Grok CLI for Cats.

.DESCRIPTION
    Cats-owned packaged setup wrapper for xAI's Grok CLI. The official
    installer places grok.exe and an agent.exe alias in
    %USERPROFILE%\.grok\bin. Detection intentionally uses only grok; uninstall
    removes only those two fixed installer-owned paths and never resolves a
    generic agent command from PATH.
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

function Resolve-GrokInstallDir {
  return Join-Path $env:USERPROFILE '.grok\bin'
}

function Resolve-GrokExecutablePath {
  return Join-Path (Resolve-GrokInstallDir) 'grok.exe'
}

function Resolve-GrokInstallerAliasPath {
  return Join-Path (Resolve-GrokInstallDir) 'agent.exe'
}

function Refresh-UserPath {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
    [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
}

function Detect-GrokInstall {
  $exePath = Resolve-GrokExecutablePath

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

  Refresh-UserPath
  $command = Get-Command grok -ErrorAction SilentlyContinue
  $installed = $null -ne $command -or (Test-Path -LiteralPath $exePath -PathType Leaf)
  $commandPath = if ($null -ne $command) { $command.Source } else { $exePath }
  $commandSource = if ($null -ne $command) { $command.Source } else { '' }
  $version = $DetectedVersion
  $versionProbePath = Resolve-HiddenVersionProbePath `
    -PreferredPath $commandSource `
    -FallbackPath $exePath

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

function Add-GrokToUserPath {
  $installDir = Resolve-GrokInstallDir
  $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrWhiteSpace($userPath)) {
    [System.Environment]::SetEnvironmentVariable('Path', $installDir, 'User')
  } elseif ($userPath -notlike "*$installDir*") {
    [System.Environment]::SetEnvironmentVariable('Path', "$installDir;$userPath", 'User')
  }
  Refresh-UserPath
}

function Invoke-GrokInstaller {
  if ($SkipInstaller) {
    return [pscustomobject]@{ skipped = $true; success = $true; exitCode = 0; stderr = '' }
  }

  $tempScript = [System.IO.Path]::Combine(
    [System.IO.Path]::GetTempPath(),
    "cats-grok-install-$([System.Guid]::NewGuid().ToString('N')).ps1"
  )
  $stdoutPath = "$tempScript.stdout"
  $stderrPath = "$tempScript.stderr"
  $bootstrap = @'
& {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    Invoke-RestMethod 'https://x.ai/cli/install.ps1' | Invoke-Expression
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
    $powerShellExe = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) {
      'pwsh.exe'
    } else {
      'powershell.exe'
    }
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
      stderr = "Failed to invoke Grok installer: $($_.Exception.Message)"
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
  throw 'Install-Grok.ps1 -Uninstall is mutually exclusive with other modes.'
}
if ($CheckOnly -and $mutationCount -gt 0) {
  throw 'Install-Grok.ps1 accepts either -CheckOnly or one mutation mode.'
}
if ($mutationCount -gt 1) {
  throw 'Install-Grok.ps1 accepts at most one of -Apply / -Upgrade / -Force.'
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
    -HelperId 'windows-grok-native-installer' `
    -UserBinaryPath (Resolve-GrokExecutablePath) `
    -ExtraUserOwnedPaths @((Resolve-GrokInstallerAliasPath)) `
    -RedetectCommand { Detect-GrokInstall } `
    -EmitJson:$Json `
    -DryRun:$DryRun
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin -and -not $AllowAdmin) {
  Write-StructuredResult -Result ([pscustomobject]@{
      helper = 'windows-grok-native-installer'
      mode = $executionMode
      status = 'failed'
      installed = $false
      detectedVersion = $null
      commandPath = Resolve-GrokExecutablePath
      restartRequired = $false
      plannedActions = @()
      warnings = @('Refusing to run under an elevated shell without -AllowAdmin because Grok CLI is intended for user-scoped installation.')
      appliedChanges = @()
      manualSteps = @()
      interruptions = @()
    }) -ExitCode 1
}

$detected = Detect-GrokInstall
$plannedActions = [System.Collections.Generic.List[string]]::new()
$appliedChanges = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$manualSteps = [System.Collections.Generic.List[string]]::new()

if ($Force) {
  $plannedActions.Add('reinstall_grok_native')
} elseif ($Upgrade -and $detected.installed) {
  $plannedActions.Add('upgrade_grok_native')
} elseif (-not $detected.installed) {
  $plannedActions.Add('install_grok_native')
}

if ($CheckOnly) {
  Write-StructuredResult -Result ([pscustomobject]@{
      helper = 'windows-grok-native-installer'
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

$installFailed = $false
$catsInitialObservation = $detected.PSObject.Copy()
$shouldInstall = $Force -or $Upgrade -or -not $detected.installed
if ($Upgrade -and -not $Force -and $detected.installed -and -not $SkipInstaller -and -not $DryRun) {
  $versionGate = Test-CatsNativeUpgrade -Provider 'grok' -InstalledVersion $detected.detectedVersion
  $shouldInstall = $versionGate.shouldInstall
  if (-not $versionGate.known) { $warnings.Add('Could not compare the published version; the official installer will verify the update.') }
  if (-not $shouldInstall) { $plannedActions.Clear() }
}
$installFailed = $false
$installSkipped = $false
if ($shouldInstall) {
  if ($DryRun) {
    $warnings.Add('Dry-run requested; Grok installer invocation was skipped.')
    $installSkipped = $true
  } else {
    $installResult = Invoke-GrokInstaller
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
      $warnings.Add("Grok installer exited $($installResult.exitCode): $stderrSnippet")
    }

    Start-Sleep -Seconds 2
    Add-GrokToUserPath
    $detected = Detect-GrokInstall
    if (-not $detected.installed -and -not $installSkipped -and -not $installFailed) {
      $warnings.Add('Grok installation completed but grok.exe was not detected at the expected path.')
      $installFailed = $true
    }
  }

  if (-not $installFailed -and -not ($DryRun -and $shouldInstall)) {
    if ($Force) {
      $appliedChanges.Add('reinstall_grok_native')
    } elseif ($Upgrade) {
      $appliedChanges.Add('upgrade_grok_native')
    } else {
      $appliedChanges.Add('install_grok_native')
    }
  }
}

$manualSteps.Add('Run `grok login` or set XAI_API_KEY before first use.')
$interruptions = [System.Collections.Generic.List[object]]::new()
if ($shouldInstall -and -not $installFailed -and -not $DryRun) {
  $interruptions.Add([pscustomobject]@{
      kind = 'relaunch_required'
      summary = 'Run Detect Again after the Grok install step if the command is not visible yet.'
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
    helper = 'windows-grok-native-installer'
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
