#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=node-cli-common.sh
. "$SCRIPT_DIR/node-cli-common.sh"

run_node_prefix_setup 'macos' "$@"
