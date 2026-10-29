#!/usr/bin/env bash
# Source this file for passive native version comparison and bounded vendor queries.
# Usage: source provider-version-common.sh; cats_native_latest_version <provider>
# Adapted from environment-bootstrap shared/posix/upstream-version.sh at 752dc13.
# Queries return an empty value on failure; check-only mode never invokes them.
cats_version_token() {
    printf '%s' "$1" | tr -d '\r' | grep -oE '[0-9]+(\.[0-9]+)+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*|\.[A-Za-z][0-9A-Za-z]*(\.[0-9]+)*)?' | head -n 1 || true
}

# cats_version_compare <a> <b>
# 只比數字段、補滿四段：印 -1（a 較舊）、0、1（a 較新）；任一邊解析不出版本印空字串。
# 空字串要當成「無法比較、交回原本流程」，不能當成落後，否則查不到版本時每次都會重裝。
cats_version_compare() {
    local a b i x y
    a="$(printf '%s' "$1" | tr -d '\r' | grep -oE '[0-9]+(\.[0-9]+)*' | head -n 1 || true)"
    b="$(printf '%s' "$2" | tr -d '\r' | grep -oE '[0-9]+(\.[0-9]+)*' | head -n 1 || true)"
    if [ -z "$a" ] || [ -z "$b" ]; then
        printf ''
        return 0
    fi

    i=1
    while [ "$i" -le 4 ]; do
        x="$(printf '%s' "$a" | awk -F. -v n="$i" '{print $n}')"
        y="$(printf '%s' "$b" | awk -F. -v n="$i" '{print $n}')"
        [ -n "$x" ] || x=0
        [ -n "$y" ] || y=0
        if [ "$((10#$x))" -lt "$((10#$y))" ]; then printf -- '-1'; return 0; fi
        if [ "$((10#$x))" -gt "$((10#$y))" ]; then printf '1'; return 0; fi
        i=$((i + 1))
    done
    printf '0'
}

# _cats_json_string_field <field> ：從 stdin 的 JSON 文字撈第一個 "field":"value" 的 value
_cats_json_string_field() {
    grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/'
}

# cats_github_latest_release <owner/repo>
# GitHub Releases 的最新穩定版 tag（去掉開頭的 v）；失敗印空。
cats_github_latest_release() {
    local json
    json="$(curl -fsSL --connect-timeout 5 --max-time 20 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$1/releases/latest" 2>/dev/null)" || return 0
    printf '%s' "$json" | _cats_json_string_field tag_name | sed 's/^v//' || true
}

# cats_antigravity_latest_version [已下載的官方 install.sh]
# 官方腳本讀的是 $DOWNLOAD_BASE_URL/manifests/<platform>.json 的 version。
# 傳入抓下來的腳本可以順便從裡面撈 base URL，官方搬家時就不必改這裡；撈不到用寫死的。
# platform 的算法照抄官方（darwin_arm64 / linux_amd64 / linux_amd64_musl …）。
cats_antigravity_latest_version() {
    local base='https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
    local found os arch platform

    if [ -n "${1:-}" ] && [ -r "$1" ]; then
        found="$(grep -oE 'DOWNLOAD_BASE_URL="https://[^"]+"' "$1" | head -n 1 | sed -E 's/^DOWNLOAD_BASE_URL="(.*)"$/\1/')"
        [ -n "$found" ] && base="$found"
    fi

    case "$(uname -s)" in
        Darwin) os=darwin ;;
        Linux)  os=linux ;;
        *) return 0 ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64)  arch=amd64 ;;
        arm64|aarch64) arch=arm64 ;;
        *) return 0 ;;
    esac
    if [ "$os" = linux ] && { [ -f /lib/libc.musl-x86_64.so.1 ] || [ -f /lib/libc.musl-aarch64.so.1 ] || ldd /bin/ls 2>&1 | grep -q musl; }; then
        platform="linux_${arch}_musl"
    else
        platform="${os}_${arch}"
    fi

    curl -fsSL --connect-timeout 5 --max-time 20 "$base/manifests/$platform.json" 2>/dev/null | _cats_json_string_field version || true
}

# cats_cursor_agent_latest_version <已下載的官方 install 腳本>
# 官方 https://cursor.com/install 是支寫死版本的腳本，目錄名就是版本
# （…/versions/2026.09.10-fd3934a）。版本是「日期-commit」，cats_version_compare 只比得到
# 日期，同日不同 commit 由呼叫端用字串相等另判。
cats_cursor_agent_latest_version() {
    [ -n "${1:-}" ] && [ -r "$1" ] || return 0
    grep -oE 'versions/[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9A-Za-z]+' "$1" | head -n 1 | sed 's#^versions/##' || true
}

# cats_junie_latest_build
# 官方 install.sh 讀 GitHub raw 的 update-info.jsonl：一行一個 build，version 是 build 號
# （3110.7，也是 versions/ 底下的目錄名）、marketing 才是 26.9.7、platform 是
# linux-amd64 / macos-aarch64 這種。印本平台最大的 build 號；失敗印空。
cats_junie_latest_build() {
    local os arch platform jsonl line v best=''

    case "$(uname -s)" in
        Darwin) os=macos ;;
        Linux)  os=linux ;;
        *) return 0 ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64)  arch=amd64 ;;
        arm64|aarch64) arch=aarch64 ;;
        *) return 0 ;;
    esac
    platform="${os}-${arch}"

    jsonl="$(curl -fsSL --connect-timeout 5 --max-time 20 'https://raw.githubusercontent.com/jetbrains-junie/junie/main/update-info.jsonl' 2>/dev/null)" || return 0

    while IFS= read -r line; do
        case "$line" in
            *"\"platform\":\"$platform\""*) ;;
            *) continue ;;
        esac
        v="$(printf '%s' "$line" | _cats_json_string_field version || true)"
        [ -n "$v" ] || continue
        if [ -z "$best" ] || [ "$(cats_version_compare "$v" "$best")" = "1" ]; then
            best="$v"
        fi
    done <<< "$jsonl"

    printf '%s' "$best"
}

# cats_kiro_latest_version
# Kiro 的官方 installer 讀 stable/latest/manifest.json（Windows 版 Install-KiroCLI.ps1
# 用的是同一份），欄位 version。
cats_kiro_latest_version() {
    curl -fsSL --connect-timeout 5 --max-time 20 'https://prod.download.cli.kiro.dev/stable/latest/manifest.json' 2>/dev/null | _cats_json_string_field version || true
}

# cats_devin_latest_version
# Devin 的官方 install.sh 與 Windows 版 setup.ps1 讀的都是 cli/current/manifest.json，欄位
# version（3000.10.27）。官方腳本同版雖不重抓，POSIX 版仍會重建兩個符號連結、Windows 版更會
# 無條件重寫 180 MB 的 devin.exe；先問這裡，同版就完全不動。
cats_devin_latest_version() {
    curl -fsSL --connect-timeout 5 --max-time 20 'https://static.devin.ai/cli/current/manifest.json' 2>/dev/null | _cats_json_string_field version || true
}

# cats_grok_latest_version [channel]
# Grok 的官方 install.sh（與 Windows 的 install.ps1）決定要下載哪一版，靠的只是一個純文字端點：
# https://x.ai/cli/<channel>（Cloudflare 前端）不通就退到 GCS 上的同名檔案，內容就是版本號
# （1.0.30）。這裡照抄同一套順序；channel 預設跟官方一樣吃 GROK_CHANNEL（stable）。
# 三平台都問這裡，刻意不用 `grok update --check --json`：那要執行 grok 本體去連 x.ai 做 TLS
# 交握，而 grok 的 TLS 實作用到 SHA-512 硬體指令（sha512su0），沒有這個擴充的 aarch64
# （Raspberry Pi 4/5 的 Cortex-A72/A76）會當場 SIGILL、輸出全空 —— 見 CLAUDE.md Known Gotchas。
# 這個端點不必執行任何工具，問到的也正是安裝器接下來會抓的版本。失敗印空。
cats_grok_latest_version() {
    local channel="${1:-${GROK_CHANNEL:-stable}}" url v
    for url in "https://x.ai/cli/${channel}" "https://storage.googleapis.com/grok-build-public-artifacts/cli/${channel}"; do
        v="$(curl -fsSL --connect-timeout 5 --max-time 20 "$url" 2>/dev/null | tr -d '\r' | head -n 1 | tr -d '[:space:]' || true)"
        if printf '%s' "$v" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._]+)?$'; then
            printf '%s' "$v"
            return 0
        fi
    done
    printf ''
}


cats_native_latest_version() {
  local script
  case "$1" in
    antigravity) cats_antigravity_latest_version ;;
    cursor)
      script="$(curl -fsSL --connect-timeout 5 --max-time 20 https://cursor.com/install 2>/dev/null)" || return 0
      printf '%s' "$script" | grep -oE 'versions/[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9A-Za-z]+' | head -n 1 | sed 's#^versions/##' || true
      ;;
    goose) cats_github_latest_release aaif-goose/goose ;;
    junie) cats_junie_latest_build ;;
    kiro) cats_kiro_latest_version ;;
    devin) cats_devin_latest_version ;;
    grok) cats_grok_latest_version ;;
    *) return 0 ;;
  esac
}

cats_native_version_token() {
  if [ "$1" = junie ]; then
    printf '%s' "$2" | sed -nE 's/.*\(([0-9]+(\.[0-9]+)+)\).*/\1/p' | head -n 1 || true
  else
    cats_version_token "$2"
  fi
}

# Print current/older/unknown; Cursor same-day hashes are distinct releases.
cats_native_version_state() {
  local current latest comparison
  current="$(cats_native_version_token "$1" "$2")"
  latest="$3"
  [ -n "$current" ] && [ -n "$latest" ] || { printf unknown; return 0; }
  comparison="$(cats_version_compare "$current" "$latest")"
  if [ "$comparison" = 1 ] || { [ "$comparison" = 0 ] && { [ "$1" != cursor ] || [ "$current" = "$latest" ]; }; }; then
    printf current
  elif [ -n "$comparison" ]; then printf older
  else printf unknown; fi
}

# Delete only older numeric version directories in a known installer-owned tree.
# Current/pending/newer builds, symlinks and custom locations outside HOME remain.
cats_cleanup_native_versions() {
  local provider="$1" version="$2" root='' data='' keep='' actual='' directory='' name='' ancestor=''
  keep="$(cats_native_version_token "$provider" "$version")"
  [ -n "$keep" ] || return 0
  case "$provider" in
    cursor)
      root="$HOME/.local/share/cursor-agent/versions"
      [ -L "$HOME/.local/bin/cursor-agent" ] || return 0
      actual="$(readlink "$HOME/.local/bin/cursor-agent")" || return 0
      [ "$(basename "$(dirname "$actual")")" = "$keep" ] || return 0
      ;;
    devin)
      root="${XDG_DATA_HOME:-$HOME/.local/share}/devin/cli/_versions"
      [ -L "$root/current" ] || return 0
      actual="$(readlink "$root/current")" || return 0
      [ "$(basename "$actual")" = "$keep" ] || return 0
      ;;
    junie)
      data="${JUNIE_DATA_DIR:-$HOME/.local/share/junie}"
      root="$data/versions"
      [ ! -e "$data/updates/pending-update.json" ] && [ -L "$data/current" ] || return 0
      actual="$(readlink "$data/current")" || return 0
      [ "$(basename "$actual")" = "$keep" ] || return 0
      ;;
    *) return 0 ;;
  esac
  case "$root" in "$HOME"/*) ;; *) return 0 ;; esac
  [ -d "$root" ] || return 0
  ancestor="$root"
  while [ "$ancestor" != / ] && [ "$ancestor" != . ]; do
    [ ! -L "$ancestor" ] || return 0
    ancestor="$(dirname "$ancestor")"
  done
  local canonical_home
  canonical_home="$(cd -P -- "$HOME" && pwd -P)" || return 0
  root="$(cd -P -- "$root" && pwd -P)" || return 0
  case "$root" in "$canonical_home"/*) ;; *) return 0 ;; esac
  for directory in "$root"/*; do
    [ -d "$directory" ] && [ ! -L "$directory" ] || continue
    name="$(basename "$directory")"
    printf '%s' "$name" | grep -qE '^[0-9]+(\.[0-9]+)+(-[0-9A-Za-z]+)?$' || continue
    [ "$(cats_version_compare "$name" "$keep")" = -1 ] || continue
    # Skip directory trees with links rather than recurse through an unknown layout.
    [ -z "$(find "$directory" -type l -print 2>/dev/null)" ] || continue
    rm -rf -- "$directory" || printf 'Could not remove old %s build %s.\n' "$provider" "$name" >&2
  done
}
