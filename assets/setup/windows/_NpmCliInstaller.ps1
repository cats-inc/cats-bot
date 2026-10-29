<#
.SYNOPSIS
    Shared install/upgrade/uninstall flow for packaged Windows npm-global CLI providers.

.DESCRIPTION
    Each `Install-<Provider>.ps1` thin wrapper for an npm-global CLI
    (Codex, Copilot, OpenCode, Kilo, Auggie, Pi, ...) calls
    `Invoke-PackagedNpmCliInstall` with its npm package id, primary
    command name on PATH, and helper id. The function honours the same
    packaged-host helper contract as the native installers
    (CheckOnly / Apply / Upgrade / Force / Uninstall / DryRun / Json /
    AllowAdmin) so the renderer-side lifecycle UI does not need to know
    which CLI is npm-backed vs native.

    The helper rejects elevated execution by default — npm packages
    installed under admin land in admin-scoped paths and break the
    regular user's PATH. Pass -AllowAdmin only from a true Administrator
    account that has no companion user profile.

    npm prefix readiness is the prerequisite; this helper does not run
    Setup-NodeGlobalPrefix.ps1 itself. The Settings>Runtime contract
    keeps the prefix helper as a separate registered asset so the user
    can run it explicitly when needed.
#>

. (Join-Path $PSScriptRoot '_VerifiedNpmUpdate.ps1')

function Test-NpmCliInstallerAdminGuard {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HelperId,
    [string]$DisplayName,
    [switch]$EmitJson,
    [switch]$AllowAdmin,
    [string]$Mode
  )

  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
    IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    return $true
  }
  if ($AllowAdmin) {
    return $true
  }

  $label = if ($DisplayName) { $DisplayName } else { $HelperId }
  $result = [pscustomobject]@{
    helper = $HelperId
    mode = $Mode
    status = 'failed'
    installed = $false
    detectedVersion = $null
    commandPath = $null
    restartRequired = $false
    plannedActions = @()
    warnings = @(
      "Refusing to run $label under an elevated shell without -AllowAdmin because npm-global CLIs are user-scoped."
    )
    appliedChanges = @()
    manualSteps = @()
    interruptions = @()
  }
  if ($EmitJson) {
    $result | ConvertTo-Json -Depth 10
  } else {
    Write-Host "Mode: $Mode"
    Write-Host "Status: failed"
    foreach ($warning in $result.warnings) {
      Write-Host "Warning: $warning"
    }
  }
  exit 1
}

function Test-NpmCliRuntimeAvailable {
  return [bool](Get-Command npm -ErrorAction SilentlyContinue)
}

function Write-NpmCliMissingResult {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HelperId,
    [Parameter(Mandatory = $true)]
    [string]$Mode,
    [Parameter(Mandatory = $true)]
    [string]$DisplayName,
    [switch]$EmitJson
  )

  $isQuery = $Mode -in @('check', 'uninstall')
  $status = if ($isQuery) { 'not_installed' } else { 'failed' }
  $exitCode = if ($isQuery) { 0 } else { 1 }
  $result = [pscustomobject]@{
    helper = $HelperId
    mode = $Mode
    status = $status
    installed = $false
    detectedVersion = $null
    commandPath = $null
    restartRequired = $false
    plannedActions = @()
    warnings = @("Node.js and npm must be installed before $DisplayName can be installed.")
    appliedChanges = @()
    manualSteps = @('Run the Node.js host installer first to install Node.js LTS.')
    interruptions = @()
  }
  if ($EmitJson) {
    $result | ConvertTo-Json -Depth 10
  } else {
    Write-Host "Mode: $Mode"
    Write-Host "Status: $status"
    foreach ($warning in $result.warnings) {
      Write-Host "Warning: $warning"
    }
  }
  exit $exitCode
}

function Test-NpmCliPackageInstalled {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PackageName,
    [Parameter(Mandatory = $true)]
    [string]$CommandName
  )

  if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
    return $true
  }
  if (-not (Test-NpmCliRuntimeAvailable)) {
    return $false
  }
  & npm list -g --depth=0 $PackageName 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Get-NpmCliPackageVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  $listRaw = (& npm list -g --depth=0 --json $PackageName 2>$null) | Out-String
  if ([string]::IsNullOrWhiteSpace($listRaw)) {
    return $null
  }
  try {
    $listData = $listRaw | ConvertFrom-Json
    if ($null -ne $listData.dependencies) {
      $entry = $listData.dependencies.PSObject.Properties[$PackageName]
      if ($null -ne $entry -and $null -ne $entry.Value -and $entry.Value.PSObject.Properties.Name -contains 'version') {
        return [string]$entry.Value.version
      }
    }
  } catch {
    return $null
  }
  return $null
}

function Test-NpmCliPackageOutdated {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  $latest = ((& npm view "$PackageName@latest" version --fetch-retries=0 --fetch-timeout=10000 --loglevel=error) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $latest -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$') { throw 'Provider version query failed; update status is unknown.' }
  $installed = Get-NpmCliPackageVersion -PackageName $PackageName
  if (-not $installed) { return $true }
  $currentBase = [version]($installed -split '-')[0]
  $latestBase = [version]($latest -split '-')[0]
  # Preserve a newer local/pre-release build. Equal numeric prerelease advances
  # to the stable release; Repair remains the explicit reinstall action.
  return $currentBase -lt $latestBase -or ($currentBase -eq $latestBase -and $installed.Contains('-') -and -not $latest.Contains('-'))

}

function Resolve-NpmCliCommandPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CommandName
  )

  $command = Get-Command $CommandName -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return $command.Source
  }
  return $null
}

function Get-SupersededNpmPackages {
  <#
    Packages whose npm name changed upstream. npm resolves an abandoned name to
    its final published version and reports it as current forever, so
    `npm outdated -g` never flags it and every upgrade path silently skips it.
    Two packages shipping the same bin also fight over the shim, which resolves
    to whichever installed last. The superseded package is therefore removed
    before its replacement is installed, matching environment-bootstrap cfe7785.
  #>
  param(
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  switch ($PackageName) {
    '@earendil-works/pi-coding-agent' { @('@mariozechner/pi-coding-agent') }
    default { @() }
  }
}

function Remove-SupersededNpmPackages {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PackageName,
    [System.Collections.ArrayList]$AppliedChanges
  )

  foreach ($legacy in (Get-SupersededNpmPackages -PackageName $PackageName)) {
    & npm list -g --depth=0 $legacy 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { continue }

    Write-Host "Removing superseded package $legacy (replaced by $PackageName)."
    & npm uninstall -g $legacy 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not remove superseded package $legacy." }
    if ($AppliedChanges) {
      $AppliedChanges.Add("${legacy}:removed-superseded") | Out-Null
    }
  }
}

function Invoke-PackagedNpmCliInstall {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HelperId,

    [Parameter(Mandatory = $true)]
    [string]$PackageName,

    [Parameter(Mandatory = $true)]
    [string]$CommandName,

    [Parameter(Mandatory = $true)]
    [string]$DisplayName,

    [switch]$CheckOnly,
    [switch]$Apply,
    [switch]$Upgrade,
    [switch]$Force,
    [switch]$Uninstall,
    [switch]$DryRun,
    [switch]$Json,
    [switch]$AllowAdmin,

    # Test overrides; production callers leave these unset.
    [ValidateSet('auto', 'installed', 'missing')]
    [string]$InstallState = 'auto',
    [ValidateSet('auto', 'outdated', 'current')]
    [string]$OutdatedState = 'auto',
    [string]$DetectedVersion = '',
    [switch]$SkipNpmInvocation
  )

  if (-not $CheckOnly -and -not $Apply -and -not $Upgrade -and -not $Force -and -not $Uninstall) {
    $CheckOnly = $true
  }

  if ($Uninstall -and ($CheckOnly -or $Apply -or $Upgrade -or $Force)) {
    throw "$HelperId -Uninstall is mutually exclusive with other modes."
  }
  if ($CheckOnly -and ($Apply -or $Upgrade -or $Force)) {
    throw "$HelperId accepts either -CheckOnly or one mutation mode."
  }
  if ($Force -and $Upgrade) {
    $Upgrade = $false
  }

  $mode = if ($Uninstall) {
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

  Test-NpmCliInstallerAdminGuard `
    -HelperId $HelperId `
    -DisplayName $DisplayName `
    -EmitJson:$Json `
    -AllowAdmin:$AllowAdmin `
    -Mode $mode | Out-Null

  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
    [System.Environment]::GetEnvironmentVariable('Path', 'Machine')

  if (-not $SkipNpmInvocation -and -not (Test-NpmCliRuntimeAvailable)) {
    Write-NpmCliMissingResult -HelperId $HelperId -Mode $mode -DisplayName $DisplayName -EmitJson:$Json
  }

  $installed = switch ($InstallState) {
    'installed' { $true }
    'missing'   { $false }
    default {
      if ($SkipNpmInvocation) {
        # Without npm probing the helper cannot decide on its own; default to
        # missing so callers must pass an explicit -InstallState override.
        $false
      } else {
        Test-NpmCliPackageInstalled -PackageName $PackageName -CommandName $CommandName
      }
    }
  }
  $detectedVersion = if (-not [string]::IsNullOrWhiteSpace($DetectedVersion)) {
    $DetectedVersion
  } elseif ($installed -and -not $SkipNpmInvocation) {
    Get-NpmCliPackageVersion -PackageName $PackageName
  } else {
    $null
  }
  $commandPath = if ($installed) { Resolve-NpmCliCommandPath -CommandName $CommandName } else { $null }
  if ($installed -and -not $detectedVersion -and -not $SkipNpmInvocation) {
    foreach ($legacy in (Get-SupersededNpmPackages -PackageName $PackageName)) {
      & npm list -g --depth=0 $legacy 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $installed = $false; break }
    }
  }

  $plannedActions = [System.Collections.Generic.List[string]]::new()
  $appliedChanges = [System.Collections.Generic.List[string]]::new()
  $warnings = [System.Collections.Generic.List[string]]::new()
  $manualSteps = [System.Collections.Generic.List[string]]::new()

  if ($Uninstall) {
    if (-not $installed) {
      $result = [pscustomobject]@{
        helper = $HelperId
        mode = 'uninstall'
        status = 'not_installed'
        installed = $false
        detectedVersion = $null
        commandPath = $null
        restartRequired = $false
        plannedActions = @()
        warnings = @()
        appliedChanges = @()
        manualSteps = @()
        interruptions = @()
      }
      if ($Json) {
        $result | ConvertTo-Json -Depth 10
      } else {
        Write-Host "Mode: uninstall"
        Write-Host "Status: not_installed"
      }
      exit 0
    }

    $plannedActions.Add("${PackageName}:uninstall") | Out-Null

    if ($DryRun) {
      $result = [pscustomobject]@{
        helper = $HelperId
        mode = 'uninstall'
        status = 'preview'
        installed = $true
        detectedVersion = $detectedVersion
        commandPath = $commandPath
        restartRequired = $false
        plannedActions = $plannedActions.ToArray()
        warnings = @()
        appliedChanges = @()
        manualSteps = @()
        interruptions = @()
      }
      if ($Json) {
        $result | ConvertTo-Json -Depth 10
      } else {
        Write-Host "Mode: uninstall (dry-run)"
        Write-Host "Status: preview"
        foreach ($entry in $plannedActions) { Write-Host "Planned: $entry" }
      }
      exit 0
    }

    if ($SkipNpmInvocation) {
      $result = [pscustomobject]@{
        helper = $HelperId
        mode = 'uninstall'
        status = 'changes_required'
        installed = $true
        detectedVersion = $detectedVersion
        commandPath = $commandPath
        restartRequired = $false
        plannedActions = $plannedActions.ToArray()
        warnings = @('Skipped npm invocation (-SkipNpmInvocation); uninstall was not executed.')
        appliedChanges = @()
        manualSteps = @()
        interruptions = @()
      }
      if ($Json) {
        $result | ConvertTo-Json -Depth 10
      } else {
        Write-Host "Mode: uninstall"
        Write-Host "Status: changes_required"
        Write-Host "Warning: Skipped npm invocation; uninstall was not executed."
      }
      exit 0
    }

    try {
      & npm uninstall -g $PackageName | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $appliedChanges.Add("${PackageName}:uninstalled") | Out-Null
      } else {
        $warnings.Add("${PackageName}:uninstall_failed_exit_$LASTEXITCODE") | Out-Null
      }
    } catch {
      $warnings.Add("${PackageName}:uninstall_failed") | Out-Null
    }

    $stillInstalled = Test-NpmCliPackageInstalled -PackageName $PackageName -CommandName $CommandName
    $finalStatus = if ($stillInstalled) {
      $warnings.Add("${PackageName}:still_installed_after_uninstall") | Out-Null
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
      installed = [bool]$stillInstalled
      detectedVersion = $null
      commandPath = if ($stillInstalled) { Resolve-NpmCliCommandPath -CommandName $CommandName } else { $null }
      restartRequired = $false
      plannedActions = $plannedActions.ToArray()
      warnings = $warnings.ToArray()
      appliedChanges = $appliedChanges.ToArray()
      manualSteps = @()
      interruptions = @()
    }
    if ($Json) {
      $result | ConvertTo-Json -Depth 10
    } else {
      Write-Host "Mode: uninstall"
      Write-Host "Status: $finalStatus"
      foreach ($entry in $appliedChanges) { Write-Host "Applied: $entry" }
      foreach ($warning in $warnings) { Write-Host "Warning: $warning" }
    }
    exit 0
  }

  if ($DryRun -and -not $CheckOnly) {
    $preview = [pscustomobject]@{
      helper = $HelperId; mode = $mode; status = 'preview'; installed = [bool]$installed
      detectedVersion = $detectedVersion; commandPath = $commandPath; restartRequired = $false
      plannedActions = @("${PackageName}:${mode}"); appliedChanges = @(); warnings = @(); manualSteps = @(); interruptions = @()
    }
    if ($Json) { $preview | ConvertTo-Json -Depth 10 } else { Write-Host "Preview: ${PackageName}:${mode}" }
    exit 0
  }
  if ($Upgrade -and -not $CheckOnly -and -not $SkipNpmInvocation) { Update-CatsNpm }

  $isOutdated = if (-not $Upgrade -and -not $Force) {
    $false
  } else {
    switch ($OutdatedState) {
      'outdated' { $true }
      'current'  { $false }
      default {
        if ($SkipNpmInvocation) {
          $false
        } else {
          Test-NpmCliPackageOutdated -PackageName $PackageName
        }
      }
    }
  }

  $plannedAction = if ($Force) {
    'reinstall'
  } elseif (-not $installed) {
    'install'
  } elseif ($Upgrade -and $isOutdated) {
    'upgrade'
  } else {
    'skip'
  }

  if ($plannedAction -ne 'skip') {
    $plannedActions.Add("${PackageName}:${plannedAction}") | Out-Null
  }

  if ($CheckOnly) {
    $checkStatus = if ($installed -and -not $isOutdated) { 'ready' } else { 'changes_required' }
    $result = [pscustomobject]@{
      helper = $HelperId
      mode = 'check'
      status = $checkStatus
      installed = [bool]$installed
      detectedVersion = $detectedVersion
      commandPath = $commandPath
      restartRequired = $false
      plannedActions = $plannedActions.ToArray()
      warnings = @()
      appliedChanges = @()
      manualSteps = @()
      interruptions = @()
    }
    if ($Json) {
      $result | ConvertTo-Json -Depth 10
    } else {
      Write-Host "Mode: check"
      Write-Host "Status: $checkStatus"
      Write-Host "Installed: $installed"
      if ($detectedVersion) { Write-Host "Version: $detectedVersion" }
    }
    exit 0
  }

  if ($plannedAction -eq 'skip') {
    $result = [pscustomobject]@{
      helper = $HelperId
      mode = $mode
      status = 'ready'
      installed = $true
      detectedVersion = $detectedVersion
      commandPath = $commandPath
      restartRequired = $false
      plannedActions = @()
      warnings = @()
      appliedChanges = @()
      manualSteps = @()
      interruptions = @()
    }
    if ($Json) {
      $result | ConvertTo-Json -Depth 10
    } else {
      Write-Host "Mode: $mode"
      Write-Host "Status: ready"
      if ($detectedVersion) { Write-Host "Version: $detectedVersion" }
    }
    exit 0
  }

  if ($SkipNpmInvocation) {
    # Test/audit override: refuse to fake a successful mutation. Honor the
    # caller-provided InstallState/DetectedVersion/OutdatedState as the
    # final state and report what would have happened rather than what did.
    # Status reflects the mutation that would still be required: if the
    # plannedAction is anything other than 'skip' we have NOT reached
    # ready, even when the package was already installed.
    $previewStatus = if ($plannedAction -eq 'skip') { 'ready' } else { 'changes_required' }
    $previewWarning = "Skipped npm invocation (-SkipNpmInvocation); mutation was not executed."
    $result = [pscustomobject]@{
      helper = $HelperId
      mode = $mode
      status = $previewStatus
      installed = [bool]$installed
      detectedVersion = $detectedVersion
      commandPath = $commandPath
      restartRequired = $false
      plannedActions = $plannedActions.ToArray()
      warnings = @($previewWarning)
      appliedChanges = @()
      manualSteps = @()
      interruptions = @()
    }
    if ($Json) {
      $result | ConvertTo-Json -Depth 10
    } else {
      Write-Host "Mode: $mode"
      Write-Host "Status: $previewStatus"
      Write-Host "Warning: $previewWarning"
    }
    exit 0
  }

  Remove-SupersededNpmPackages -PackageName $PackageName -AppliedChanges $appliedChanges

  # --include=optional defends against user-level `omit=optional` in npmrc.
  # Without it, packages like @openai/codex skip their platform-specific
  # binaries (codex-win32-x64, codex-darwin-arm64, ...), leaving a shim that
  # silently exits when invoked. Pure-JS CLIs such as copilot don't notice.
  $expectedVersion = ((& npm view "$PackageName@latest" version --fetch-retries=0 --fetch-timeout=10000 --loglevel=error) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $expectedVersion -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$') { throw 'Could not resolve the provider version before installing.' }
  $arguments = @('install', '-g', '--include=optional', '--engine-strict', '--fetch-retries=0', '--fetch-timeout=30000', "$PackageName@$expectedVersion")

  & npm @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to $plannedAction $PackageName (npm exit code $LASTEXITCODE)."
  }
  $appliedChanges.Add("${PackageName}:${plannedAction}") | Out-Null

  $finalInstalled = Test-NpmCliPackageInstalled -PackageName $PackageName -CommandName $CommandName
  $finalCommandPath = if ($finalInstalled) { Resolve-NpmCliCommandPath -CommandName $CommandName } else { $null }
  $finalVersion = if ($finalInstalled) { Get-NpmCliPackageVersion -PackageName $PackageName } else { $null }

  if (-not $finalInstalled -or -not $finalCommandPath -or $finalVersion -ne $expectedVersion) { throw 'Provider installation verification failed. Check npm prefix and command PATH.' }

  $result = [pscustomobject]@{
    helper = $HelperId
    mode = $mode
    status = 'ready'
    installed = [bool]$finalInstalled
    detectedVersion = $finalVersion
    commandPath = $finalCommandPath
    restartRequired = $false
    plannedActions = $plannedActions.ToArray()
    warnings = @()
    appliedChanges = $appliedChanges.ToArray()
    manualSteps = @()
    interruptions = @()
  }
  if ($Json) {
    $result | ConvertTo-Json -Depth 10
  } else {
    Write-Host "Mode: $mode"
    Write-Host "Status: ready"
    foreach ($entry in $appliedChanges) { Write-Host "Applied: $entry" }
  }
  exit 0
}
