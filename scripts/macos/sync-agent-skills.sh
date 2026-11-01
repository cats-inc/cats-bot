#!/bin/bash
# Sync repository skills safely. Usage: sync-agent-skills.sh [--project-root DIR] [--agent claude|codex] [--clean] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/../shared/sync-agent-skills.mjs" --project-root "$SCRIPT_DIR/../.." "$@"
