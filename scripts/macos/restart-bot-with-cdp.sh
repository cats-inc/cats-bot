#!/bin/bash
# Restart the installed Bot Hub with CDP. Usage: restart-bot-with-cdp.sh [--port 9223] [--app PATH] [--disable] [--force] [--help]
# Quit stops the Hub's managed bots. Active provider processes require --force; external cores are preserved.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CATS_CDP_DEFAULT_PORT=9223
export CATS_CDP_DEFAULT_APP='/Applications/Cats Bot.app'
export CATS_CDP_USER_DATA_NAME='Cats Bot'
export CATS_CDP_CLIENT=bot-renderer-cdp.mjs
export CATS_CDP_RESTART=restart-bot-with-cdp.sh
exec /bin/bash "$SCRIPT_DIR/../shared/restart-electron-with-cdp.sh" "$@"
