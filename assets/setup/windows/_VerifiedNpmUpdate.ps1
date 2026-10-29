<#
.SYNOPSIS
    Update npm in its current prefix with bounded queries and post-install verification.
.DESCRIPTION
    Dot-source and invoke Update-CatsNpm only for an explicit upgrade action.
    Adapted from environment-bootstrap 4690075. Never changes prefix or bypasses engines.
.EXAMPLE
    Update-CatsNpm
#>
function Update-CatsNpm {
  $current = ((& npm --version) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not read npm version.' }
  $latest = ((& npm view npm@latest version --fetch-retries=0 --fetch-timeout=10000 --loglevel=error) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $latest -notmatch '^\d+\.\d+\.\d+$') { throw 'npm version query failed or returned an invalid version.' }
  if ($current -eq $latest) { return }
  if ([version]$current -gt [version]$latest) { return }
  & npm install -g "npm@$latest" --engine-strict --fetch-retries=0 --fetch-timeout=30000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'npm update failed. Check network, permissions and Node.js compatibility.' }
  $installed = ((& npm --version) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $installed -ne $latest) { throw 'npm command version verification failed. Check PATH and prefix.' }
  $root = ((& npm root -g) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $root) { throw 'Could not verify the npm installation prefix.' }
  $package = Get-Content -LiteralPath (Join-Path $root 'npm/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($package.version -ne $latest) { throw 'npm package version does not match its active command.' }
}
