#!/usr/bin/env bash

if [ -n "${CATS_PLATFORM_UNIX_PROVIDER_COMMON_SH:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
readonly CATS_PLATFORM_UNIX_PROVIDER_COMMON_SH=1
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/provider-version-common.sh"

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

json_bool() {
  if [ "$1" = 'true' ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

json_string_array() {
  local first='true'
  local value=''
  printf '['
  for value in "$@"; do
    [ -n "$value" ] || continue
    if [ "$first" = 'false' ]; then
      printf ','
    fi
    first='false'
    printf '"%s"' "$(json_escape "$value")"
  done
  printf ']'
}

platform_label() {
  case "$1" in
    linux) printf '%s\n' 'Linux' ;;
    macos) printf '%s\n' 'macOS' ;;
    windows) printf '%s\n' 'Windows' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

provider_display_name() {
  case "$1" in
    antigravity) printf '%s\n' 'Antigravity CLI' ;;
    grok) printf '%s\n' 'Grok CLI' ;;
    devin) printf '%s\n' 'Devin CLI' ;;
    muse) printf '%s\n' 'Meta Muse CLI' ;;
    claude) printf '%s\n' 'Claude Code CLI' ;;
    cursor) printf '%s\n' 'Cursor Agent CLI' ;;
    goose) printf '%s\n' 'Goose CLI' ;;
    junie) printf '%s\n' 'Junie CLI' ;;
    kiro) printf '%s\n' 'Kiro CLI' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

provider_primary_command() {
  case "$1" in
    antigravity) printf '%s\n' 'agy' ;;
    grok) printf '%s\n' 'grok' ;;
    devin) printf '%s\n' 'devin' ;;
    muse) printf '%s\n' 'muse' ;;
    claude) printf '%s\n' 'claude' ;;
    cursor) printf '%s\n' 'cursor-agent' ;;
    goose) printf '%s\n' 'goose' ;;
    junie) printf '%s\n' 'junie' ;;
    kiro) printf '%s\n' 'kiro-cli' ;;
    *) return 1 ;;
  esac
}

provider_alias_name() {
  case "$1" in
    cursor) printf '%s\n' 'ca' ;;
    kiro) printf '%s\n' 'kc' ;;
    *) printf '\n' ;;
  esac
}

provider_alias_target() {
  case "$1" in
    cursor) printf '%s\n' 'cursor-agent' ;;
    kiro) printf '%s\n' 'kiro-cli' ;;
    *) printf '\n' ;;
  esac
}

provider_install_url() {
  case "$1" in
    antigravity) printf '%s\n' 'https://antigravity.google/cli/install.sh' ;;
    grok) printf '%s\n' 'https://x.ai/cli/install.sh' ;;
    devin) printf '%s\n' 'https://cli.devin.ai/install.sh' ;;
    muse) printf '%s\n' 'https://dev.meta.ai/install.sh' ;;
    claude) printf '%s\n' 'https://claude.ai/install.sh' ;;
    cursor) printf '%s\n' 'https://cursor.com/install' ;;
    goose) printf '%s\n' 'https://github.com/block/goose/releases/download/stable/download_cli.sh' ;;
    junie) printf '%s\n' 'https://junie.jetbrains.com/install.sh' ;;
    kiro) printf '%s\n' 'https://cli.kiro.dev/install' ;;
    *) return 1 ;;
  esac
}

provider_install_dir() {
  case "$1" in
    grok) printf '%s\n' "$HOME/.grok/bin" ;;
    muse) muse_install_dir ;;
    *) printf '%s\n' "$HOME/.local/bin" ;;
  esac
}

provider_binary_candidates() {
  local platform="$1"
  local provider="$2"
  local install_dir
  local primary_command

  install_dir="$(provider_install_dir "$provider")"
  primary_command="$(provider_primary_command "$provider")"
  printf '%s\n' "$install_dir/$primary_command"

  case "$provider" in
    kiro)
      printf '%s\n' '/usr/local/bin/kiro-cli'
      printf '%s\n' '/opt/homebrew/bin/kiro-cli'
      if [ "$platform" = 'macos' ]; then
        printf '%s\n' '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli'
      fi
      ;;
  esac
}

detect_shell_rc() {
  if [ -n "${ZSH_VERSION:-}" ] || [ "${SHELL:-}" = '/bin/zsh' ]; then
    printf '%s\n' "$HOME/.zshrc"
    return
  fi

  if [ -n "${BASH_VERSION:-}" ] || [ "${SHELL:-}" = '/bin/bash' ]; then
    printf '%s\n' "$HOME/.bashrc"
    return
  fi

  printf '%s\n' "$HOME/.bashrc"
}

touch_parent_file() {
  local file_path="$1"
  mkdir -p "$(dirname "$file_path")"
  touch "$file_path"
}

append_line_if_missing() {
  local file_path="$1"
  local literal="$2"
  local line="$3"

  touch_parent_file "$file_path"

  if ! grep -Fqx "$literal" "$file_path" 2>/dev/null; then
    printf '%s\n' "$line" >> "$file_path"
  fi
}

prepend_path_if_missing() {
  local target_dir="$1"
  if [ -n "$target_dir" ] && [ -d "$target_dir" ] && [[ ":$PATH:" != *":$target_dir:"* ]]; then
    export PATH="$target_dir:$PATH"
  fi
}

ensure_provider_bin_path_export() {
  local shell_rc="$1"
  local provider="$2"
  local install_dir
  local path_export

  install_dir="$(provider_install_dir "$provider")"
  if [ "$provider" = 'grok' ]; then
    path_export='export PATH="$HOME/.grok/bin:$PATH"'
  else
    path_export='export PATH="$HOME/.local/bin:$PATH"'
  fi
  append_line_if_missing "$shell_rc" '# Added by cats-platform self-hosted provider helpers' '# Added by cats-platform self-hosted provider helpers'
  append_line_if_missing "$shell_rc" "$path_export" "$path_export"
  prepend_path_if_missing "$install_dir"
}

rewrite_alias_line() {
  local shell_rc="$1"
  local alias_name="$2"
  local alias_target="$3"
  local replaced='false'
  local tmp_file
  tmp_file="$(mktemp)"

  if [ -f "$shell_rc" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if [ "$replaced" = 'false' ] && printf '%s\n' "$line" | grep -Eq "^[[:space:]]*alias[[:space:]]+${alias_name}="; then
        printf "alias %s='%s'\n" "$alias_name" "$alias_target" >> "$tmp_file"
        replaced='true'
      else
        printf '%s\n' "$line" >> "$tmp_file"
      fi
    done < "$shell_rc"
  fi

  if [ "$replaced" = 'false' ]; then
    printf "alias %s='%s'\n" "$alias_name" "$alias_target" >> "$tmp_file"
  fi

  mv "$tmp_file" "$shell_rc"
}

ensure_provider_alias() {
  local shell_rc="$1"
  local provider="$2"
  local alias_name
  local alias_target
  local existing_line

  alias_name="$(provider_alias_name "$provider")"
  alias_target="$(provider_alias_target "$provider")"

  if [ -z "$alias_name" ] || [ -z "$alias_target" ]; then
    return 0
  fi

  touch_parent_file "$shell_rc"
  existing_line="$(grep -E "^[[:space:]]*alias[[:space:]]+${alias_name}=" "$shell_rc" 2>/dev/null | tail -1 || true)"

  if [ -z "$existing_line" ]; then
    printf "alias %s='%s'\n" "$alias_name" "$alias_target" >> "$shell_rc"
    return 0
  fi

  if printf '%s\n' "$existing_line" | grep -Eq "['\"]${alias_target}['\"]"; then
    return 0
  fi

  if [ "$alias_name" = 'kc' ] && printf '%s\n' "$existing_line" | grep -Eq "=['\"]?(kiro|q)['\"]?$"; then
    rewrite_alias_line "$shell_rc" "$alias_name" "$alias_target"
  fi
}

# muse's install directory holds the launcher, its state files, and one
# muse-bin-<version> build per version it has downloaded.
muse_install_dir() {
  printf '%s\n' "${MUSE_INSTALL_DIR:-$HOME/.local/bin}"
}

# The version comes from the launcher's own state file, never from running muse.
# The launcher forwards every argument straight to the agent binary, so a flag
# that binary does not recognise opens the interactive TUI and hangs an
# unattended setup run forever.
muse_installed_version() {
  local version_file
  version_file="$(muse_install_dir)/.muse-version"
  if [ -r "$version_file" ]; then
    tr -d '\r\n' < "$version_file"
  fi
}

# "Installed" means the launcher actually fetched a build. The official
# installer writes the launcher first and downloads muse-bin-<version> last, so
# a run that dies in between leaves a launcher with nothing behind it. Treating
# that as installed would skip the reinstall that repairs it.
muse_install_complete() {
  local dir version
  dir="$(muse_install_dir)"
  [ -x "$dir/muse" ] || return 1
  version="$(muse_installed_version)"
  [ -n "$version" ] || return 1
  [ -x "$dir/muse-bin-$version" ]
}

detect_provider_command() {
  local platform="$1"
  local provider="$2"
  local primary_command
  local candidate

  if [ "$provider" = 'muse' ]; then
    if muse_install_complete; then
      prepend_path_if_missing "$(muse_install_dir)"
      printf '%s\n' "$(muse_install_dir)/muse"
      return 0
    fi
    # A muse elsewhere on PATH is someone's own install; report it rather than
    # claiming the tool is missing, but never treat a half-written install
    # directory as one.
    if [ -x "$(muse_install_dir)/muse" ]; then
      return 1
    fi
    command -v muse 2>/dev/null && return 0
    return 1
  fi

  primary_command="$(provider_primary_command "$provider")"
  if command -v "$primary_command" >/dev/null 2>&1; then
    command -v "$primary_command"
    return 0
  fi

  while IFS= read -r candidate; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      prepend_path_if_missing "$(dirname "$candidate")"
      printf '%s\n' "$candidate"
      return 0
    fi
  done <<EOF
$(provider_binary_candidates "$platform" "$provider")
EOF

  return 1
}

provider_version_line() {
  local command_path="$1"
  local provider="${2:-}"

  # muse is read, never run: see muse_installed_version.
  if [ "$provider" = 'muse' ]; then
    muse_installed_version
    return 0
  fi

  "$command_path" --version 2>&1 | head -1 || true
}

# `curl ... | bash` returns 0 when the download itself fails, because bash reads
# empty input and succeeds. Staging the script first is what makes a failed
# install report as a failure.
run_downloaded_shell_installer() {
  local url="$1"
  local installer_path status=0

  installer_path="$(mktemp)"
  if ! curl -fsSL --connect-timeout 10 --max-time 60 "$url" -o "$installer_path"; then
    rm -f "$installer_path"
    printf 'Failed to download the installer from %s\n' "$url" >&2
    return 1
  fi

  bash "$installer_path" < /dev/null || status=$?
  rm -f "$installer_path"
  return "$status"
}

# Devin's official install.sh ends by launching the interactive `devin setup`
# wizard. Packaged setup runs non-interactively with no console a prompt can
# reach, so an unstripped installer would stall the step rather than fail.
#
# Verified against https://cli.devin.ai/install.sh on 2026-08-09: the file is
# 286 lines and its final line is
#   "$VERSION_DIR/bin/$COMPILED_BIN_NAME" setup
# which is also the only line in the file ending in " setup".
#
# The helper neutralises exactly that line and refuses to run the script when
# the shape does not match, rather than executing an unrecognised installer on
# a guess. stdin from /dev/null stays as insurance for any prompt added earlier
# in the script.
run_devin_installer() {
  local installer_path=''
  local patched_path=''
  local trailing_matches=0
  local status=0

  installer_path="$(mktemp)"
  patched_path="$(mktemp)"

  if ! curl -fsSL "$(provider_install_url devin)" -o "$installer_path"; then
    rm -f "$installer_path" "$patched_path"
    printf 'Failed to download the Devin installer.\n' >&2
    return 1
  fi

  trailing_matches="$(grep -cE ' setup$' "$installer_path" || true)"
  if [ "$trailing_matches" != '1' ]; then
    rm -f "$installer_path" "$patched_path"
    printf 'Refusing to run the Devin installer: expected exactly one interactive setup invocation, found %s. Install Devin with the upstream installer and report this.\n' \
      "$trailing_matches" >&2
    return 1
  fi

  # Restrict the edit to the final line so an unrelated match elsewhere can
  # never be silently rewritten.
  sed -e '$ s|^.* setup$|: skipped interactive devin setup|' "$installer_path" > "$patched_path"
  if cmp -s "$installer_path" "$patched_path"; then
    rm -f "$installer_path" "$patched_path"
    printf 'Refusing to run the Devin installer: the interactive setup invocation is no longer the final line.\n' >&2
    return 1
  fi

  bash "$patched_path" < /dev/null || status=$?
  rm -f "$installer_path" "$patched_path"
  return "$status"
}

run_remote_pipe_installer() {
  local provider="$1"
  shift
  local url
  url="$(provider_install_url "$provider")"

  case "$provider" in
    goose) CONFIGURE=false run_downloaded_shell_installer "$url" ;;
    *) run_downloaded_shell_installer "$url" ;;
  esac
}

ensure_kiro_cli_symlink_macos() {
  local app_dir='/Applications/Kiro CLI.app/Contents/MacOS'
  local bin_dir="$HOME/.local/bin"
  local binary_name

  if [ ! -d "$app_dir" ]; then
    return 0
  fi

  mkdir -p "$bin_dir"
  for binary_name in kiro-cli kiro-cli-chat kiro-cli-term; do
    if [ -x "$app_dir/$binary_name" ]; then
      ln -sf "$app_dir/$binary_name" "$bin_dir/$binary_name"
    fi
  done
}

run_kiro_installer() {
  local platform="$1"
  local mode="$2"
  local installer_path

  installer_path="$(mktemp)"
  curl -fsSL --connect-timeout 10 --max-time 60 "$(provider_install_url kiro)" -o "$installer_path" || { rm -f "$installer_path"; return 1; }
  chmod +x "$installer_path"


  local install_status=0
  bash "$installer_path" --force < /dev/null || install_status=$?
  rm -f "$installer_path"
  [ "$install_status" -eq 0 ] || return "$install_status"

  if [ "$platform" = 'macos' ]; then
    ensure_kiro_cli_symlink_macos
  fi
}

run_provider_install_action() {
  local platform="$1"
  local provider="$2"
  local action="$3"
  local current_command=''

  case "$provider" in
    antigravity)
      local backup='' result=0 destination="$HOME/.local/bin/agy"
      if { [ "$action" = upgrade ] || [ "$action" = force ]; } && [ -f "$destination" ] && [ ! -L "$destination" ]; then
        backup="$(mktemp)" || return 1
        cp -p "$destination" "$backup" || { rm -f "$backup"; return 1; }
        rm -f "$destination" || { rm -f "$backup"; return 1; }
      fi
      run_remote_pipe_installer "$provider" || result=$?
      [ -x "$destination" ] || result=1
      if [ "$result" -ne 0 ] && [ -n "$backup" ]; then cp -p "$backup" "$destination" || true; fi
      [ -z "$backup" ] || rm -f "$backup"
      return "$result"
      ;;
    grok)
      run_remote_pipe_installer "$provider"
      ;;
    devin)
      run_devin_installer
      ;;
    muse)
      # The official installer always refreshes the launcher and asks it to pull
      # the newest build, so install, upgrade, and force are the same call.
      run_remote_pipe_installer "$provider"
      ;;
    claude)
      if [ "$action" = 'upgrade' ] && current_command="$(detect_provider_command "$platform" "$provider")"; then
        "$current_command" update
      else
        run_remote_pipe_installer "$provider"
      fi
      ;;
    cursor|goose|junie)
      run_remote_pipe_installer "$provider"
      ;;
    kiro)
      if [ "$action" = 'upgrade' ] || [ "$action" = 'force' ]; then
        run_kiro_installer "$platform" 'reinstall'
      else
        run_kiro_installer "$platform" 'install'
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

provider_help() {
  local script_name="$1"
  local provider="$2"
  cat <<EOF
Usage: $script_name [--check] [--apply] [--upgrade] [--force] [--uninstall] [--dry-run] [--json] [--help]

Repo-owned self-hosted helper for $(provider_display_name "$provider").

Options:
  --check     Verify whether the provider CLI is reachable on this host.
  --apply     Install the provider CLI if it is missing.
  --upgrade   Upgrade the provider CLI if already installed, otherwise install it.
  --force     Reinstall the provider CLI even when already present.
  --uninstall Remove the provider CLI binaries from user-owned install paths.
  --dry-run   Show the planned mutation without changing the host.
  --json      Emit structured JSON output for the packaged setup bridge.
  --help      Show this help text.
EOF
}

# Globals populated by uninstall_provider_native_paths.
# Bash 3.2 (macOS /bin/bash) lacks `local -n` namerefs, so we use named globals.
__CATS_UNINSTALL_PLANNED=()
__CATS_UNINSTALL_APPLIED=()
__CATS_UNINSTALL_WARNINGS=()
__CATS_UNINSTALL_REMAINING=''

# Steps the helper cannot perform for the user. Packaged Devin installs strip
# the installer's trailing interactive wizard, so authentication is always still
# owed after a successful install; a "ready" result must not imply otherwise.
provider_manual_steps() {
  case "$1" in
    devin)
      printf '%s\n' 'Run devin auth login once to authenticate; packaged setup skips the interactive wizard. Check with devin auth status.'
      ;;
    *)
      :
      ;;
  esac
}

uninstall_provider_native_paths() {
  local platform="$1"
  local provider="$2"
  local dry_run="${3:-false}"

  __CATS_UNINSTALL_PLANNED=()
  __CATS_UNINSTALL_APPLIED=()
  __CATS_UNINSTALL_WARNINGS=()
  __CATS_UNINSTALL_REMAINING=''

  local primary_command primary_path candidate path extra existing already
  local planned_paths=()

  primary_command="$(provider_primary_command "$provider")"
  if [ "$provider" != 'grok' ] && primary_path="$(command -v "$primary_command" 2>/dev/null)"; then
    case "$primary_path" in
      "$HOME"/*) planned_paths+=("$primary_path") ;;
    esac
  fi

  while IFS= read -r candidate; do
    [ -z "$candidate" ] && continue
    case "$candidate" in
      "$HOME"/*)
        if [ -e "$candidate" ] || [ -L "$candidate" ]; then
          already='false'
          for existing in "${planned_paths[@]}"; do
            [ "$existing" = "$candidate" ] && already='true' && break
          done
          [ "$already" = 'false' ] && planned_paths+=("$candidate")
        fi
        ;;
    esac
  done <<UPNP_EOF
$(provider_binary_candidates "$platform" "$provider")
UPNP_EOF

  if [ "$provider" = 'kiro' ]; then
    for extra in kiro-cli-chat kiro-cli-term; do
      if [ -e "$HOME/.local/bin/$extra" ] || [ -L "$HOME/.local/bin/$extra" ]; then
        planned_paths+=("$HOME/.local/bin/$extra")
      fi
    done
    if [ "$platform" = 'macos' ] && [ -d '/Applications/Kiro CLI.app' ]; then
      planned_paths+=('/Applications/Kiro CLI.app')
    fi
  fi

  if [ "$provider" = 'grok' ]; then
    extra="$(provider_install_dir "$provider")/agent"
    if [ -e "$extra" ] || [ -L "$extra" ]; then
      planned_paths+=("$extra")
    fi
  fi

  # Devin's shim in ~/.local/bin points at a versioned tree; removing only the
  # shim would leave every installed version behind.
  if [ "$provider" = 'devin' ]; then
    extra="${XDG_DATA_HOME:-$HOME/.local/share}/devin/cli"
    case "$extra" in
      "$HOME"/*)
        if [ -d "$extra" ]; then
          planned_paths+=("$extra")
        fi
        ;;
    esac
  fi

  # The muse launcher is not the tool either: every muse-bin-<version> build it
  # has downloaded, plus its .muse-* state files, sit in the same directory and
  # survive removing the launcher alone. They are named deterministically, so
  # they can be removed without guessing at unrelated files in ~/.local/bin.
  if [ "$provider" = 'muse' ]; then
    local muse_dir muse_leftover
    muse_dir="$(muse_install_dir)"
    for muse_leftover in "$muse_dir"/muse-bin-* "$muse_dir"/.muse-*; do
      case "$muse_leftover" in
        "$HOME"/*)
          if [ -e "$muse_leftover" ] || [ -L "$muse_leftover" ]; then
            planned_paths+=("$muse_leftover")
          fi
          ;;
      esac
    done
  fi

  for path in "${planned_paths[@]}"; do
    __CATS_UNINSTALL_PLANNED+=("remove:$path")
  done

  if [ "$dry_run" != 'true' ]; then
    for path in "${planned_paths[@]}"; do
      if [ -d "$path" ] && [ ! -L "$path" ]; then
        if rm -rf "$path" 2>/dev/null; then
          __CATS_UNINSTALL_APPLIED+=("removed:$path")
        else
          __CATS_UNINSTALL_WARNINGS+=("failed_to_remove:$path")
        fi
      elif [ -e "$path" ] || [ -L "$path" ]; then
        if rm -f "$path" 2>/dev/null; then
          __CATS_UNINSTALL_APPLIED+=("removed:$path")
        else
          __CATS_UNINSTALL_WARNINGS+=("failed_to_remove:$path")
        fi
      fi
    done
  fi

  if primary_path="$(detect_provider_command "$platform" "$provider")"; then
    __CATS_UNINSTALL_REMAINING="$primary_path"
  fi
}

run_native_provider_installer() {
  local platform="$1"
  local provider="$2"
  shift 2

  local check_only='false'
  local apply='false'
  local upgrade='false'
  local force='false'
  local uninstall='false'
  local dry_run='false'
  local emit_json='false'
  local shell_rc
  local command_path=''
  local display_name
  local attempt=1
  local execution_mode='apply'
  local initial_installed='false'
  local detected_version=''
  local planned_actions=()
  local applied_changes=()
  local warnings=()

  while [ $# -gt 0 ]; do
    case "$1" in
      --check|-CheckOnly)
        check_only='true'
        ;;
      --apply|-Apply)
        apply='true'
        ;;
      --upgrade|-upgrade|-Upgrade)
        upgrade='true'
        ;;
      --force|-force|-Force)
        force='true'
        ;;
      --uninstall|-Uninstall)
        uninstall='true'
        ;;
      --dry-run|-DryRun)
        dry_run='true'
        ;;
      --json|-Json)
        emit_json='true'
        ;;
      -h|--help)
        provider_help "$(basename "$0")" "$provider"
        return 0
        ;;
      *)
        printf 'Unknown option: %s\n' "$1" >&2
        provider_help "$(basename "$0")" "$provider" >&2
        return 1
        ;;
    esac
    shift
  done

  local mutation_count=0
  [ "$apply" = 'true' ] && mutation_count=$((mutation_count + 1))
  [ "$upgrade" = 'true' ] && mutation_count=$((mutation_count + 1))
  [ "$force" = 'true' ] && mutation_count=$((mutation_count + 1))

  if [ "$uninstall" = 'true' ] && { [ "$check_only" = 'true' ] || [ "$mutation_count" -gt 0 ]; }; then
    printf '%s accepts --uninstall as a mutually exclusive mode.\n' "$(basename "$0")" >&2
    return 1
  fi

  if [ "$check_only" = 'true' ] && [ "$mutation_count" -gt 0 ]; then
    printf '%s accepts either --check or one mutation mode.\n' "$(basename "$0")" >&2
    return 1
  fi

  if [ "$mutation_count" -gt 1 ]; then
    printf '%s accepts at most one of --apply / --upgrade / --force.\n' "$(basename "$0")" >&2
    return 1
  fi

  if [ "$force" = 'true' ]; then
    upgrade='false'
  fi

  if [ "$uninstall" = 'true' ]; then
    execution_mode='uninstall'
  elif [ "$check_only" = 'true' ]; then
    execution_mode='check'
  elif [ "$force" = 'true' ]; then
    execution_mode='force'
  elif [ "$upgrade" = 'true' ]; then
    execution_mode='upgrade'
  else
    execution_mode='apply'
  fi

  display_name="$(provider_display_name "$provider")"
  shell_rc="$(detect_shell_rc)"

  if [ "$execution_mode" = 'uninstall' ]; then
    local alias_name
    local uninstall_planned=()
    local uninstall_applied=()
    local uninstall_warnings=()
    local uninstall_remaining=''

    uninstall_provider_native_paths "$platform" "$provider" "$dry_run"
    uninstall_planned=("${__CATS_UNINSTALL_PLANNED[@]}")
    uninstall_applied=("${__CATS_UNINSTALL_APPLIED[@]}")
    uninstall_warnings=("${__CATS_UNINSTALL_WARNINGS[@]}")
    uninstall_remaining="$__CATS_UNINSTALL_REMAINING"

    alias_name="$(provider_alias_name "$provider")"
    if [ -n "$alias_name" ] && [ -f "$shell_rc" ] && grep -Eq "^[[:space:]]*alias[[:space:]]+${alias_name}=" "$shell_rc" 2>/dev/null; then
      uninstall_warnings+=("alias_${alias_name}_remains_in:$shell_rc")
    fi

    local uninstall_status
    if [ ${#uninstall_planned[@]} -eq 0 ]; then
      uninstall_status='not_installed'
    elif [ "$dry_run" = 'true' ]; then
      uninstall_status='preview'
    elif [ -n "$uninstall_remaining" ]; then
      uninstall_status='changes_required'
    elif [ ${#uninstall_warnings[@]} -gt 0 ]; then
      uninstall_status='changes_required'
    else
      uninstall_status='uninstalled'
    fi

    if [ -n "$uninstall_remaining" ]; then
      uninstall_warnings+=("system_install_remains_at:$uninstall_remaining")
    fi

    local uninstall_installed='false'
    local uninstall_command_path='null'
    if [ -n "$uninstall_remaining" ]; then
      uninstall_installed='true'
      uninstall_command_path="\"$(json_escape "$uninstall_remaining")\""
    fi

    if [ "$emit_json" = 'true' ]; then
      printf '{'
      printf '"helper":"%s-%s-native-installer",' "$platform" "$provider"
      printf '"mode":"uninstall",'
      printf '"status":"%s",' "$uninstall_status"
      printf '"installed":%s,' "$uninstall_installed"
      printf '"commandPath":%s,' "$uninstall_command_path"
      printf '"detectedVersion":null,'
      printf '"plannedActions":'
      json_string_array "${uninstall_planned[@]}"
      printf ','
      printf '"appliedChanges":'
      json_string_array "${uninstall_applied[@]}"
      printf ','
      printf '"warnings":'
      json_string_array "${uninstall_warnings[@]}"
      printf ','
      if [ -n "$uninstall_remaining" ]; then
        printf '"manualSteps":["Remove the remaining %s install at %s using your package manager."],' \
          "$(json_escape "$display_name")" "$(json_escape "$uninstall_remaining")"
      else
        printf '"manualSteps":[],'
      fi
      printf '"interruptions":[]'
      printf '}\n'
    else
      case "$uninstall_status" in
        preview)
          printf '%s preview: %s path(s) planned for removal.\n' "$display_name" "${#uninstall_planned[@]}"
          ;;
        not_installed)
          printf '%s is not installed; nothing to remove.\n' "$display_name"
          ;;
        changes_required)
          printf '%s removal incomplete; remaining install at %s.\n' "$display_name" "$uninstall_remaining"
          ;;
        uninstalled)
          printf '%s removed.\n' "$display_name"
          ;;
      esac
    fi
    return 0
  fi

  if command_path="$(detect_provider_command "$platform" "$provider")"; then
    initial_installed='true'
    detected_version="$(provider_version_line "$command_path" "$provider")"
    if [ "$check_only" = 'true' ]; then
      if [ "$emit_json" = 'true' ]; then
        printf '{'
        printf '"helper":"%s-%s-native-installer",' "$platform" "$provider"
        printf '"mode":"check",'
        printf '"status":"ready",'
        printf '"installed":true,'
        printf '"commandPath":"%s",' "$(json_escape "$command_path")"
        printf '"detectedVersion":"%s",' "$(json_escape "$detected_version")"
        printf '"plannedActions":[],'
        printf '"appliedChanges":[],'
        printf '"warnings":[],'
        printf '"manualSteps":[],'
        printf '"interruptions":[]'
        printf '}\n'
      else
        printf '%s installed: %s\n' "$display_name" "$detected_version"
      fi
      return 0
    fi

    if [ "$force" = 'false' ] && [ "$upgrade" = 'false' ]; then
      ensure_provider_bin_path_export "$shell_rc" "$provider"
      ensure_provider_alias "$shell_rc" "$provider"
      if [ "$emit_json" = 'true' ]; then
        printf '{'
        printf '"helper":"%s-%s-native-installer",' "$platform" "$provider"
        printf '"mode":"%s",' "$execution_mode"
        printf '"status":"ready",'
        printf '"installed":true,'
        printf '"commandPath":"%s",' "$(json_escape "$command_path")"
        printf '"detectedVersion":"%s",' "$(json_escape "$detected_version")"
        printf '"plannedActions":[],'
        printf '"appliedChanges":[],'
        printf '"warnings":[],'
        printf '"manualSteps":[],'
        printf '"interruptions":[]'
        printf '}\n'
      else
        printf '%s already installed: %s\n' "$display_name" "$detected_version"
      fi
      return 0
    fi
  else
    if [ "$check_only" = 'true' ]; then
      if [ "$emit_json" = 'true' ]; then
        printf '{'
        printf '"helper":"%s-%s-native-installer",' "$platform" "$provider"
        printf '"mode":"check",'
        printf '"status":"changes_required",'
        printf '"installed":false,'
        printf '"commandPath":null,'
        printf '"detectedVersion":null,'
        printf '"plannedActions":'
        json_string_array "install_${provider}_cli"
        printf ','
        printf '"appliedChanges":[],'
        printf '"warnings":[],'
        printf '"manualSteps":[],'
        printf '"interruptions":[]'
        printf '}\n'
        return 0
      fi
      printf '%s is not installed.\n' "$display_name" >&2
      return 1
    fi
  fi

  case "$execution_mode" in
    force) planned_actions=("reinstall_${provider}_cli") ;;
    upgrade)
      if [ "$initial_installed" = 'true' ]; then
        planned_actions=("upgrade_${provider}_cli")
      else
        planned_actions=("install_${provider}_cli")
      fi
      ;;
    apply)
      planned_actions=("install_${provider}_cli")
      ;;
  esac

  if [ "$dry_run" = 'true' ]; then
    if [ "$emit_json" = 'true' ]; then
      local dry_run_command_path='null'
      local dry_run_detected_version='null'
      if [ -n "$command_path" ]; then
        dry_run_command_path="\"$(json_escape "$command_path")\""
      fi
      if [ -n "$detected_version" ]; then
        dry_run_detected_version="\"$(json_escape "$detected_version")\""
      fi

      printf '{'
      printf '"helper":"%s-%s-native-installer",' "$platform" "$provider"
      printf '"mode":"%s",' "$execution_mode"
      printf '"status":"preview",'
      printf '"installed":%s,' "$(json_bool "$initial_installed")"
      printf '"commandPath":%s,' "$dry_run_command_path"
      printf '"detectedVersion":%s,' "$dry_run_detected_version"
      printf '"plannedActions":'
      json_string_array "${planned_actions[@]}"
      printf ','
      printf '"appliedChanges":[],'
      printf '"warnings":'
      json_string_array 'Dry-run requested; installer invocation was skipped.'
      printf ','
      printf '"manualSteps":[],'
      printf '"interruptions":[]'
      printf '}\n'
    else
      printf '%s preview: %s\n' "$display_name" "${planned_actions[*]}"
    fi
    return 0
  fi

  local before_version="$detected_version" latest='' version_state=unknown
  local install_status=0 attempted=true final_installed=false observed_change=unchanged
  if [ "$upgrade" = true ] && [ "$force" = false ] && [ "$initial_installed" = true ]; then
    latest="$(cats_native_latest_version "$provider")"
    version_state="$(cats_native_version_state "$provider" "$detected_version" "$latest")"
    if [ "$version_state" = current ]; then
      attempted=false
      planned_actions=()
    elif [ -z "$latest" ] && [ "$provider" != claude ] && [ "$provider" != muse ]; then
      warnings+=('Could not compare the published version; the official installer will verify the update.')
    fi
  fi
  if [ "$attempted" = true ]; then
    printf 'Installing %s...\n' "$display_name" >&2
    if [ "$force" = true ]; then
      run_provider_install_action "$platform" "$provider" force || install_status=$?
    elif [ "$upgrade" = true ]; then
      run_provider_install_action "$platform" "$provider" upgrade || install_status=$?
    else
      run_provider_install_action "$platform" "$provider" install || install_status=$?
    fi
  fi
  hash -r
  if [ "$install_status" -eq 0 ]; then
    ensure_provider_bin_path_export "$shell_rc" "$provider"
    ensure_provider_alias "$shell_rc" "$provider"
  fi
  for attempt in 1 2 3; do
    if command_path="$(detect_provider_command "$platform" "$provider")"; then
      final_installed=true
      detected_version="$(provider_version_line "$command_path" "$provider")"
      break
    fi
    [ "$install_status" -eq 0 ] && [ "$attempted" = true ] || break
    sleep 2
  done
  local final_status=ready
  if [ "$install_status" -ne 0 ] || [ "$final_installed" = false ]; then
    final_status=failed
    observed_change=failed
    warnings+=("Installer or verification failed (exit $install_status); any previous installation is shown separately.")
  elif [ "$attempted" = false ]; then observed_change=unchanged
  elif [ "$initial_installed" = false ]; then observed_change=installed
  elif [ -n "$before_version" ] && [ -n "$detected_version" ] && [ "$before_version" != "$detected_version" ]; then
    case "$(cats_version_compare "$(cats_native_version_token "$provider" "$detected_version")" "$(cats_native_version_token "$provider" "$before_version")")" in
      1) observed_change=upgraded ;; -1) observed_change=downgraded ;; *) observed_change=version_changed ;;
    esac
  else observed_change=unchanged; fi
  if [ "$final_status" = ready ] && { [ "$upgrade" = true ] || [ "$force" = true ]; }; then
    cats_cleanup_native_versions "$provider" "$detected_version" || true
  fi
  case "$observed_change" in
    installed|upgraded|downgraded|version_changed) applied_changes=("${observed_change}_${provider}_installation") ;;
  esac
  if [ "$emit_json" = true ]; then
    printf '{"helper":"%s-%s-native-installer","mode":"%s","status":"%s",' "$platform" "$provider" "$execution_mode" "$final_status"
    printf '"installed":%s,"commandPath":"%s","detectedVersion":"%s",' "$final_installed" "$(json_escape "$command_path")" "$(json_escape "$detected_version")"
    printf '"previousVersion":"%s","observedChange":"%s",' "$(json_escape "$before_version")" "$observed_change"
    printf '"summary":"%s: %s -> %s",' "$observed_change" "$(json_escape "$before_version")" "$(json_escape "$detected_version")"
    printf '"plannedActions":'; json_string_array "${planned_actions[@]}"
    printf ',"appliedChanges":'; json_string_array "${applied_changes[@]}"
    printf ',"warnings":'; json_string_array "${warnings[@]}"
    printf ',"manualSteps":'; json_string_array "$(provider_manual_steps "$provider")"
    printf ',"interruptions":[]}\n'
  else
    printf '%s %s: %s -> %s\n' "$display_name" "$observed_change" "$before_version" "$detected_version"
  fi
  [ "$final_status" = ready ]
}
