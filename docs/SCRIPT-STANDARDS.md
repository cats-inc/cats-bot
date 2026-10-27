# Script Standards and Naming Conventions

> Minimal script standards for new subprojects.

## Naming Conventions

### PowerShell (Windows)

Use Verb-Noun naming (PascalCase):

- `Setup-Environment.ps1`
- `Start-Server.ps1`
- `Start-DevServer.ps1`
- `Invoke-Tests.ps1`
- `Invoke-Lint.ps1`

### Bash (Linux/macOS)

Use kebab-case:

- `setup-environment.sh`
- `start-server.sh`
- `start-dev-server.sh`
- `run-tests.sh`
- `lint.sh`

## Directory Structure

```
scripts/
├── windows/          # PowerShell scripts (.ps1)
├── linux/            # Bash scripts (.sh)
├── macos/            # Bash scripts (.sh)
└── testing/          # Test helpers (shared)
```

## Script Template (PowerShell)

```powershell
<#
.SYNOPSIS
    Brief description of the script.

.DESCRIPTION
    Detailed description of what the script does.

.PARAMETER ParamName
    Description of the parameter.

.EXAMPLE
    .\Script-Name.ps1
    Basic usage example.
#>

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $ProjectRoot

try {
    Write-Host "Starting..." -ForegroundColor Cyan
} finally {
    Pop-Location
}
```

## Script Template (Bash)

```bash
#!/bin/bash
#
# Brief description of the script.
#
# Usage: ./script-name.sh [OPTIONS]
#
# Options:
#   -h, --help     Show help
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_ROOT"
echo "Starting..."
```

---

*Last updated: 2026-01-03
