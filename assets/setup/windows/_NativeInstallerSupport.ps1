<#
.SYNOPSIS
    Shared native installer version gates, isolated child execution and observed results.
.DESCRIPTION
    Dot-source from the packaged native helpers. Metadata parsing is adapted from
    environment-bootstrap at 752dc13; no query occurs during check-only actions.
    Vendor scripts execute in a hidden child so an upstream exit cannot end our JSON response.
.EXAMPLE
    . "$PSScriptRoot\_NativeInstallerSupport.ps1"
    Test-CatsNativeUpgrade -Provider grok -InstalledVersion '1.0.0'
#>
. (Join-Path $PSScriptRoot '_HiddenProcess.ps1')

function Get-CatsNativeLatestVersion {
  param([string]$Provider)
  try {
    switch ($Provider) {
      antigravity { return Get-AntigravityLatestVersion }
      cursor { return Get-CursorAgentLatestVersion -InstallerText (Invoke-RestMethod 'https://cursor.com/install?win32=true' -TimeoutSec 20 -UseBasicParsing) }
      junie { return Get-JunieLatestBuild }
      devin { return Get-DevinLatestVersion }
      grok { return Get-GrokLatestVersion }
      kiro { return [string](Invoke-RestMethod 'https://prod.download.cli.kiro.dev/stable/latest/manifest.json' -TimeoutSec 20 -UseBasicParsing).version }
      goose { return [string](Invoke-RestMethod 'https://api.github.com/repos/aaif-goose/goose/releases/latest' -TimeoutSec 20 -UseBasicParsing -Headers @{ 'User-Agent' = 'Cats-Desktop'; Accept = 'application/vnd.github+json' }).tag_name }
      default { return $null }
    }
  } catch { return $null }
}

function Get-CatsNativeVersionToken {
  param([string]$Provider, [string]$Version)
  if ($Provider -eq 'junie') {
    $match = [regex]::Match($Version, '\((\d+(?:\.\d+)+)\)')
    if ($match.Success) { return $match.Groups[1].Value }
    return ''
  }
  return [regex]::Match($Version, '\d+(?:\.\d+)+(?:-[a-zA-Z0-9.]+)?').Value
}

function Test-CatsNativeUpgrade {
  param([string]$Provider, [string]$InstalledVersion, [AllowNull()][string]$LatestVersion = $null)
  if (-not $PSBoundParameters.ContainsKey('LatestVersion')) { $LatestVersion = Get-CatsNativeLatestVersion $Provider }
  $current = Get-CatsNativeVersionToken $Provider $InstalledVersion
  $comparison = Compare-ToolVersion -Installed $current -Latest $LatestVersion
  $known = $null -ne $comparison
  $currentRelease = $known -and ($comparison -ge 0)
  if ($Provider -eq 'cursor' -and $comparison -eq 0 -and $current -ne $LatestVersion) { $currentRelease = $false }
  return [pscustomobject]@{ shouldInstall = -not $currentRelease; latestVersion = $LatestVersion; known = $known }
}

function Invoke-CatsRemoteInstaller {
  param([Parameter(Mandatory)][string]$ScriptText, [switch]$RetrySharingViolation)
  $temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('cats-native-' + [guid]::NewGuid().ToString('N') + '.ps1')
  try {
    if ([string]::IsNullOrWhiteSpace($ScriptText)) { throw 'Vendor returned an empty installer.' }
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($ScriptText, [ref]$null, [ref]$null)
    $offsets = @(0)
    if ($ast.ParamBlock) { $offsets += $ast.ParamBlock.Extent.EndOffset }
    foreach ($usingStatement in $ast.UsingStatements) { $offsets += $usingStatement.Extent.EndOffset }
    $offset = ($offsets | Measure-Object -Maximum).Maximum
    $prologue = '$env:PSModulePath = (@([System.Environment]::GetEnvironmentVariable(''PSModulePath'',''User''), [System.Environment]::GetEnvironmentVariable(''PSModulePath'',''Machine''), (Join-Path $PSHOME ''Modules'')) | Where-Object { $_ }) -join '';'''
    $body = $ScriptText.Insert($offset, "`n$prologue`n")
    if ($RetrySharingViolation) {
      $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body))
      $body = @'
$ErrorActionPreference = 'Stop'
$installer = [scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__SOURCE__')))
for ($attempt = 1; $attempt -le 3; $attempt++) {
  try { & $installer; exit 0 }
  catch {
    $exception = $_.Exception
    while ($exception.InnerException) { $exception = $exception.InnerException }
    if ($attempt -eq 3 -or -not ($exception -is [IO.IOException]) -or ($exception.HResult -band 0xffff) -ne 32) { throw }
    Start-Sleep -Seconds 5
  }
}
'@
      $body = $body.Replace('__SOURCE__', $encoded)
    }
    [IO.File]::WriteAllText($temporary, $body, [Text.UTF8Encoding]::new($true))
    $hostExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $result = Invoke-HiddenCommand -FileName $hostExe -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $temporary)
    return [pscustomobject]@{ skipped = $false; success = $result.ExitCode -eq 0; exitCode = $result.ExitCode; stderr = $result.ErrorOutput; stdout = $result.Output }
  } catch {
    return [pscustomobject]@{ skipped = $false; success = $false; exitCode = -1; stderr = [string]$_.Exception.Message }
  } finally {
    # This is one uniquely-created file; never recursively remove a computed directory.
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Add-CatsNativeObservation {
  param([pscustomobject]$Result, [AllowNull()]$Before, [bool]$Attempted, [bool]$Skipped)
  if ($Result.mode -in @('check', 'uninstall') -or $null -eq $Before) { return }
  $change = if ($Result.status -eq 'failed') { 'failed' }
    elseif ($Skipped -or $Result.status -eq 'preview' -or -not $Attempted) { 'unchanged' }
    elseif (-not $Result.installed) { 'failed' }
    elseif (-not $Before.installed) { 'installed' }
    elseif ($Before.detectedVersion -and $Result.detectedVersion -and $Before.detectedVersion -ne $Result.detectedVersion) {
      $comparison = Compare-ToolVersion -Installed $Result.detectedVersion -Latest $Before.detectedVersion
      if ($comparison -gt 0) { 'upgraded' } elseif ($comparison -lt 0) { 'downgraded' } else { 'version_changed' }
    }
    else { 'unchanged' }
  if ($Result.mode -in @('upgrade', 'force') -and -not $Skipped -and $Result.status -ne 'preview' -and $change -ne 'failed' -and $Result.installed -and $Result.detectedVersion) {
    $provider = $Result.helper -replace '^windows-', '' -replace '-native-installer$', ''
    if ($provider -in @('cursor', 'devin', 'junie')) {
      try { Remove-CatsStaleNativeVersions -Provider $provider -Version $Result.detectedVersion } catch { Write-Warning 'Old-version cleanup was skipped.' }
    }
  }
  $Result | Add-Member -NotePropertyName observedChange -NotePropertyValue $change -Force
  $Result | Add-Member -NotePropertyName previousVersion -NotePropertyValue $Before.detectedVersion -Force
  $description = "$change"
  if ($change -in @('upgraded', 'downgraded', 'version_changed')) { $description += ": $($Before.detectedVersion) -> $($Result.detectedVersion)" }
  elseif ($Result.detectedVersion) { $description += ": $($Result.detectedVersion)" }
  $Result | Add-Member -NotePropertyName summary -NotePropertyValue $description -Force
  if ($change -in @('failed', 'unchanged')) { $Result.appliedChanges = @() }
  else { $Result.appliedChanges = @("${change}_native_installation") }
}

function Write-CatsNativePreview {
  param([string]$Helper, [string]$Mode, $Detected, [string[]]$Actions, [bool]$EmitJson)
  $result = [pscustomobject]@{
    helper = $Helper; mode = $Mode; status = 'preview'; installed = [bool]$Detected.installed
    detectedVersion = $Detected.detectedVersion; commandPath = $Detected.commandPath
    restartRequired = $false; plannedActions = @($Actions); appliedChanges = @()
    warnings = @(); manualSteps = @(); interruptions = @(); observedChange = 'unchanged'
  }
  if ($EmitJson) { $result | ConvertTo-Json -Depth 10 } else { Write-Host "Preview: $($Actions -join ', ')" }
  exit 0
}

function Get-CatsShimVersionText {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $literal = "'" + $Path.Replace("'", "''") + "'"
  $script = "& $literal --version; exit " + '$LASTEXITCODE'
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $hostExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $result = Invoke-HiddenCommand -FileName $hostExe -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -TimeoutMs 15000
  if ($result.ExitCode -ne 0) { return '' }
  return $result.Output.Trim()
}

function Remove-CatsStaleNativeVersions {
  param([string]$Provider, [string]$Version)
  $keep = Get-CatsNativeVersionToken $Provider $Version
  if (-not $keep) { return }
  $data = switch ($Provider) {
    cursor { Join-Path $env:LOCALAPPDATA 'cursor-agent' }
    devin { Join-Path $env:LOCALAPPDATA 'devin\cli' }
    junie {
      if ($env:JUNIE_DATA_DIR) { $env:JUNIE_DATA_DIR } else { Join-Path $env:USERPROFILE '.local\share\junie' }
    }
    default { return }
  }
  $versions = [IO.Path]::GetFullPath((Join-Path $data $(if ($Provider -eq 'devin') { '_versions' } else { 'versions' })))
  if ($Provider -eq 'junie') {
    if (Test-Path -LiteralPath (Join-Path $data 'updates\pending-update.json')) { return }
    $currentFile = Join-Path $data 'current'
    if (-not (Test-Path -LiteralPath $currentFile -PathType Leaf)) { return }
    if ((Get-Content -LiteralPath $currentFile -Raw).Trim() -ne $keep) { return }
  }
  # Only known user roots; do not follow a junction in any ancestor or delete
  # current/newer/pending builds. A custom directory outside those roots is kept.
  if (-not (Test-PackagedProviderPathRemovable $versions)) { return }
  $ancestor = Get-Item -LiteralPath $versions
  while ($ancestor) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
    $ancestor = $ancestor.Parent
  }
  foreach ($directory in (Get-ChildItem -LiteralPath $versions -Directory)) {
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    if ($directory.Name -notmatch '^\d+(\.\d+)+(-[a-zA-Z0-9]+)?$') { continue }
    if ((Compare-ToolVersion -Installed $directory.Name -Latest $keep) -ne -1) { continue }
    $resolved = [IO.Path]::GetFullPath($directory.FullName)
    if (-not $resolved.StartsWith($versions.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (Get-ChildItem -LiteralPath $resolved -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1) { continue }
    try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop } catch { Write-Warning "Could not remove old $Provider version $($directory.Name)." }
  }
}
function ConvertTo-ComparableVersion {
    param([string]$Version)

    if ([string]::IsNullOrWhiteSpace($Version)) { return $null }

    # 第一個版本樣式的 token；額外吃下 Git for Windows 的 .windows.N 尾段
    $match = [regex]::Match($Version, '\d+(?:\.\d+)+(?:\.windows\.\d+)?')
    if (-not $match.Success) { return $null }

    $parts = ($match.Value -replace '\.windows\.', '.') -split '\.' |
        Select-Object -First 4

    while ($parts.Count -lt 4) { $parts += '0' }

    try {
        return [version]($parts -join '.')
    } catch {
        return $null
    }
}

function Compare-ToolVersion {
    param(
        [string]$Installed,
        [string]$Latest
    )

    $installedVersion = ConvertTo-ComparableVersion $Installed
    $latestVersion    = ConvertTo-ComparableVersion $Latest

    if (-not $installedVersion -or -not $latestVersion) { return $null }

    return $installedVersion.CompareTo($latestVersion)
}

function Get-AntigravityLatestVersion {
    param([string]$InstallerText)

    $baseUrl = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
    if ($InstallerText) {
        $m = [regex]::Match($InstallerText, '\$DOWNLOAD_BASE_URL\s*=\s*"(https://[^"]+)"')
        if ($m.Success) { $baseUrl = $m.Groups[1].Value }
    }

    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $platform = if ($arch -eq 'ARM64') { 'windows_arm64' } else { 'windows_amd64' }

    try {
        $manifest = Invoke-RestMethod -Uri "$baseUrl/manifests/$platform.json" -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
        if (-not $manifest.version) { return $null }
        return "$($manifest.version)"
    } catch {
        return $null
    }
}

function Get-CursorAgentLatestVersion {
    param(
        [Parameter(Mandatory=$true)]
        [string]$InstallerText
    )

    $m = [regex]::Match($InstallerText, "(?m)^\s*\`$version\s*=\s*'([^']+)'")
    if (-not $m.Success) { return $null }
    return $m.Groups[1].Value
}

function Get-JunieLatestBuild {
    $archName = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'aarch64' } else { 'amd64' }
    $platform = "windows-$archName"

    try {
        $jsonl = Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/jetbrains-junie/junie/main/update-info.jsonl' `
            -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
    } catch {
        return $null
    }

    $best = $null
    foreach ($line in ("$jsonl" -split "`n")) {
        if ($line -notmatch "`"platform`":`"$platform`"") { continue }
        try { $entry = $line | ConvertFrom-Json } catch { continue }
        if (-not $entry.version) { continue }
        $candidate = ConvertTo-ComparableVersion "$($entry.version)"
        if (-not $candidate) { continue }
        if ($null -eq $best -or $candidate -gt $best.Comparable) {
            $best = @{ Build = "$($entry.version)"; Comparable = $candidate }
        }
    }

    if ($null -eq $best) { return $null }
    return $best.Build
}

function Get-DevinLatestVersion {
    try {
        $manifest = Invoke-RestMethod -Uri 'https://static.devin.ai/cli/current/manifest.json' -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
        if (-not $manifest.version) { return $null }
        return "$($manifest.version)"
    } catch {
        return $null
    }
}

function Get-GrokLatestVersion {
    param([string]$Channel)

    if (-not $Channel) {
        $Channel = if ($env:GROK_CHANNEL) { $env:GROK_CHANNEL } else { 'stable' }
    }

    $urls = @(
        "https://x.ai/cli/$Channel",
        "https://storage.googleapis.com/grok-build-public-artifacts/cli/$Channel"
    )
    foreach ($url in $urls) {
        try {
            $text = Invoke-RestMethod -Uri $url -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
        } catch {
            continue
        }
        $line = @("$text" -split "`r?`n")[0]
        if ($null -eq $line) { continue }
        $line = $line.Trim()
        if ($line -match '^\d+\.\d+\.\d+(-[A-Za-z0-9._]+)?$') { return $line }
    }
    return $null
}
