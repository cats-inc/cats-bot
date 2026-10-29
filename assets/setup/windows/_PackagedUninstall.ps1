<#
.SYNOPSIS
    Shared uninstall flow for packaged Windows provider helpers.

.DESCRIPTION
    Each `Install-*.ps1` provider helper calls `Invoke-PackagedProviderUninstall`
    with its helper id, the user-scoped executable to remove, optional extra
    paths the provider also drops in user-owned locations, and a redetect
    callback that re-checks whether any install (system or otherwise) still
    remains after user-owned paths are removed. The function emits the same
    structured JSON shape as install/upgrade actions and exits the calling
    script.

    Auth files, API keys, package-manager configuration, and shell profiles are
    left untouched on purpose. If the caller has provider-specific cleanup
    (legacy npm shims, app bundles, etc.) it should run them and append entries
    to `appliedChanges` / `warnings` lists before invoking this helper.
#>

if (-not (Get-Module -ListAvailable -Name Microsoft.PowerShell.Utility)) {
  # Ensures structured JSON conversion is available even on minimal hosts.
}

function Test-PackagedProviderPathRemovable {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $withinUserRoot = $false
  foreach ($base in @($env:USERPROFILE, $env:LOCALAPPDATA)) {
    if (-not $base) { continue }
    $root = [IO.Path]::GetFullPath($base).TrimEnd('\', '/') + '\'
    if ($fullPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $withinUserRoot = $true }
  }
  if (-not $withinUserRoot) { return $false }
  return (Test-Path -LiteralPath $fullPath)
}

function Test-DetectedPathInPlannedRemovals {
  param(
    [string]$DetectedPath,
    [string[]]$PlannedPaths
  )
  if ([string]::IsNullOrWhiteSpace($DetectedPath)) { return $false }
  if (-not $PlannedPaths -or $PlannedPaths.Count -eq 0) { return $false }
  $detectedNorm = $DetectedPath.TrimEnd([char]'\', [char]'/')
  $cmp = [System.StringComparison]::OrdinalIgnoreCase
  foreach ($planned in $PlannedPaths) {
    if ([string]::IsNullOrWhiteSpace($planned)) { continue }
    $plannedNorm = $planned.TrimEnd([char]'\', [char]'/')
    if ([string]::Equals($detectedNorm, $plannedNorm, $cmp)) { return $true }
    $startsBack = $detectedNorm.StartsWith("$plannedNorm\", $cmp)
    $startsFwd = $detectedNorm.StartsWith("$plannedNorm/", $cmp)
    if ($startsBack -or $startsFwd) { return $true }
  }
  return $false
}

function Remove-PackagedProviderPath {
  param(
    [string]$Path,
    [System.Collections.Generic.List[string]]$AppliedChanges,
    [System.Collections.Generic.List[string]]$Warnings
  )

  if (-not (Test-PackagedProviderPathRemovable -Path $Path)) {
    return
  }

  try {
    Remove-Item -LiteralPath $Path -Force -Recurse -ErrorAction Stop
    $AppliedChanges.Add("removed:$Path") | Out-Null
  } catch {
    $Warnings.Add("failed_to_remove:$Path") | Out-Null
  }
}

function Invoke-PackagedProviderUninstall {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HelperId,

    [Parameter(Mandatory = $true)]
    [string]$UserBinaryPath,

    [string[]]$ExtraUserOwnedPaths = @(),

    [scriptblock]$RedetectCommand = $null,

    [switch]$EmitJson,

    [switch]$DryRun,

    [int]$ExitCode = 0
  )

  $plannedActions = [System.Collections.Generic.List[string]]::new()
  $appliedChanges = [System.Collections.Generic.List[string]]::new()
  $warnings = [System.Collections.Generic.List[string]]::new()
  $manualSteps = [System.Collections.Generic.List[string]]::new()

  $allPaths = [System.Collections.Generic.List[string]]::new()
  if (Test-PackagedProviderPathRemovable -Path $UserBinaryPath) {
    $allPaths.Add($UserBinaryPath) | Out-Null
  }
  foreach ($extra in $ExtraUserOwnedPaths) {
    if (Test-PackagedProviderPathRemovable -Path $extra) {
      if (-not $allPaths.Contains($extra)) {
        $allPaths.Add($extra) | Out-Null
      }
    }
  }

  $remainingCommandPath = $null
  $remainingInstalled = $false
  if ($null -ne $RedetectCommand) {
    try {
      $detectedBefore = & $RedetectCommand
      if ($null -ne $detectedBefore -and $detectedBefore.installed) {
        $remainingInstalled = $true
        if ($detectedBefore.commandPath) {
          $remainingCommandPath = $detectedBefore.commandPath
        }
      }
    } catch {
      # Detection callback failures are not fatal; treat as unknown.
    }
  }

  foreach ($path in $allPaths) {
    $plannedActions.Add("remove:$path") | Out-Null
  }

  if ($DryRun) {
    $detectedIsExternal = $false
    if ($remainingInstalled -and $remainingCommandPath) {
      $detectedInPlanned = Test-DetectedPathInPlannedRemovals `
        -DetectedPath $remainingCommandPath `
        -PlannedPaths $allPaths.ToArray()
      if (-not $detectedInPlanned) {
        $detectedIsExternal = $true
        $warnings.Add("system_install_remains_at:$remainingCommandPath") | Out-Null
        $manualSteps.Add("System install at $remainingCommandPath cannot be removed by this helper; uninstall it through its installer.") | Out-Null
      }
    }
    $previewStatus = if ($allPaths.Count -eq 0 -and -not $detectedIsExternal) {
      'not_installed'
    } else {
      'preview'
    }
    $result = [pscustomobject]@{
      helper = $HelperId
      mode = 'uninstall'
      status = $previewStatus
      installed = [bool]$remainingInstalled
      detectedVersion = $null
      commandPath = if ($remainingCommandPath) { $remainingCommandPath } else { $UserBinaryPath }
      restartRequired = $false
      plannedActions = $plannedActions.ToArray()
      warnings = $warnings.ToArray()
      appliedChanges = @()
      manualSteps = $manualSteps.ToArray()
      interruptions = @()
    }
    if ($EmitJson) {
      $result | ConvertTo-Json -Depth 10
    } else {
      Write-Host "Mode: uninstall (dry-run)"
      Write-Host "Status: $previewStatus"
      foreach ($entry in $plannedActions) { Write-Host "Planned: $entry" }
    }
    exit $ExitCode
  }

  if ($allPaths.Count -eq 0 -and -not $remainingInstalled) {
    $result = [pscustomobject]@{
      helper = $HelperId
      mode = 'uninstall'
      status = 'not_installed'
      installed = $false
      detectedVersion = $null
      commandPath = $UserBinaryPath
      restartRequired = $false
      plannedActions = @()
      warnings = @()
      appliedChanges = @()
      manualSteps = @()
      interruptions = @()
    }
    if ($EmitJson) {
      $result | ConvertTo-Json -Depth 10
    } else {
      Write-Host "Mode: uninstall"
      Write-Host "Status: not_installed"
    }
    exit $ExitCode
  }

  foreach ($path in $allPaths) {
    Remove-PackagedProviderPath -Path $path -AppliedChanges $appliedChanges -Warnings $warnings
  }

  if ($null -ne $RedetectCommand) {
    try {
      $detectedAfter = & $RedetectCommand
      if ($null -ne $detectedAfter -and $detectedAfter.installed) {
        $remainingInstalled = $true
        if ($detectedAfter.commandPath) {
          $remainingCommandPath = $detectedAfter.commandPath
        }
      } else {
        $remainingInstalled = $false
        $remainingCommandPath = $null
      }
    } catch {
      # Treat as unknown
    }
  }

  $finalStatus = if ($remainingInstalled) {
    if ($remainingCommandPath) {
      $warnings.Add("system_install_remains_at:$remainingCommandPath") | Out-Null
      $manualSteps.Add("Remove the remaining install at $remainingCommandPath using its installer or package manager.") | Out-Null
    } else {
      $warnings.Add('system_install_remains') | Out-Null
    }
    'changes_required'
  } elseif ($warnings.Count -gt 0) {
    'changes_required'
  } else {
    'uninstalled'
  }

  $result = [pscustomobject]@{
    helper = $HelperId
    mode = 'uninstall'
    status = $finalStatus
    installed = [bool]$remainingInstalled
    detectedVersion = $null
    commandPath = if ($remainingCommandPath) { $remainingCommandPath } else { $UserBinaryPath }
    restartRequired = $false
    plannedActions = $plannedActions.ToArray()
    warnings = $warnings.ToArray()
    appliedChanges = $appliedChanges.ToArray()
    manualSteps = $manualSteps.ToArray()
    interruptions = @()
  }

  if ($EmitJson) {
    $result | ConvertTo-Json -Depth 10
  } else {
    Write-Host "Mode: uninstall"
    Write-Host "Status: $finalStatus"
    foreach ($a in $appliedChanges) { Write-Host "Applied change: $a" }
    foreach ($w in $warnings) { Write-Host "Warning: $w" }
  }
  exit $ExitCode
}
