#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=provider-cli-common.sh
. "$SCRIPT_DIR/provider-cli-common.sh"

run_native_provider_installer 'macos' 'claude' "$@"
