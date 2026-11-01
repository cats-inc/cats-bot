#!/usr/bin/env bash
#
# Script: restart-desktop-with-cdp.sh
# Description: Quit the installed Cats Desktop app through its normal quit path and
#   relaunch it with a loopback Chrome DevTools Protocol port, so
#   scripts/testing/desktop-renderer-cdp.mjs can inspect the real renderer.
#   With --disable, relaunch it normally instead.
#
# Usage: ./scripts/macos/restart-desktop-with-cdp.sh [OPTIONS]
#
# Options:
#   --port <n>     Remote debugging port (default: 9222)
#   --app <path>   Cats.app bundle (default: /Applications/Cats.app)
#   --disable      Relaunch without the debugging port and remove the stale
#                  DevToolsActivePort file Electron leaves in its user data
#   --force        Restart even when the managed runtime has child processes
#   -h, --help     Show this help message
#
# Notes:
#   - Restarting stops the app-managed runtime and sidecar; in-flight runs end.
#     The script refuses when the runtime has child processes unless --force.
#   - The app is asked to quit and never killed. If it does not exit in time,
#     the script stops and leaves it running.
#   - While the port is open, any local process can drive the logged-in renderer
#     and its desktop bridge. Electron binds it to 127.0.0.1 only. Electron's own
#     relaunch (for example after a self-update) keeps the flag.
#
# Examples:
#   ./scripts/macos/restart-desktop-with-cdp.sh
#   ./scripts/macos/restart-desktop-with-cdp.sh --port 9333
#   ./scripts/macos/restart-desktop-with-cdp.sh --disable
#

set -euo pipefail

usage() {
  cat <<EOF
Usage: ${CATS_CDP_RESTART:-restart-desktop-with-cdp.sh} [--port PORT] [--app PATH] [--disable] [--force]
Default port: ${CATS_CDP_DEFAULT_PORT:-9222}; app: ${CATS_CDP_DEFAULT_APP:-/Applications/Cats.app}
--disable restarts normally and removes the matching DevToolsActivePort file.
--force permits interruption of active provider child processes. Quit is graceful only.
EOF
}

PORT="${CATS_CDP_DEFAULT_PORT:-9222}"
APP="${CATS_CDP_DEFAULT_APP:-/Applications/Cats.app}"
DISABLE=0
FORCE=0
WAIT_SECONDS=60

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || { echo "Missing value for --port" >&2; exit 1; }
      PORT="$2"
      shift 2
      ;;
    --app)
      [[ $# -ge 2 ]] || { echo "Missing value for --app" >&2; exit 1; }
      APP="${2%/}"
      shift 2
      ;;
    --disable) DISABLE=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1 (use --help)" >&2; exit 1 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This helper is macOS-only." >&2
  exit 1
fi
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "--port must be an integer between 1024 and 65535, got: $PORT" >&2
  exit 1
fi
INFO_PLIST="$APP/Contents/Info.plist"
if [[ ! -f "$INFO_PLIST" ]]; then
  echo "No app bundle at $APP" >&2
  exit 1
fi
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")"
EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$INFO_PLIST")"
EXECUTABLE="$APP/Contents/MacOS/$EXECUTABLE_NAME"
# Fixed by DESKTOP_USER_DATA_DIR_NAME in desktop/host/config.ts, not by the bundle name.
DEVTOOLS_ACTIVE_PORT_FILE="$HOME/Library/Application Support/${CATS_CDP_USER_DATA_NAME:-Cats}/DevToolsActivePort"

# The host and its sidecars all run through the bundle executable.
app_pids() {
  # Core/Runtime processes can use the same executable, including external Bot cores.
  local pid command
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$command" in *'/dist/cli/main.js '*|*'/cats-runtime/'*) continue ;; esac
    [[ -n "$command" ]] && printf '%s\n' "$pid"
  done < <(pgrep -f "^${EXECUTABLE}( |$)" || true)
}

port_listening() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

if [[ "$DISABLE" -eq 0 ]] && port_listening; then
  listener="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN | head -n 1 || true)"
  owner=0
  for pid in $(app_pids); do [[ "$listener" != "$pid" ]] || owner=1; done
  if [[ "$owner" -eq 0 ]]; then
    echo "Port $PORT is already in use by another process; choose another with --port." >&2
    exit 1
  fi
fi

if [[ -n "$(app_pids)" ]]; then
  if [[ "$FORCE" -eq 0 ]]; then
    # Inspect descendants of this GUI only; never stop or wait for external cores.
    pending="$(app_pids)"
    while [[ -n "$pending" ]]; do
      next=""
      while IFS= read -r pid; do
        [[ -n "$pid" ]] || continue
        command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
        children="$(pgrep -P "$pid" || true)"
        if [[ "$command" == *'/cats-runtime/'* && -n "$children" ]]; then
          echo "The managed runtime has child processes (possibly in-flight runs)." >&2
          echo "Restarting would stop them. Rerun with --force to restart anyway." >&2
          exit 2
        fi
        [[ -z "$children" ]] || next="${next}${children}"$'\n'
      done <<< "$pending"
      pending="$next"
    done
  fi

  echo "Asking $BUNDLE_ID to quit..."
  if ! osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null; then
    echo "Could not ask the app to quit (Automation permission?)." >&2
    echo "Quit Cats from its menu, then rerun." >&2
    exit 1
  fi
  for (( waited = 0; waited < WAIT_SECONDS * 2; waited += 1 )); do
    [[ -z "$(app_pids)" ]] && break
    sleep 0.5
  done
  if [[ -n "$(app_pids)" ]]; then
    echo "The app is still running after ${WAIT_SECONDS}s; not forcing it." >&2
    echo "Check it, then rerun." >&2
    exit 1
  fi
fi

if [[ "$DISABLE" -eq 1 ]]; then
  # Electron writes this on a debugging launch and never removes it.
  if [[ -f "$DEVTOOLS_ACTIVE_PORT_FILE" ]]; then
    rm -f -- "$DEVTOOLS_ACTIVE_PORT_FILE"
    echo "Removed $DEVTOOLS_ACTIVE_PORT_FILE"
  fi
  open -a "$APP"
  for (( waited = 0; waited < WAIT_SECONDS * 2; waited += 1 )); do
    [[ -n "$(app_pids)" ]] && break
    sleep 0.5
  done
  if [[ -z "$(app_pids)" ]]; then
    echo "The app did not start within ${WAIT_SECONDS}s." >&2
    exit 1
  fi
  echo "Relaunched $APP without remote debugging."
  exit 0
fi

if port_listening; then
  echo "Port $PORT is already in use; choose another with --port." >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  exit 1
fi

open -a "$APP" --args --remote-debugging-port="$PORT"
version=""
for (( waited = 0; waited < WAIT_SECONDS * 2; waited += 1 )); do
  version="$(curl -fsS -m 1 "http://127.0.0.1:${PORT}/json/version" 2>/dev/null || true)"
  [[ -n "$version" ]] && break
  sleep 0.5
done
if [[ "$version" != *Electron/* ]]; then
  echo "No Electron CDP endpoint on 127.0.0.1:${PORT} within ${WAIT_SECONDS}s." >&2
  exit 1
fi

electron_version="$(printf '%s' "$version" | grep -o 'Electron/[0-9.]*' | head -n 1)"
echo "CDP ready on 127.0.0.1:${PORT}: ${electron_version}"
echo "Inspect: node scripts/testing/${CATS_CDP_CLIENT:-desktop-renderer-cdp.mjs} info --port ${PORT}"
echo "Disable: ./scripts/macos/${CATS_CDP_RESTART:-restart-desktop-with-cdp.sh} --disable"
