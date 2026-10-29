#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=provider-cli-common.sh
source "$SCRIPT_DIR/provider-cli-common.sh"

run_native_provider_installer 'linux' 'muse' "$@"
