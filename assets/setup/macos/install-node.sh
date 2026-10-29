#!/usr/bin/env bash
#
# Packaged Cats macOS host helper: install or upgrade Node.js LTS via nvm.
#
# Implements the packaged-helper contract used by Settings>Runtime:
#   --check / --apply / -upgrade / -force / --json
# Uninstall is intentionally omitted — removing Node would break the
# packaged Cats runtime and every npm-global CLI helper.
#
# nvm is installed under $HOME/.nvm so this helper never needs sudo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER_ID='macos-node-host-installer'
DISPLAY_NAME='Node.js LTS'
NVM_VERSION='v0.39.7'

mode='check'
emit_json='false'
install_state='auto'
detected_version_override=''
skip_node_probe='false'

print_help() {
  cat <<EOF
Usage: install-node.sh [--check] [--apply] [-upgrade] [-force] [--json]
                       [--install-state auto|installed|missing] [--detected-version <ver>]
                       [--skip-node-probe]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check|-CheckOnly) mode='check' ;;
    --apply|-Apply) mode='apply' ;;
    -upgrade|-Upgrade) mode='upgrade' ;;
    -force|-Force) mode='force' ;;
    --json|-Json) emit_json='true' ;;
    --dry-run|-DryRun) ;;  # Accepted for parity with the Windows helper; not honored.
    --install-state)
      shift; install_state="${1:-auto}"
      ;;
    --detected-version)
      shift; detected_version_override="${1:-}"
      ;;
    --skip-node-probe) skip_node_probe='true' ;;
    -h|--help) print_help; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; print_help >&2; exit 1 ;;
  esac
  shift
done

declare -a planned_actions=()
declare -a applied_changes=()
declare -a warnings=()
declare -a manual_steps=()

# Helpers
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
  fi
}

resolve_node_path() {
  command -v node 2>/dev/null || true
}

resolve_node_version() {
  if [ -n "$detected_version_override" ]; then
    printf '%s' "$detected_version_override"
    return
  fi
  if [ "$skip_node_probe" = 'true' ]; then
    return
  fi
  local raw
  raw="$(node -v 2>/dev/null || true)"
  printf '%s' "${raw#v}"
}

is_node_installed() {
  case "$install_state" in
    installed) return 0 ;;
    missing) return 1 ;;
  esac
  if [ "$skip_node_probe" = 'true' ]; then
    return 1
  fi
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1
}

json_array_from_lines() {
  local arr_name="$1[@]"
  local items=("${!arr_name:-}")
  local out='['
  local sep=''
  for item in "${items[@]:-}"; do
    [ -z "$item" ] && continue
    local escaped
    escaped="$(printf '%s' "$item" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    out="$out$sep\"$escaped\""
    sep=','
  done
  out="$out]"
  printf '%s' "$out"
}

emit_result() {
  local status="$1"
  local installed="$2"
  local exit_code="$3"

  local cmd_path detected
  cmd_path="$(resolve_node_path)"
  detected="$(resolve_node_version)"

  if [ "$emit_json" = 'true' ]; then
    cat <<JSON
{
  "helper": "$HELPER_ID",
  "displayName": "$DISPLAY_NAME",
  "mode": "$mode",
  "status": "$status",
  "installed": $installed,
  "commandPath": "$cmd_path",
  "detectedVersion": "$detected",
  "plannedActions": $(json_array_from_lines planned_actions),
  "appliedChanges": $(json_array_from_lines applied_changes),
  "warnings": $(json_array_from_lines warnings),
  "manualSteps": $(json_array_from_lines manual_steps),
  "interruptions": []
}
JSON
  else
    printf 'Helper: %s\n' "$HELPER_ID"
    printf 'Mode: %s\n' "$mode"
    printf 'Status: %s\n' "$status"
    printf 'Installed: %s\n' "$installed"
    [ -n "$detected" ] && printf 'Detected version: %s\n' "$detected"
    for w in "${warnings[@]:-}"; do
      [ -n "$w" ] && printf 'Warning: %s\n' "$w" >&2
    done
  fi

  exit "$exit_code"
}

# Desktop's environment may predate nvm installation. Load it before read-only
# detection too; a bundled or standalone node without npm is not this substrate.
if [ "$install_state" = 'auto' ] && [ "$skip_node_probe" = 'false' ]; then
  load_nvm
fi

# Mode: check
if [ "$mode" = 'check' ]; then
  if is_node_installed; then
    emit_result 'ready' 'true' 0
  else
    planned_actions+=('install_node_lts_via_nvm')
    emit_result 'changes_required' 'false' 0
  fi
fi

# Mode: apply (idempotent)
if [ "$mode" = 'apply' ] && is_node_installed; then
  emit_result 'ready' 'true' 0
fi

# Mutation modes (apply / upgrade / force)
load_nvm

if [ ! -d "$HOME/.nvm" ]; then
  if curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash >/dev/null 2>&1; then
    applied_changes+=("installed_nvm_${NVM_VERSION}")
    load_nvm
  else
    warnings+=('Failed to install nvm.')
    manual_steps+=('Install nvm manually: https://github.com/nvm-sh/nvm#installing-and-updating')
    emit_result 'failed' 'false' 1
  fi
fi

if ! command -v nvm >/dev/null 2>&1; then
  warnings+=('nvm did not load after install.')
  manual_steps+=('Open a new terminal and re-run the helper, or source ~/.nvm/nvm.sh manually.')
  emit_result 'failed' 'false' 1
fi

case "$mode" in
  apply)
    if nvm install --lts >/dev/null 2>&1; then
      applied_changes+=('nvm_install_lts')
      nvm alias default 'lts/*' >/dev/null 2>&1 || true
    else
      warnings+=('nvm install --lts failed.')
      emit_result 'failed' 'false' 1
    fi
    ;;
  upgrade)
    if nvm install --lts --reinstall-packages-from=current >/dev/null 2>&1; then
      applied_changes+=('nvm_upgrade_lts')
      nvm alias default 'lts/*' >/dev/null 2>&1 || true
    else
      warnings+=('nvm upgrade to LTS failed.')
      emit_result 'failed' 'false' 1
    fi
    ;;
  force)
    if nvm install --lts --reinstall-packages-from=current >/dev/null 2>&1; then
      applied_changes+=('nvm_force_reinstall_lts')
      nvm alias default 'lts/*' >/dev/null 2>&1 || true
    else
      warnings+=('nvm force-reinstall LTS failed.')
      emit_result 'failed' 'false' 1
    fi
    ;;
esac

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  emit_result 'ready' 'true' 0
else
  warnings+=('Node.js or npm is still missing after install.')
  manual_steps+=('Open a new terminal so PATH picks up the nvm-managed node binary.')
  emit_result 'failed' 'false' 1
fi
