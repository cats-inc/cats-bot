#!/usr/bin/env bash
# Usage: source verified-npm-update.sh; cats_upgrade_npm
# Explicit npm upgrade only. Adapted from environment-bootstrap 4690075.
# Preserve the current prefix (including nvm), enforce engines, verify command and package.
cats_upgrade_npm() {
  local current latest installed root
  current="$(npm --version)" || { printf 'Could not read npm version.\n' >&2; return 1; }
  latest="$(npm view npm@latest version --fetch-retries=0 --fetch-timeout=10000 --loglevel=error)" || { printf 'npm version query failed.\n' >&2; return 1; }
  [[ "$latest" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'Invalid npm version metadata.\n' >&2; return 1; }
  [ "$current" != "$latest" ] || return 0
  [ "$(cats_version_compare "$current" "$latest")" != 1 ] || return 0
  npm install -g "npm@$latest" --engine-strict --fetch-retries=0 --fetch-timeout=30000 || return 1
  hash -r
  installed="$(npm --version)" && root="$(npm root -g)" || return 1
  [ "$installed" = "$latest" ] && node -e '
    const path = require("path");
    const pkg = require(path.join(process.argv[1], "npm", "package.json"));
    process.exit(pkg.version === process.argv[2] ? 0 : 1);
  ' "$root" "$latest" || { printf 'npm verification failed. Check PATH and prefix.\n' >&2; return 1; }
}
