#!/bin/bash
#
# Remove local branches whose upstream was deleted after the pull request merged.
#
# Intended as the opening step of a working session, and especially useful in a
# clone that several people or agents share.
#
# When a pull request is squash-merged and its head branch is deleted on the
# remote, the local branch stays behind, and `git branch -d` refuses to remove
# it: a squashed commit has a different SHA than the branch it came from, so the
# branch never looks fully merged. This script starts from upstream state rather
# than commit reachability: a branch is a candidate once it had an upstream and
# that upstream is gone.
#
# A gone upstream alone is not proof of a merge, though. A pull request closed
# without merging and a branch that gained commits after its merge look exactly
# the same. So a candidate is deleted only when the default branch already
# contains everything on it: merging the branch into the default branch would
# change nothing, or a commit on the default branch carries exactly the branch's
# tree (a branch rebased before its squash merge). Any other candidate is kept
# and reported, with the command to delete it by hand.
#
# A branch that was never pushed has no upstream at all and can never be
# reported as gone, so local-only work is never swept. Branches checked out in
# another worktree are reported and skipped, and the default branch is never
# removed. The landed check needs Git 2.38 or newer; an older Git keeps every
# candidate and says so.
#
# The working tree must be clean. A clean tree is not enough to leave a branch,
# though: someone may have committed and be waiting on CI. --return-to-default
# only moves off a branch whose upstream is gone, and otherwise stays with a
# warning. A fast-forward that fails is reported as a warning, not as success.
#
# Run `git config --global fetch.prune true` once per machine so the gone markers
# appear without passing --prune on every fetch.
#
# Usage: ./remove-merged-branches.sh [OPTIONS]
#
# Options:
#   -n, --dry-run              Show what would be removed without changing anything
#   -r, --return-to-default    Switch to the default branch and fast-forward afterwards
#   -s, --skip-fetch           Skip `git fetch --prune`
#   -C, --repository-root DIR  Operate on DIR instead of the current repository
#   -h, --help                 Show this help message
#
# Examples:
#   ./remove-merged-branches.sh --dry-run
#   ./remove-merged-branches.sh --return-to-default
#

set -euo pipefail

DRY_RUN=false
RETURN_TO_DEFAULT=false
SKIP_FETCH=false
REPOSITORY_ROOT=""

usage() {
  cat <<'EOF'
Remove local branches whose upstream was deleted after the pull request merged.

Usage: ./remove-merged-branches.sh [OPTIONS]

Options:
  -n, --dry-run              Show what would be removed without changing anything
  -r, --return-to-default    Switch to the default branch and fast-forward afterwards
  -s, --skip-fetch           Skip git fetch --prune
  -C, --repository-root DIR  Operate on DIR instead of the current repository
  -h, --help                 Show this help message

Examples:
  ./remove-merged-branches.sh --dry-run
  ./remove-merged-branches.sh --return-to-default
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=true; shift ;;
    -r|--return-to-default) RETURN_TO_DEFAULT=true; shift ;;
    -s|--skip-fetch) SKIP_FETCH=true; shift ;;
    -C|--repository-root)
      if [ $# -lt 2 ]; then
        echo "Missing directory for $1" >&2
        exit 2
      fi
      REPOSITORY_ROOT="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

start_dir="${REPOSITORY_ROOT:-$PWD}"
if ! repo_root="$(git -C "$start_dir" rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Not a git repository: $start_dir" >&2
  exit 1
fi

git_repo() {
  git -C "$repo_root" "$@"
}

# A dirty tree in a shared clone is somebody else's unfinished work.
dirty_count="$(git_repo status --porcelain | grep -c '' || true)"
if [ "$dirty_count" != "0" ]; then
  echo "Working tree is not clean ($dirty_count entries). Resolve or stash that work before sweeping branches." >&2
  exit 1
fi

# Stale worktree registrations keep their branches undeletable, so clear them
# before deciding what can go.
git_repo worktree prune

# A failed fetch is not fatal. `gone` is recorded by an earlier successful prune
# and stays accurate, so the worst an offline run can do is miss a branch that
# was merged since the last fetch - it can never delete the wrong one.
if [ "$SKIP_FETCH" = false ]; then
  if ! git_repo fetch --prune >/dev/null 2>&1; then
    echo "warning: git fetch --prune failed; sweeping on the upstream state already recorded." >&2
    echo "warning: branches merged since the last successful fetch will not be detected yet." >&2
  fi
fi

fast_forward_default() {
  local before after output
  if ! git_repo rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    # An unborn branch has no commit to fast-forward from yet.
    echo "  stay   $default_branch (no commits yet)"
    return 0
  fi
  before="$(git_repo rev-parse --short HEAD)"
  if ! git_repo rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    # A freshly initialized project has nothing to fast-forward from yet.
    echo "  stay   $default_branch (no upstream to fast-forward from, at $before)"
    return 0
  fi

  if ! output="$(git_repo pull --ff-only 2>&1)"; then
    # Offline, a local branch that diverged, or another process holding the
    # index lock. None of them damage anything, but reporting success would
    # leave a stale default branch looking current.
    echo "warning: git pull --ff-only failed, so '$default_branch' stays at $before." >&2
    printf '%s\n' "$output" >&2
    return 0
  fi

  after="$(git_repo rev-parse --short HEAD)"
  if [ "$after" = "$before" ]; then
    echo "  pull   $default_branch (already up to date at $after)"
  else
    echo "  pull   $default_branch (fast-forwarded $before..$after)"
  fi
}

local_branch_exists() {
  if [ -z "${1:-}" ]; then
    return 1
  fi
  git_repo show-ref --verify --quiet "refs/heads/$1"
}

remote_default_branch() {
  local ref
  ref="$(git_repo symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "$ref" ]; then
    printf '%s\n' "${ref#refs/remotes/origin/}"
  fi
}

# origin/HEAD records what the remote considers default. Without it - no remote,
# or one that has never been reachable - guessing a name is how a freshly
# initialized project breaks, because init.defaultBranch varies by machine. Only
# return a branch that actually exists.
resolve_default_branch() {
  local name configured candidate
  name="$(remote_default_branch)"
  if [ -n "$name" ]; then
    printf '%s\n' "$name"
    return
  fi

  git_repo remote set-head origin --auto >/dev/null 2>&1 || true
  name="$(remote_default_branch)"
  if [ -n "$name" ]; then
    printf '%s\n' "$name"
    return
  fi

  configured="$(git_repo config --get init.defaultBranch 2>/dev/null || true)"
  for candidate in "$configured" main master; do
    if local_branch_exists "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
}

default_branch="$(resolve_default_branch)"

# The merge landed on the remote, so compare against its default branch when the
# clone tracks one. A local default branch that is behind would only make a
# merged branch look unmerged, never the other way round, so it is an acceptable
# fallback for a clone without a remote.
resolve_landed_ref() {
  if [ -z "$default_branch" ]; then
    return 0
  fi
  if git_repo show-ref --verify --quiet "refs/remotes/origin/$default_branch"; then
    printf '%s\n' "refs/remotes/origin/$default_branch"
  else
    printf '%s\n' "refs/heads/$default_branch"
  fi
}

# Prints landed, unmerged, no_default or unsupported for branch $1 against ref $2.
branch_landed() {
  local name="$1" into="$2" merged code into_tree merged_tree tip_tree base
  if [ -z "$into" ]; then
    echo no_default
    return 0
  fi

  # A squash merge leaves nothing to find by commit reachability, so ask what
  # merging the branch into the default branch would produce. When that tree
  # equals the default branch's own tree, the branch has nothing left to add.
  code=0
  merged="$(git_repo merge-tree --write-tree --no-messages "$into" "$name" 2>/dev/null)" || code=$?
  if [ "$code" -gt 1 ]; then
    # Exit 1 is a conflicting merge, which the tree check below can still
    # settle. Anything else is a usage error (Git before 2.38 has no
    # --write-tree) or a broken repository, neither of which proves anything.
    echo unsupported
    return 0
  fi
  into_tree="$(git_repo rev-parse "$into^{tree}")"
  merged_tree="$(printf '%s\n' "$merged" | head -n 1)"
  if [ "$code" -eq 0 ] && [ "$merged_tree" = "$into_tree" ]; then
    echo landed
    return 0
  fi

  # A branch rebased before its squash merge leaves a commit on the default
  # branch with exactly its tree, even when the default branch has since
  # changed the same files and the merge above conflicted.
  tip_tree="$(git_repo rev-parse "$name^{tree}")"
  if base="$(git_repo merge-base "$into" "$name" 2>/dev/null)" && [ -n "$base" ]; then
    if git_repo log --format=%T "$base..$into" | grep -Fxq -- "$tip_tree"; then
      echo landed
      return 0
    fi
  fi

  echo unmerged
}

landed_into="$(resolve_landed_ref)"
landed_label="${landed_into#refs/remotes/}"
landed_label="${landed_label#refs/heads/}"

current_branch="$(git_repo branch --show-current)"

# Branches held by another worktree cannot be deleted; git blocks it for us, but
# reporting them is more useful than surfacing a raw error.
worktree_branches=""
while IFS= read -r line; do
  case "$line" in
    "branch refs/heads/"*)
      held="${line#branch refs/heads/}"
      if [ "$held" != "$current_branch" ]; then
        worktree_branches="${worktree_branches}${held}"$'\n'
      fi
      ;;
  esac
done < <(git_repo worktree list --porcelain)

is_worktree_held() {
  printf '%s' "$worktree_branches" | grep -Fxq -- "$1"
}

blocked=()
deletable=()
# Only a landed current branch may be left; a detached HEAD has no branch at all.
current_merged=false
while IFS="$(printf '\t')" read -r name track; do
  if [ "$track" != "gone" ]; then
    continue
  fi
  # The default branch tracks a live upstream and should never reach this list,
  # but never delete the branch everything else falls back to.
  if [ -n "$default_branch" ] && [ "$name" = "$default_branch" ]; then
    continue
  fi
  # A gone upstream is only the trigger. Prove that the candidate has landed
  # before it can be deleted; keep and report the rest (see branch_landed).
  case "$(branch_landed "$name" "$landed_into")" in
    landed) ;;
    unmerged)
      echo "  keep   $name (upstream gone, but '$landed_label' does not contain all of its changes; delete it yourself with git branch -D $name once you are sure)"
      continue
      ;;
    no_default)
      echo "  keep   $name (upstream gone, but there is no default branch to check it against)"
      continue
      ;;
    *)
      echo "  keep   $name (upstream gone, but git could not verify that it landed; the check needs Git 2.38 or newer)"
      continue
      ;;
  esac
  if [ -n "$current_branch" ] && [ "$name" = "$current_branch" ]; then
    current_merged=true
  fi
  if is_worktree_held "$name"; then
    blocked+=("$name")
  else
    deletable+=("$name")
  fi
done < <(git_repo for-each-ref --format='%(refname:short)%09%(upstream:track,nobracket)' refs/heads)

for name in ${blocked[@]+"${blocked[@]}"}; do
  echo "  skip   $name (checked out in another worktree)"
done

if [ ${#deletable[@]} -eq 0 ]; then
  echo "No merged branches to remove."
else
  # A checked-out branch cannot be deleted, so step off it first.
  if [ -n "$current_branch" ] && printf '%s\n' "${deletable[@]}" | grep -Fxq -- "$current_branch"; then
    if [ -z "$default_branch" ]; then
      echo "  skip   $current_branch (checked out, and no default branch to switch to)"
      remaining=()
      for name in "${deletable[@]}"; do
        if [ "$name" != "$current_branch" ]; then
          remaining+=("$name")
        fi
      done
      deletable=(${remaining[@]+"${remaining[@]}"})
    elif [ "$DRY_RUN" = true ]; then
      echo "  would switch to $default_branch (leaving '$current_branch' so it can be removed)"
    else
      if ! git_repo switch "$default_branch" >/dev/null 2>&1; then
        echo "Failed to switch to $default_branch." >&2
        exit 1
      fi
      echo "  switch $default_branch (left '$current_branch' so it can be removed)"
      current_branch="$default_branch"
    fi
  fi

  for name in ${deletable[@]+"${deletable[@]}"}; do
    # -D, not -d: a squashed branch is never reachable from the default branch,
    # so -d refuses every time. branch_landed supplied the merge evidence above.
    sha="$(git_repo rev-parse --short "$name")"
    if [ "$DRY_RUN" = true ]; then
      echo "  would delete $name (was $sha)"
    else
      git_repo branch -D "$name" >/dev/null
      echo "  delete $name (was $sha)"
    fi
  done
fi

if [ "$RETURN_TO_DEFAULT" = true ]; then
  if [ -z "$default_branch" ]; then
    echo "warning: no default branch could be determined, so --return-to-default did nothing." >&2
  elif [ "$current_branch" != "$default_branch" ] && [ "$current_merged" = false ]; then
    # A clean tree only shows the work was committed. In a shared clone this
    # branch may be someone else's, still waiting on its pull request.
    if [ -n "$current_branch" ]; then
      position="'$current_branch', which has not merged (its upstream still exists, it was never pushed, or it still holds changes '$default_branch' lacks)"
    else
      position="a detached HEAD"
    fi
    echo "warning: staying on $position, so --return-to-default did not switch to or fast-forward '$default_branch'. Switch yourself once nobody is working here." >&2
  elif [ "$DRY_RUN" = true ]; then
    echo "  would switch to $default_branch and fast-forward"
  else
    if [ "$current_branch" != "$default_branch" ]; then
      if ! git_repo switch "$default_branch" >/dev/null 2>&1; then
        echo "Failed to switch to $default_branch." >&2
        exit 1
      fi
      echo "  switch $default_branch (left merged '$current_branch')"
    fi
    fast_forward_default
  fi
fi
