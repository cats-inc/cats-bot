#!/usr/bin/env bash

if [ -n "${CATS_PLATFORM_UNIX_NODE_COMMON_SH:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
readonly CATS_PLATFORM_UNIX_NODE_COMMON_SH=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=provider-cli-common.sh
. "$SCRIPT_DIR/provider-cli-common.sh"
. "$SCRIPT_DIR/verified-npm-update.sh"

normalize_npm_registry() {
  case "$1" in
    https://registry.npmjs.org|https://registry.npmjs.org/)
      printf '%s\n' 'https://registry.npmjs.org/'
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

load_nvm_if_present() {
  if [ -d "$HOME/.nvm" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1090
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  fi
}

npmrc_has_prefix_conflict() {
  local npmrc="$HOME/.npmrc"
  if [ -n "${NPM_CONFIG_PREFIX:-}" ] || [ -n "${NPM_CONFIG_GLOBALCONFIG:-}" ]; then
    return 0
  fi
  if [ -f "$npmrc" ] && grep -q -E '^[[:space:]]*(prefix|globalconfig)[[:space:]]*=' "$npmrc"; then
    return 0
  fi
  return 1
}

nvm_is_active() {
  command -v nvm >/dev/null 2>&1
}

ensure_node_and_npm() {
  if ! command -v node >/dev/null 2>&1; then
    printf 'Node.js is required but was not found.\n' >&2
    return 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    printf 'npm is required but was not found.\n' >&2
    return 1
  fi
  # Desktop invokes each helper in a fresh non-login shell. Read the configured
  # prefix, never source arbitrary shell startup files to recover its commands.
  local configured_prefix
  configured_prefix="$(npm config get prefix 2>/dev/null || true)"
  [ -z "$configured_prefix" ] || prepend_path_if_missing "$configured_prefix/bin"
  return 0
}

has_explicit_npm_prefix() {
  [ -z "${NPM_CONFIG_PREFIX:-${npm_config_prefix:-}}" ] || return 0
  local npmrc="${NPM_CONFIG_USERCONFIG:-${npm_config_userconfig:-$HOME/.npmrc}}"
  [ -f "$npmrc" ] && grep -qE '^[[:space:]]*prefix[[:space:]]*=' "$npmrc"
}

preferred_npm_prefix() {
  local existing canonical_home
  existing="$(npm config get prefix 2>/dev/null || true)"
  if [ -n "$existing" ] && has_explicit_npm_prefix; then printf '%s\n' "$existing"; return 0; fi
  if [ -d "$existing" ] && [ -w "$existing" ]; then
    existing="$(cd -P -- "$existing" && pwd -P)"
    canonical_home="$(cd -P -- "$HOME" && pwd -P)"
    case "$existing" in "$canonical_home"/*) printf '%s\n' "$existing"; return 0 ;; esac
  fi
  printf '%s\n' "$HOME/.npm-global"
}

ensure_npm_global_path_export() {
  local shell_rc="$1" prefix="${2:-$HOME/.npm-global}" export_line
  printf -v export_line 'export PATH=%q:$PATH' "$prefix/bin"
  append_line_if_missing "$shell_rc" '# Added by cats-platform self-hosted npm helpers' '# Added by cats-platform self-hosted npm helpers'
  append_line_if_missing "$shell_rc" "$export_line" "$export_line"
  prepend_path_if_missing "$prefix/bin"
}

node_prefix_ready() {
  local prefix desired_prefix
  local registry
  local shell_rc

  prefix="$(npm config get prefix 2>/dev/null || printf '')"
  registry="$(normalize_npm_registry "$(npm config get registry 2>/dev/null || printf '')")"
  shell_rc="$(detect_shell_rc)"
  desired_prefix="$(preferred_npm_prefix)"

  if nvm_is_active && ! has_explicit_npm_prefix; then
    if npmrc_has_prefix_conflict; then
      return 1
    fi
    [ "$registry" = 'https://registry.npmjs.org/' ]
    return $?
  fi

  if [ "$prefix" != "$desired_prefix" ]; then
    return 1
  fi

  if [ "$registry" != 'https://registry.npmjs.org/' ]; then
    return 1
  fi

  if [[ ":$PATH:" == *":$desired_prefix/bin:"* ]]; then
    return 0
  fi

  return 1
}

node_prefix_help() {
  local script_name="$1"
  cat <<EOF
Usage: $script_name [--check] [-upgrade] [-force] [--help]

Repo-owned self-hosted helper that ports the Unix npm prefix/PATH setup
behavior from environment-bootstrap into cats-platform.

Options:
  --check    Verify whether npm global installs are configured for this user.
  -upgrade   Re-apply the npm registry/prefix configuration.
  -force     Force a fresh rewrite of the npm registry/prefix configuration.
  --help     Show this help text.
EOF
}

run_node_prefix_setup() {
  local platform="$1"
  shift

  local check_only='false'
  local apply='false'
  local upgrade='false'
  local force='false'
  local emit_json='false'
  local shell_rc
  local prefix desired_prefix
  local registry
  local status='ready'
  local execution_mode='apply'
  local planned_actions=()
  local applied_changes=()

  while [ $# -gt 0 ]; do
    case "$1" in
      --check|-CheckOnly)
        check_only='true'
        ;;
      -Apply)
        apply='true'
        ;;
      -upgrade|-Upgrade)
        upgrade='true'
        ;;
      -force|-Force)
        force='true'
        ;;
      --json|-Json)
        emit_json='true'
        ;;
      -h|--help)
        node_prefix_help "$(basename "$0")"
        return 0
        ;;
      *)
        printf 'Unknown option: %s\n' "$1" >&2
        node_prefix_help "$(basename "$0")" >&2
        return 1
        ;;
    esac
    shift
  done

  if [ "$force" = 'true' ]; then
    upgrade='false'
  fi

  if [ "$check_only" = 'true' ]; then
    execution_mode='check'
  elif [ "$force" = 'true' ]; then
    execution_mode='force'
  elif [ "$upgrade" = 'true' ]; then
    execution_mode='upgrade'
  else
    execution_mode='apply'
  fi

  desired_prefix="$HOME/.npm-global"
  load_nvm_if_present
  if ! ensure_node_and_npm; then
    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s-npm-prefix-helper",' "$platform"
      printf '"mode":"%s",' "$execution_mode"
      printf '"status":"failed",'
      printf '"restartRequired":false,'
      printf '"desiredPrefix":"%s",' "$(json_escape "$desired_prefix")"
      printf '"shellRc":"%s",' "$(json_escape "$(detect_shell_rc)")"
      printf '"plannedActions":[],'
      printf '"appliedChanges":[],'
      printf '"warnings":[],'
      printf '"manualSteps":[],'
      printf '"interruptions":[]'
      printf '}\n'
    fi
    return 1
  fi

  shell_rc="$(detect_shell_rc)"
  desired_prefix="$(preferred_npm_prefix)"
  prefix="$(npm config get prefix 2>/dev/null || printf '')"
  registry="$(normalize_npm_registry "$(npm config get registry 2>/dev/null || printf '')")"

  if nvm_is_active && ! has_explicit_npm_prefix; then
    if npmrc_has_prefix_conflict; then
      planned_actions+=('clear_npm_prefix_conflict')
    fi
    if [ "$registry" != 'https://registry.npmjs.org/' ]; then
      planned_actions+=('set_npm_registry')
    fi
  else
    if [ "$prefix" != "$desired_prefix" ]; then
      planned_actions+=('set_npm_prefix')
    fi
    if [ "$registry" != 'https://registry.npmjs.org/' ]; then
      planned_actions+=('set_npm_registry')
    fi
    if [[ ":$PATH:" != *":$desired_prefix/bin:"* ]]; then
      planned_actions+=('repair_npm_global_path')
    fi
  fi

  if [ ${#planned_actions[@]} -gt 0 ]; then
    status='changes_required'
  fi

  if [ "$check_only" = 'true' ]; then
    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s-npm-prefix-helper",' "$platform"
      printf '"mode":"check",'
      printf '"status":"%s",' "$status"
      printf '"restartRequired":false,'
      printf '"desiredPrefix":"%s",' "$(json_escape "$desired_prefix")"
      printf '"shellRc":"%s",' "$(json_escape "$shell_rc")"
      printf '"plannedActions":'
      json_string_array "${planned_actions[@]}"
      printf ','
      printf '"appliedChanges":[],'
      printf '"warnings":[],'
      printf '"manualSteps":[],'
      printf '"interruptions":[]'
      printf '}\n'
      return 0
    fi
    if node_prefix_ready; then
      printf 'npm global prefix is ready.\n'
      return 0
    fi
    printf 'npm global prefix is not ready.\n' >&2
    return 1
  fi

  if [ "$force" = 'false' ] && [ "$upgrade" = 'false' ] && node_prefix_ready; then
    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s-npm-prefix-helper",' "$platform"
      printf '"mode":"%s",' "$execution_mode"
      printf '"status":"ready",'
      printf '"restartRequired":false,'
      printf '"desiredPrefix":"%s",' "$(json_escape "$desired_prefix")"
      printf '"shellRc":"%s",' "$(json_escape "$shell_rc")"
      printf '"plannedActions":[],'
      printf '"appliedChanges":[],'
      printf '"warnings":[],'
      printf '"manualSteps":[],'
      printf '"interruptions":[]'
      printf '}\n'
      return 0
    fi
    printf 'npm global prefix is already configured.\n'
    return 0
  fi

  if nvm_is_active && ! has_explicit_npm_prefix; then
    nvm use --delete-prefix "$(node -v)" --silent >/dev/null 2>&1 || true
    npm config delete prefix >/dev/null 2>&1 || true
    npm config delete globalconfig >/dev/null 2>&1 || true
    npm config set registry 'https://registry.npmjs.org/'
    applied_changes+=('set_npm_registry')
    if npmrc_has_prefix_conflict; then
      applied_changes+=('clear_npm_prefix_conflict')
    fi
  else
    mkdir -p "$desired_prefix"
    npm config set prefix "$desired_prefix"
    npm config set registry 'https://registry.npmjs.org/'
    ensure_npm_global_path_export "$shell_rc" "$desired_prefix"
    applied_changes+=('set_npm_prefix' 'set_npm_registry' 'repair_npm_global_path')
  fi

  prefix="$(npm config get prefix 2>/dev/null || printf '')"
  registry="$(normalize_npm_registry "$(npm config get registry 2>/dev/null || printf '')")"
  status='ready'
  if ! node_prefix_ready; then
    status='failed'
  fi
  if [ "$emit_json" = 'true' ]; then
    printf '{'
    printf '"helper":"%s-npm-prefix-helper",' "$platform"
    printf '"mode":"%s",' "$execution_mode"
    printf '"status":"%s",' "$status"
    printf '"restartRequired":false,'
    printf '"desiredPrefix":"%s",' "$(json_escape "$desired_prefix")"
    printf '"shellRc":"%s",' "$(json_escape "$shell_rc")"
    printf '"plannedActions":'
    json_string_array "${planned_actions[@]}"
    printf ','
    printf '"appliedChanges":'
    json_string_array "${applied_changes[@]}"
    printf ','
    printf '"warnings":[],'
    printf '"manualSteps":[],'
    printf '"interruptions":[]'
    printf '}\n'
    if [ "$status" = 'failed' ]; then
      return 1
    fi
    return 0
  fi
  printf 'npm prefix: %s\n' "$prefix"
  printf 'npm registry: %s\n' "$registry"
  printf 'Reload your shell if PATH is stale: source %s\n' "$shell_rc"
}

# Packages whose npm name changed upstream. npm resolves an abandoned name to its
# final published version and reports it as current forever, so `npm outdated -g`
# never flags it and every upgrade path silently skips it. Two packages shipping
# the same bin also fight over the shim, which resolves to whichever installed
# last. The superseded package is therefore removed before its replacement is
# installed, matching environment-bootstrap cfe7785.
node_cli_superseded_packages() {
  case "$1" in
    '@earendil-works/pi-coding-agent')
      printf '%s\n' '@mariozechner/pi-coding-agent'
      ;;
    *)
      :
      ;;
  esac
}

remove_superseded_npm_packages() {
  local package_name="$1"
  local legacy=''

  while IFS= read -r legacy; do
    [ -n "$legacy" ] || continue
    npm list -g "$legacy" --depth=0 >/dev/null 2>&1 || continue
    printf 'Removing superseded package %s (replaced by %s).\n' "$legacy" "$package_name" >&2
    npm uninstall -g "$legacy" >/dev/null 2>&1 || return 1
  done <<EOF
$(node_cli_superseded_packages "$package_name")
EOF
}

node_cli_package_rows() {
  cat <<'EOF'
codex|codex|@openai/codex|OpenAI Codex
copilot|copilot|@github/copilot|GitHub Copilot CLI
opencode|opencode|opencode-ai|OpenCode
kilo|kilo|@kilocode/cli|Kilo Code CLI
auggie|auggie|@augmentcode/auggie|Auggie CLI
pi|pi|@earendil-works/pi-coding-agent|Pi CLI
cline|cline|cline|Cline CLI
EOF
}

node_cli_pack_help() {
  local script_name="$1"
  cat <<EOF
Usage: $script_name [--check] [-upgrade] [-force] [--uninstall] [--skip-prefix-setup] [--help]

Repo-owned self-hosted helper for the shared npm-based CLI provider pack:
Codex, Copilot, OpenCode, Kilo, Auggie, and Pi.

Options:
  --check             Verify whether the npm CLI pack is reachable on this host.
  -upgrade            Upgrade installed packages and install any missing package.
  -force              Reinstall every package in the pack.
  --uninstall         Uninstall every npm-global package in the pack.
  --skip-prefix-setup Skip the npm prefix/PATH helper.
  --help              Show this help text.
EOF
}

run_node_cli_pack() {
  local platform="$1"
  shift

  local check_only='false'
  local apply='false'
  local upgrade='false'
  local force='false'
  local uninstall='false'
  local dry_run='false'
  local skip_prefix_setup='false'
  local emit_json='false'
  local outdated_packages=''
  local row=''
  local id=''
  local command_name=''
  local package_name=''
  local display_name=''
  local installed='false'
  local installed_count=0
  local missing_count=0
  local changed_count=0
  local planned_actions=()
  local applied_changes=()
  local warnings=()
  local packages_json=''
  local first_package='true'
  local package_status=''
  local prefix_status='ready'

  while [ $# -gt 0 ]; do
    case "$1" in
      --check|-CheckOnly)
        check_only='true'
        ;;
      -Apply)
        apply='true'
        ;;
      -upgrade|-Upgrade)
        upgrade='true'
        ;;
      -force|-Force)
        force='true'
        ;;
      --uninstall|-Uninstall)
        uninstall='true'
        ;;
      --dry-run|-DryRun)
        dry_run='true'
        ;;
      --skip-prefix-setup)
        skip_prefix_setup='true'
        ;;
      --json|-Json)
        emit_json='true'
        ;;
      -h|--help)
        node_cli_pack_help "$(basename "$0")"
        return 0
        ;;
      *)
        printf 'Unknown option: %s\n' "$1" >&2
        node_cli_pack_help "$(basename "$0")" >&2
        return 1
        ;;
    esac
    shift
  done

  if [ "$force" = 'true' ]; then
    upgrade='false'
  fi

  load_nvm_if_present
  if ! ensure_node_and_npm; then
    local missing_node_mode missing_node_status missing_node_exit
    if [ "$uninstall" = 'true' ]; then
      missing_node_mode='uninstall'
      missing_node_status='not_installed'
      missing_node_exit=0
    elif [ "$check_only" = 'true' ]; then
      missing_node_mode='check'
      missing_node_status='not_installed'
      missing_node_exit=0
    elif [ "$force" = 'true' ]; then
      missing_node_mode='force'
      missing_node_status='failed'
      missing_node_exit=1
    elif [ "$upgrade" = 'true' ]; then
      missing_node_mode='upgrade'
      missing_node_status='failed'
      missing_node_exit=1
    else
      missing_node_mode='apply'
      missing_node_status='failed'
      missing_node_exit=1
    fi
    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s-node-cli-pack",' "$platform"
      printf '"mode":"%s",' "$missing_node_mode"
      printf '"status":"%s",' "$missing_node_status"
      printf '"restartRequired":false,'
      printf '"plannedActions":[],'
      printf '"appliedChanges":[],'
      printf '"warnings":[],'
      printf '"manualSteps":[],'
      printf '"interruptions":[],'
      printf '"packages":[]'
      printf '}\n'
    fi
    return "$missing_node_exit"
  fi

  local execution_mode='apply'
  if [ "$uninstall" = 'true' ]; then
    execution_mode='uninstall'
  elif [ "$check_only" = 'true' ]; then
    execution_mode='check'
  elif [ "$force" = 'true' ]; then
    execution_mode='force'
  elif [ "$upgrade" = 'true' ]; then
    execution_mode='upgrade'
  fi

  if [ "$execution_mode" = 'uninstall' ]; then
    local uninstall_status='not_installed'
    while IFS='|' read -r id command_name package_name display_name; do
      [ -n "$id" ] || continue
      installed='false'
      if command -v "$command_name" >/dev/null 2>&1 || npm list -g "$package_name" --depth=0 >/dev/null 2>&1; then
        installed='true'
        installed_count=$((installed_count + 1))
        planned_actions+=("${package_name}:uninstall")
        if [ "$dry_run" = 'true' ]; then
          package_status='preview'
        elif npm uninstall -g "$package_name" >/dev/null 2>&1; then
          applied_changes+=("${package_name}:uninstalled")
          changed_count=$((changed_count + 1))
          package_status='uninstalled'
        else
          warnings+=("${package_name}:uninstall_failed")
          package_status='failed'
        fi
      else
        package_status='not_installed'
      fi

      if [ "$first_package" = 'false' ]; then
        packages_json="${packages_json},"
      fi
      first_package='false'
      packages_json="${packages_json}{\"id\":\"${id}\",\"label\":\"$(json_escape "$display_name")\",\"packageName\":\"$(json_escape "$package_name")\",\"installed\":$(json_bool "$installed"),\"outdated\":false,\"plannedAction\":\"$( [ "$installed" = 'true' ] && printf 'uninstall' || printf 'skip' )\",\"status\":\"${package_status}\"}"
    done <<EOF
$(node_cli_package_rows)
EOF

    if [ $installed_count -eq 0 ]; then
      uninstall_status='not_installed'
    elif [ "$dry_run" = 'true' ]; then
      uninstall_status='preview'
    elif [ ${#warnings[@]} -gt 0 ]; then
      uninstall_status='changes_required'
    else
      uninstall_status='uninstalled'
    fi

    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s-node-cli-pack",' "$platform"
      printf '"mode":"uninstall",'
      printf '"status":"%s",' "$uninstall_status"
      printf '"restartRequired":false,'
      printf '"plannedActions":'
      json_string_array "${planned_actions[@]}"
      printf ','
      printf '"appliedChanges":'
      json_string_array "${applied_changes[@]}"
      printf ','
      printf '"warnings":'
      json_string_array "${warnings[@]}"
      printf ','
      printf '"manualSteps":[],'
      printf '"interruptions":[],'
      printf '"packages":[%s]' "$packages_json"
      printf '}\n'
    else
      printf 'npm CLI pack uninstall complete. removed=%s warnings=%s\n' "$changed_count" "${#warnings[@]}"
    fi
    return 0
  fi

  if [ "$skip_prefix_setup" = 'false' ] && [ "$check_only" = 'false' ]; then
    run_node_prefix_setup "$platform" -Apply >/dev/null || return 1
  elif [ "$skip_prefix_setup" = 'false' ] && ! node_prefix_ready; then
    prefix_status='changes_required'
  fi

  if nvm_is_active && npmrc_has_prefix_conflict && [ "$force" = 'false' ]; then
    printf 'Detected ~/.npmrc prefix/globalconfig conflict while nvm is active.\n' >&2
    printf 'Run setup-node-global-prefix.sh first or re-run with -force after review.\n' >&2
    return 1
  fi

  if [ "$upgrade" = 'true' ]; then
    outdated_packages="$(npm outdated -g --json 2>/dev/null || true)"
  fi

  while IFS='|' read -r id command_name package_name display_name; do
    [ -n "$id" ] || continue

    installed='false'
    local is_outdated='false'
    local planned_action='skip'
    if command -v "$command_name" >/dev/null 2>&1 || npm list -g "$package_name" --depth=0 >/dev/null 2>&1; then
      installed='true'
      installed_count=$((installed_count + 1))
    else
      missing_count=$((missing_count + 1))
    fi
    if [ "$upgrade" = 'true' ] && printf '%s' "$outdated_packages" | grep -qF "\"$package_name\""; then
      is_outdated='true'
    fi

    if [ "$check_only" != 'true' ]; then
      remove_superseded_npm_packages "$package_name"
    fi

    if [ "$check_only" = 'true' ]; then
      if [ "$installed" = 'true' ]; then
        printf '%s installed.\n' "$display_name"
      else
        printf '%s missing.\n' "$display_name" >&2
      fi
    elif [ "$force" = 'true' ]; then
      planned_action='reinstall'
      npm install -g --include=optional "$package_name" --force
      changed_count=$((changed_count + 1))
      applied_changes+=("${package_name}:reinstall")
    elif [ "$upgrade" = 'true' ]; then
      if [ "$installed" = 'false' ]; then
        planned_action='install'
        npm install -g --include=optional "$package_name"
        changed_count=$((changed_count + 1))
        applied_changes+=("${package_name}:install")
      elif [ "$is_outdated" = 'true' ]; then
        planned_action='upgrade'
        npm install -g --include=optional "$package_name@latest"
        changed_count=$((changed_count + 1))
        applied_changes+=("${package_name}:upgrade")
      else
        printf '%s already up to date.\n' "$display_name"
      fi
    elif [ "$installed" = 'false' ]; then
      planned_action='install'
      npm install -g --include=optional "$package_name"
      changed_count=$((changed_count + 1))
      applied_changes+=("${package_name}:install")
    else
      printf '%s already installed.\n' "$display_name"
    fi

    if [ "$planned_action" != 'skip' ]; then
      planned_actions+=("${package_name}:${planned_action}")
    fi

    if [ "$installed" = 'true' ] && [ "$is_outdated" = 'false' ]; then
      package_status='ready'
    else
      package_status='changes_required'
    fi
    if [ "$first_package" = 'false' ]; then
      packages_json="${packages_json},"
    fi
    first_package='false'
    packages_json="${packages_json}{\"id\":\"${id}\",\"label\":\"$(json_escape "$display_name")\",\"packageName\":\"$(json_escape "$package_name")\",\"installed\":$(json_bool "$installed"),\"outdated\":$(json_bool "$is_outdated"),\"plannedAction\":\"${planned_action}\",\"status\":\"${package_status}\"}"
  done <<EOF
$(node_cli_package_rows)
EOF

  local status='ready'
  if [ "$prefix_status" = 'changes_required' ] || [ $missing_count -gt 0 ]; then
    status='changes_required'
  fi

  if [ "$check_only" = 'true' ]; then
    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s-node-cli-pack",' "$platform"
      printf '"mode":"check",'
      printf '"status":"%s",' "$status"
      printf '"restartRequired":false,'
      printf '"plannedActions":'
      json_string_array "${planned_actions[@]}"
      printf ','
      printf '"appliedChanges":[],'
      printf '"warnings":[],'
      printf '"manualSteps":[],'
      printf '"interruptions":[],'
      printf '"packages":[%s]' "$packages_json"
      printf '}\n'
      return 0
    fi
    if [ $missing_count -eq 0 ]; then
      return 0
    fi
    return 1
  fi

  if [ "$emit_json" = 'true' ]; then
    printf '{'
    printf '"helper":"%s-node-cli-pack",' "$platform"
    printf '"mode":"%s",' "$execution_mode"
    printf '"status":"ready",'
    printf '"restartRequired":false,'
    printf '"plannedActions":'
    json_string_array "${planned_actions[@]}"
    printf ','
    printf '"appliedChanges":'
    json_string_array "${applied_changes[@]}"
    printf ','
    printf '"warnings":[],'
    printf '"manualSteps":[],'
    printf '"interruptions":[],'
    printf '"packages":[%s]' "$packages_json"
    printf '}\n'
    return 0
  fi
  printf 'npm CLI pack complete. changed=%s installed=%s missing=%s\n' "$changed_count" "$installed_count" "$missing_count"
}

ollama_binary_candidates() {
  local platform="$1"

  printf '%s\n' "$HOME/.local/bin/ollama"
  printf '%s\n' '/usr/local/bin/ollama'
  printf '%s\n' '/usr/bin/ollama'
  if [ "$platform" = 'macos' ]; then
    printf '%s\n' '/opt/homebrew/bin/ollama'
    printf '%s\n' '/Applications/Ollama.app/Contents/Resources/ollama'
  fi
}

detect_ollama_command() {
  local platform="$1"
  local candidate

  if command -v ollama >/dev/null 2>&1; then
    command -v ollama
    return 0
  fi

  while IFS= read -r candidate; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      prepend_path_if_missing "$(dirname "$candidate")"
      printf '%s\n' "$candidate"
      return 0
    fi
  done <<EOF
$(ollama_binary_candidates "$platform")
EOF

  return 1
}

ollama_api_ready() {
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi

  curl -fsS --max-time 2 'http://127.0.0.1:11434/api/tags' >/dev/null 2>&1
}

run_self_hosted_installation_check() {
  local platform="$1"
  shift

  local emit_json='false'
  local strict='false'
  local include_local_models='false'
  local collection_mode='parallel'
  local total_present=0
  local total_missing=0
  local checks_json=''
  local first_json='true'
  local overall_status='ready'
  local prefix_status='missing'
  local core_present=0
  local core_missing=0
  local local_model_present=0
  local local_model_missing=0
  local node_host_missing='false'
  local npm_host_missing='false'
  local command_path=''
  local ollama_command=''
  local provider=''
  local row=''
  local id=''
  local label=''
  local present=''
  local kind=''
  local scope=''
  local status=''
  local command_name=''
  local package_name=''
  local display_name=''
  local async_file=''
  local async_pid=''
  local -a async_files=()
  local -a async_pids=()
  local -a planned_actions=()
  local -a manual_steps=()

  while [ $# -gt 0 ]; do
    case "$1" in
      --json|-Json)
        emit_json='true'
        ;;
      -CheckOnly)
        ;;
      --strict)
        strict='true'
        ;;
      --include-local-models)
        include_local_models='true'
        ;;
      --serial)
        collection_mode='serial'
        ;;
      -h|--help)
        cat <<EOF
Usage: $(basename "$0") [--json] [--strict] [--include-local-models] [--serial] [--help]

Audits the self-hosted provider baseline needed to run cats-platform with
cats-runtime on ${platform}.

Options:
  --json    Emit a machine-readable summary.
  --strict  Exit non-zero when any audited item is missing.
  --include-local-models  Include the optional Ollama local-model check.
  --serial  Disable background fan-out and collect checks serially.
  --help    Show this help text.
EOF
        return 0
        ;;
      *)
        printf 'Unknown option: %s\n' "$1" >&2
        return 1
        ;;
    esac
    shift
  done

  load_nvm_if_present

  if node_prefix_ready; then
    prefix_status='ready'
  fi

  if [ "$emit_json" = 'false' ]; then
    printf 'Self-hosted provider audit (%s)\n' "$platform"
    printf 'Node prefix: %s\n' "$prefix_status"
  fi

  append_check_json() {
    local check_id="$1"
    local label="$2"
    local present="$3"
    local kind="$4"
    local scope="$5"
    local status="$6"
    if [ "$first_json" = 'true' ]; then
      first_json='false'
    else
      checks_json="${checks_json},"
    fi
    checks_json="${checks_json}{\"id\":\"${check_id}\",\"label\":\"${label}\",\"kind\":\"${kind}\",\"scope\":\"${scope}\",\"present\":${present},\"status\":\"${status}\"}"
  }

  phase_status() {
    local missing_count="$1"
    if [ "$missing_count" -eq 0 ]; then
      printf 'ready'
    else
      printf 'changes_required'
    fi
  }

  append_check_row() {
    local check_id="$1"
    local check_label="$2"
    local check_present="$3"
    local check_kind="$4"
    local check_scope="$5"
    local check_status="$6"

    if [ "$check_present" = 'true' ]; then
      total_present=$((total_present + 1))
      case "$check_kind" in
        core) core_present=$((core_present + 1)) ;;
        local_model) local_model_present=$((local_model_present + 1)) ;;
      esac
    else
      total_missing=$((total_missing + 1))
      case "$check_kind" in
        core) core_missing=$((core_missing + 1)) ;;
        local_model) local_model_missing=$((local_model_missing + 1)) ;;
      esac
    fi

    [ "$emit_json" = 'false' ] && printf '%s: %s\n' "$check_label" "$( [ "$check_present" = 'true' ] && printf 'present' || printf 'missing' )"
    append_check_json "$check_id" "$check_label" "$check_present" "$check_kind" "$check_scope" "$check_status"
  }

  handle_audited_check_result() {
    local check_id="$1"
    local check_label="$2"
    local check_present="$3"
    local check_kind="$4"
    local check_scope="$5"
    local check_status="$6"

    append_check_row "$check_id" "$check_label" "$check_present" "$check_kind" "$check_scope" "$check_status"
    case "$check_kind:$check_status" in
      local_model:not_installed)
        planned_actions+=('local_model:install_ollama_local_model')
        manual_steps+=('Install Ollama when you want local models on this host, then rerun the packaged setup check.')
        ;;
      local_model:changes_required)
        planned_actions+=('local_model:start_ollama_local_model')
        manual_steps+=('Start Ollama or run `ollama serve`, then rerun the packaged setup check.')
        ;;
    esac
  }

  if command -v node >/dev/null 2>&1; then
    append_check_row 'node' 'Node.js' 'true' 'core' 'host' 'ready'
  else
    node_host_missing='true'
    append_check_row 'node' 'Node.js' 'false' 'core' 'host' 'changes_required'
    planned_actions+=('install_node_lts_via_nvm')
  fi

  if command -v npm >/dev/null 2>&1; then
    append_check_row 'npm' 'npm' 'true' 'core' 'host' 'ready'
  else
    npm_host_missing='true'
    append_check_row 'npm' 'npm' 'false' 'core' 'host' 'changes_required'
  fi

  if command -v docker >/dev/null 2>&1; then
    append_check_row 'docker' 'Docker' 'true' 'core' 'host' 'ready'
  else
    append_check_row 'docker' 'Docker' 'false' 'core' 'host' 'changes_required'
  fi

  if [ "$prefix_status" = 'ready' ]; then
    append_check_row 'node_prefix' 'npm global prefix' 'true' 'core' 'host' 'ready'
  else
    append_check_row 'node_prefix' 'npm global prefix' 'false' 'core' 'host' 'changes_required'
    if [ "$node_host_missing" = 'false' ] && [ "$npm_host_missing" = 'false' ]; then
      planned_actions+=('repair_npm_prefix')
    fi
  fi

  if [ "$collection_mode" = 'serial' ]; then
    if [ "$include_local_models" = 'true' ]; then
      if ollama_command="$(detect_ollama_command "$platform")"; then
        if ollama_api_ready; then
          handle_audited_check_result 'ollama' 'Ollama' 'true' 'local_model' 'host' 'ready'
        else
          handle_audited_check_result 'ollama' 'Ollama' 'false' 'local_model' 'host' 'changes_required'
        fi
        unset ollama_command
      else
        handle_audited_check_result 'ollama' 'Ollama' 'false' 'local_model' 'host' 'not_installed'
      fi
    fi
  else
    if [ "$include_local_models" = 'true' ]; then
      async_file="$(mktemp)"
      async_files+=("$async_file")
      (
        if ollama_command="$(detect_ollama_command "$platform")"; then
          if ollama_api_ready; then
            printf 'ollama|Ollama|true|local_model|host|ready\n'
          else
            printf 'ollama|Ollama|false|local_model|host|changes_required\n'
          fi
          unset ollama_command
        else
          printf 'ollama|Ollama|false|local_model|host|not_installed\n'
        fi
      ) >"$async_file" 2>/dev/null &
      async_pids+=($!)
    fi

    for async_pid in "${async_pids[@]}"; do
      if ! wait "$async_pid"; then
        for async_file in "${async_files[@]}"; do
          rm -f "$async_file"
        done
        return 1
      fi
    done

    for async_file in "${async_files[@]}"; do
      if IFS='|' read -r id label present kind scope status < "$async_file"; then
        handle_audited_check_result "$id" "$label" "$present" "$kind" "$scope" "$status"
      fi
      rm -f "$async_file"
    done
  fi

  if [ "$total_missing" -gt 0 ]; then
    overall_status='changes_required'
  fi

  if [ "$emit_json" = 'true' ]; then
    printf '{"helper":"self-hosted-cli-check","platform":"%s","collectionMode":"%s","status":"%s","ready":%s,"present":%s,"missing":%s,"plannedActions":' \
      "$platform" \
      "$collection_mode" \
      "$overall_status" \
      "$( [ $total_missing -eq 0 ] && printf 'true' || printf 'false' )" \
      "$total_present" \
      "$total_missing"
    json_string_array "${planned_actions[@]}"
    printf ',"manualSteps":'
    json_string_array "${manual_steps[@]}"
    printf ',"interruptions":[],"checks":[%s],"phases":[{"id":"core","label":"Core prerequisites","status":"%s","present":%s,"missing":%s}' \
      "$checks_json" \
      "$(phase_status "$core_missing")" \
      "$core_present" \
      "$core_missing"
    if [ "$include_local_models" = 'true' ]; then
      printf ',{"id":"local_model_pack","label":"Local model pack","status":"%s","present":%s,"missing":%s}' \
        "$(phase_status "$local_model_missing")" \
        "$local_model_present" \
        "$local_model_missing"
    fi
    printf '],"warnings":[]}\n'
  else
    printf 'Status: %s\n' "$overall_status"
    printf 'Collection mode: %s\n' "$collection_mode"
    printf 'Core prerequisites: %s (present=%s missing=%s)\n' "$(phase_status "$core_missing")" "$core_present" "$core_missing"
    if [ "$include_local_models" = 'true' ]; then
      printf 'Local model pack: %s (present=%s missing=%s)\n' "$(phase_status "$local_model_missing")" "$local_model_present" "$local_model_missing"
    fi
    printf 'Summary: present=%s missing=%s\n' "$total_present" "$total_missing"
  fi

  if [ "$strict" = 'true' ] || [ "$emit_json" = 'false' ]; then
    [ $total_missing -eq 0 ]
    return $?
  fi

  return 0
}

# run_npm_cli_provider <platform> <package> <command_name> <display_name>
#
# Single-package counterpart to run_node_cli_pack. Each thin per-provider
# wrapper (install-codex.sh, install-copilot.sh, ...) calls this function
# with its npm package id, command name on PATH, and display label so the
# packaged-host helper bridge sees the same JSON shape as the native
# installers.
run_npm_cli_provider() {
  local platform="$1"
  local provider_id="$2"
  local package_name="$3"
  local command_name="$4"
  local display_name="$5"
  shift 5

  local check_only='false'
  local apply='false'
  local upgrade='false'
  local force='false'
  local uninstall='false'
  local dry_run='false'
  local emit_json='false'
  local helper_id="${platform}-${provider_id}-native-installer"

  while [ $# -gt 0 ]; do
    case "$1" in
      --check|-CheckOnly) check_only='true' ;;
      -Apply) apply='true' ;;
      -upgrade|-Upgrade) upgrade='true' ;;
      -force|-Force) force='true' ;;
      --uninstall|-Uninstall) uninstall='true' ;;
      --dry-run|-DryRun) dry_run='true' ;;
      --json|-Json) emit_json='true' ;;
      -h|--help)
        printf 'Usage: %s [--check] [-upgrade] [-force] [--uninstall] [--dry-run] [--json]\n' "$(basename "$0")"
        return 0
        ;;
      *)
        printf 'Unknown option: %s\n' "$1" >&2
        return 1
        ;;
    esac
    shift
  done


  if [ "$force" = 'true' ]; then
    upgrade='false'
  fi

  local execution_mode='apply'
  if [ "$uninstall" = 'true' ]; then
    execution_mode='uninstall'
  elif [ "$check_only" = 'true' ]; then
    execution_mode='check'
  elif [ "$force" = 'true' ]; then
    execution_mode='force'
  elif [ "$upgrade" = 'true' ]; then
    execution_mode='upgrade'
  fi

  load_nvm_if_present
  if ! ensure_node_and_npm; then
    local missing_status missing_exit
    if [ "$uninstall" = 'true' ] || [ "$check_only" = 'true' ]; then
      missing_status='not_installed'
      missing_exit=0
    else
      missing_status='failed'
      missing_exit=1
    fi
    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s",' "$helper_id"
      printf '"mode":"%s",' "$execution_mode"
      printf '"status":"%s",' "$missing_status"
      printf '"installed":false,'
      printf '"commandPath":null,'
      printf '"detectedVersion":null,'
      printf '"plannedActions":[],'
      printf '"appliedChanges":[],'
      printf '"warnings":["Node.js and npm must be installed before %s can be installed."],' "$(json_escape "$display_name")"
      printf '"manualSteps":[],'
      printf '"interruptions":[]'
      printf '}\n'
    fi
    return "$missing_exit"
  fi

  local installed='false'
  local command_path=''
  local detected_version=''
  if command -v "$command_name" >/dev/null 2>&1 || npm list -g "$package_name" --depth=0 >/dev/null 2>&1; then
    installed='true'
    command_path="$(command -v "$command_name" 2>/dev/null || true)"
    detected_version="$( (npm list -g --depth=0 --json "$package_name" 2>/dev/null || true) | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{console.log(JSON.parse(s).dependencies?.[process.argv[1]]?.version||"")}catch{}})' "$package_name")"
  fi

  if [ "$installed" = true ] && [ -z "$detected_version" ]; then
    local legacy
    while IFS= read -r legacy; do
      [ -n "$legacy" ] || continue
      if npm list -g "$legacy" --depth=0 >/dev/null 2>&1; then installed=false; break; fi
    done <<LEGACY_EOF
$(node_cli_superseded_packages "$package_name")
LEGACY_EOF
  fi

  if [ "$execution_mode" = 'uninstall' ]; then
    if [ "$installed" = 'false' ]; then
      if [ "$emit_json" = 'true' ]; then
        printf '{'
        printf '"helper":"%s",' "$helper_id"
        printf '"mode":"uninstall",'
        printf '"status":"not_installed",'
        printf '"installed":false,'
        printf '"commandPath":null,'
        printf '"detectedVersion":null,'
        printf '"plannedActions":[],'
        printf '"appliedChanges":[],'
        printf '"warnings":[],'
        printf '"manualSteps":[],'
        printf '"interruptions":[]'
        printf '}\n'
      else
        printf '%s is not installed; nothing to remove.\n' "$display_name"
      fi
      return 0
    fi

    local planned=("${package_name}:uninstall")
    local applied=()
    local warnings=()
    local final_status

    if [ "$dry_run" = 'true' ]; then
      final_status='preview'
    else
      if npm uninstall -g "$package_name" >/dev/null 2>&1; then
        applied+=("${package_name}:uninstalled")
      else
        warnings+=("${package_name}:uninstall_failed")
      fi
      if command -v "$command_name" >/dev/null 2>&1 || npm list -g "$package_name" --depth=0 >/dev/null 2>&1; then
        warnings+=("${package_name}:still_installed_after_uninstall")
        final_status='changes_required'
      elif [ ${#warnings[@]} -gt 0 ]; then
        final_status='changes_required'
      else
        final_status='uninstalled'
      fi
    fi

    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s",' "$helper_id"
      printf '"mode":"uninstall",'
      printf '"status":"%s",' "$final_status"
      printf '"installed":%s,' "$( [ "$dry_run" = 'true' ] && printf 'true' || printf 'false' )"
      printf '"commandPath":null,'
      printf '"detectedVersion":null,'
      printf '"plannedActions":'
      json_string_array "${planned[@]}"
      printf ','
      printf '"appliedChanges":'
      json_string_array "${applied[@]}"
      printf ','
      printf '"warnings":'
      json_string_array "${warnings[@]}"
      printf ','
      printf '"manualSteps":[],'
      printf '"interruptions":[]'
      printf '}\n'
    else
      printf '%s uninstall: %s\n' "$display_name" "$final_status"
    fi
    return 0
  fi

  local is_outdated=false expected_version=''
  if [ "$check_only" = false ] && [ "$uninstall" = false ] && [ "$dry_run" = false ] && { [ "$upgrade" = true ] || [ "$force" = true ] || [ "$installed" = false ]; }; then
    if [ "$upgrade" = true ]; then cats_upgrade_npm || return 1; fi
    expected_version="$(npm view "${package_name}@latest" version --fetch-retries=0 --fetch-timeout=10000 --loglevel=error)" || { printf 'Provider version query failed.\n' >&2; return 1; }
    [[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9._-]+)?$ ]] || { printf 'Invalid provider version metadata.\n' >&2; return 1; }
    local comparison
    comparison="$(cats_version_compare "$detected_version" "$expected_version")"
    if [ -z "$detected_version" ] || [ "$comparison" = -1 ]; then is_outdated=true
    elif [ "$comparison" = 0 ] && [[ "$detected_version" == *-* ]] && [[ "$expected_version" != *-* ]]; then is_outdated=true; fi
  fi

  local planned_action='skip'
  if [ "$force" = 'true' ]; then
    planned_action='reinstall'
  elif [ "$installed" = 'false' ]; then
    planned_action='install'
  elif [ "$upgrade" = 'true' ] && [ "$is_outdated" = 'true' ]; then
    planned_action='upgrade'
  fi

  if [ "$execution_mode" = 'check' ]; then
    local check_status='ready'
    if [ "$installed" = 'false' ] || [ "$is_outdated" = 'true' ]; then
      check_status='changes_required'
    fi
    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s",' "$helper_id"
      printf '"mode":"check",'
      printf '"status":"%s",' "$check_status"
      printf '"installed":%s,' "$( [ "$installed" = 'true' ] && printf 'true' || printf 'false' )"
      if [ -n "$command_path" ]; then
        printf '"commandPath":"%s",' "$(json_escape "$command_path")"
      else
        printf '"commandPath":null,'
      fi
      if [ -n "$detected_version" ]; then
        printf '"detectedVersion":"%s",' "$(json_escape "$detected_version")"
      else
        printf '"detectedVersion":null,'
      fi
      if [ "$planned_action" = 'skip' ]; then
        printf '"plannedActions":[],'
      else
        printf '"plannedActions":["%s:%s"],' "$(json_escape "$package_name")" "$planned_action"
      fi
      printf '"appliedChanges":[],'
      printf '"warnings":[],'
      printf '"manualSteps":[],'
      printf '"interruptions":[]'
      printf '}\n'
    else
      printf '%s check: %s\n' "$display_name" "$check_status"
    fi
    return 0
  fi

  if [ "$planned_action" = 'skip' ]; then
    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s",' "$helper_id"
      printf '"mode":"%s",' "$execution_mode"
      printf '"status":"ready",'
      printf '"installed":true,'
      if [ -n "$command_path" ]; then
        printf '"commandPath":"%s",' "$(json_escape "$command_path")"
      else
        printf '"commandPath":null,'
      fi
      if [ -n "$detected_version" ]; then
        printf '"detectedVersion":"%s",' "$(json_escape "$detected_version")"
      else
        printf '"detectedVersion":null,'
      fi
      printf '"plannedActions":[],'
      printf '"appliedChanges":[],'
      printf '"warnings":[],'
      printf '"manualSteps":[],'
      printf '"interruptions":[]'
      printf '}\n'
    else
      printf '%s already up to date.\n' "$display_name"
    fi
    return 0
  fi

  local applied=()
  if [ "$dry_run" = true ]; then
    printf '{"helper":"%s","mode":"%s","status":"preview","plannedActions":["%s:%s"],"appliedChanges":[],"warnings":[],"manualSteps":[],"interruptions":[]}\n' "$helper_id" "$execution_mode" "$package_name" "$planned_action"
    return 0
  fi
  if [ "$check_only" != 'true' ] && [ "$dry_run" != 'true' ]; then
    remove_superseded_npm_packages "$package_name"
  fi
  npm install -g --include=optional --engine-strict --fetch-retries=0 --fetch-timeout=30000 "${package_name}@${expected_version}" >/dev/null || return 1
  applied+=("${package_name}:${planned_action}")
  hash -r

  local final_command_path
  final_command_path="$(command -v "$command_name" 2>/dev/null || true)"
  local final_version
  final_version="$(npm list -g --depth=0 --json "$package_name" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{console.log(JSON.parse(s).dependencies?.[process.argv[1]]?.version||"")}catch{}})' "$package_name")"

  if [ -z "$final_command_path" ] || [ "$final_version" != "$expected_version" ]; then
    printf 'Provider verification failed. Check npm prefix and PATH.\n' >&2
    return 1
  fi

  if [ "$emit_json" = 'true' ]; then
    printf '{'
    printf '"helper":"%s",' "$helper_id"
    printf '"mode":"%s",' "$execution_mode"
    printf '"status":"ready",'
    printf '"installed":true,'
    if [ -n "$final_command_path" ]; then
      printf '"commandPath":"%s",' "$(json_escape "$final_command_path")"
    else
      printf '"commandPath":null,'
    fi
    if [ -n "$final_version" ]; then
      printf '"detectedVersion":"%s",' "$(json_escape "$final_version")"
    else
      printf '"detectedVersion":null,'
    fi
    printf '"plannedActions":["%s:%s"],' "$(json_escape "$package_name")" "$planned_action"
    printf '"appliedChanges":'
    json_string_array "${applied[@]}"
    printf ','
    printf '"warnings":[],'
    printf '"manualSteps":[],'
    printf '"interruptions":[]'
    printf '}\n'
  else
    printf '%s %s complete.\n' "$display_name" "$planned_action"
  fi
}
