<#
.SYNOPSIS
    Shared utility for running child processes without visible console windows.

.DESCRIPTION
    When a packaged Electron host spawns PowerShell with CREATE_NO_WINDOW, any
    grandchild console process (powershell.exe, wsl.exe, etc.) would normally
    allocate its own visible console. This helper wraps
    System.Diagnostics.Process with CreateNoWindow = $true and proper argument
    quoting so the entire audit chain stays invisible.

    Every helper that downloads sources this file, so it also turns on TLS 1.2
    for Windows PowerShell 5.1 (see Enable-CatsTls12).
#>

# Windows PowerShell 5.1 on an early Windows 10 can still default to TLS 1.0, which
# every download host refuses. TLS 1.2 is added only to such a legacy default: 0 is
# SystemDefault, where the OS already picks TLS 1.2 or 1.3. 3072 is Tls12.
function Enable-CatsTls12 {
  $protocols = [int][Net.ServicePointManager]::SecurityProtocol
  if ($protocols -ne 0 -and -not ($protocols -band 3072)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]($protocols -bor 3072)
  }
}
Enable-CatsTls12
# A vendor installer runs in a child powershell.exe that starts from the same default,
# so its script runs this first.
$CatsTls12Prologue = "function Enable-CatsTls12 {$(${function:Enable-CatsTls12})}`nEnable-CatsTls12"

function Invoke-HiddenCommand {
  param(
    [Parameter(Mandatory)]
    [string]$FileName,

    [string[]]$ArgumentList = @(),
    [int]$TimeoutMs = 0
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FileName
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  if ($ArgumentList.Count -gt 0) {
    $psi.Arguments = ($ArgumentList | ForEach-Object {
      if ($_ -match '[\s"]') {
        '"{0}"' -f ($_ -replace '"', '\"')
      } else {
        $_
      }
    }) -join ' '
  }

  $proc = [System.Diagnostics.Process]::Start($psi)
  $outputTask = $proc.StandardOutput.ReadToEndAsync()
  $errorTask = $proc.StandardError.ReadToEndAsync()
  if ($TimeoutMs -gt 0 -and -not $proc.WaitForExit($TimeoutMs)) {
    # taskkill /T works in Windows PowerShell 5.1 as well as PowerShell 7;
    # Process.Kill(true) is unavailable in the former. Only this owned tree is killed.
    $null = Invoke-HiddenCommand -FileName (Join-Path $env:SystemRoot 'System32\taskkill.exe') -ArgumentList @('/PID', [string]$proc.Id, '/T', '/F')
    if (-not $proc.HasExited) { $proc.Kill() }
    $proc.WaitForExit()
    return [pscustomobject]@{ ExitCode = -1; Output = ''; ErrorOutput = 'Command timed out.' }
  }
  $proc.WaitForExit()
  $output = $outputTask.GetAwaiter().GetResult()
  $errorOutput = $errorTask.GetAwaiter().GetResult()

  return [pscustomobject]@{
    ExitCode    = $proc.ExitCode
    Output      = $output
    ErrorOutput = $errorOutput
  }
}

function Get-HiddenCommandText {
  param(
    [Parameter(Mandatory)]
    [string]$FileName,

    [string[]]$ArgumentList = @()
  )

  $result = Invoke-HiddenCommand -FileName $FileName -ArgumentList $ArgumentList
  $segments = [System.Collections.Generic.List[string]]::new()
  if (-not [string]::IsNullOrWhiteSpace($result.Output)) {
    $segments.Add($result.Output.Trim())
  }
  if (-not [string]::IsNullOrWhiteSpace($result.ErrorOutput)) {
    $segments.Add($result.ErrorOutput.Trim())
  }
  return ($segments -join [System.Environment]::NewLine).Trim()
}

function Resolve-HiddenVersionProbePath {
  param(
    [string]$PreferredPath = '',
    [string]$FallbackPath = ''
  )

  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($candidate in @($PreferredPath, $FallbackPath)) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }
    if (-not $seen.Add($candidate)) {
      continue
    }
    $extension = [System.IO.Path]::GetExtension($candidate)
    if ($extension -in @('.cmd', '.bat')) {
      continue
    }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }

  return $null
}
