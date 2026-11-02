#!/bin/bash
#
# Run the avatar input acceptance in a private headless labwc session.
#
# Real pointer input, a maximized background and screen captures stay inside this
# session, which has its own configuration, home and Xauthority: on a desktop that
# sets XAUTHORITY in /etc/xdg/labwc/environment, a compositor without them rewrites
# the live session's file and runs its autostart. Build first with npm run build.
#
# Usage: ./scripts/linux/test-avatar-input.sh [OPTIONS]
#
# Options:
#   -h, --help     Show help
#
# Requires labwc, grim, wlrctl, xdotool and xwininfo. Exits non-zero when the
# acceptance fails or the session's own Xauthority changed.
#

set -euo pipefail

usage() {
    sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
    -h | --help) usage; exit 0 ;;
    "") ;;
    *) usage >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

for tool in labwc grim wlrctl xdotool xwininfo node; do
    command -v "$tool" > /dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
[[ -f dist/shell/electron/floatingBot.js ]] || { echo 'Run npm run build first.' >&2; exit 1; }
ELECTRON="$(node -p "require('electron')")"

LIVE_AUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
fingerprint() {
    if [[ -e "$LIVE_AUTHORITY" ]]; then sha256sum "$LIVE_AUTHORITY"; else echo absent; fi
}
LIVE_BEFORE="$(fingerprint)"

# Directly under /tmp: a Wayland socket path has to fit in 108 bytes.
PRIVATE="$(mktemp -d /tmp/cats-bot-avatar.XXXXXX)"
COMPOSITOR=""
cleanup() {
    if [[ -n "$COMPOSITOR" ]]; then
        kill "$COMPOSITOR" 2> /dev/null || true
        wait "$COMPOSITOR" 2> /dev/null || true
    fi
    rm -rf "$PRIVATE"
}
trap cleanup EXIT

mkdir -m 700 "$PRIVATE/run"
mkdir "$PRIVATE/home" "$PRIVATE/labwc" "$PRIVATE/config" "$PRIVATE/data" "$PRIVATE/empty"
: > "$PRIVATE/home/.Xauthority"
: > "$PRIVATE/labwc/autostart"
: > "$PRIVATE/labwc/environment"
printf '<?xml version="1.0"?>\n<labwc_config />\n' > "$PRIVATE/labwc/rc.xml"
printf '<?xml version="1.0"?>\n<openbox_menu />\n' > "$PRIVATE/labwc/menu.xml"
cat > "$PRIVATE/session.sh" << EOF
#!/bin/sh
printf '%s\n%s\n' "\$WAYLAND_DISPLAY" "\$DISPLAY" > "$PRIVATE/session.tmp"
mv "$PRIVATE/session.tmp" "$PRIVATE/session"
EOF
chmod +x "$PRIVATE/session.sh"

SESSION_ENV=(
    env -i
    PATH="$PATH"
    USER="${USER:-$(id -un)}"
    LANG="${LANG:-C.UTF-8}"
    HOME="$PRIVATE/home"
    XAUTHORITY="$PRIVATE/home/.Xauthority"
    XDG_RUNTIME_DIR="$PRIVATE/run"
    XDG_CONFIG_HOME="$PRIVATE/config"
    XDG_CONFIG_DIRS="$PRIVATE/empty"
    XDG_DATA_HOME="$PRIVATE/data"
    WLR_BACKENDS=headless
    WLR_HEADLESS_OUTPUTS=1
    WLR_RENDERER=pixman
    WLR_LIBINPUT_NO_DEVICES=1
)

"${SESSION_ENV[@]}" labwc --config-dir "$PRIVATE/labwc" --startup "$PRIVATE/session.sh" > "$PRIVATE/compositor.log" 2>&1 &
COMPOSITOR=$!
for _ in $(seq 1 100); do
    [[ ! -e "$PRIVATE/session" ]] || break
    kill -0 "$COMPOSITOR" 2> /dev/null || { cat "$PRIVATE/compositor.log" >&2; exit 1; }
    sleep 0.1
done
[[ -e "$PRIVATE/session" ]] || { cat "$PRIVATE/compositor.log" >&2; echo 'The private compositor did not start.' >&2; exit 1; }
{ read -r PRIVATE_WAYLAND; read -r PRIVATE_DISPLAY; } < "$PRIVATE/session"

STATUS=0
"${SESSION_ENV[@]}" WAYLAND_DISPLAY="$PRIVATE_WAYLAND" DISPLAY="$PRIVATE_DISPLAY" CATS_BOT_PRIVATE_COMPOSITOR=1 \
    "$ELECTRON" --ozone-platform=x11 scripts/testing/bot-interaction-acceptance.mjs --native-drag || STATUS=$?

if [[ "$(fingerprint)" != "$LIVE_BEFORE" ]]; then
    echo "The session's Xauthority changed during this run: $LIVE_AUTHORITY" >&2
    exit 1
fi
exit "$STATUS"
