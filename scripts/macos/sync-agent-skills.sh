#!/bin/bash
# Sync canonical skills and resources to local host discovery paths.
# Usage: sync-agent-skills.sh [--project-root DIR] [--agent claude|codex] [--clean]
# Replaces matching canonical names only; preserves unrelated skills. Rejects symlinks.
# .agents is shared by Codex and Antigravity CLI (agy).
set -e
usage() {
    echo "Usage: $0 [--project-root DIR] [--agent claude|codex] [--clean]"
    echo "  --clean is a compatibility flag; unrelated discovery skills are never removed."
}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
AGENT=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --project-root|--agent)
            if [ "$#" -lt 2 ]; then usage; exit 1; fi
            if [ "$1" = --project-root ]; then PROJECT_ROOT="$2"; else AGENT="$2"; fi
            shift 2 ;;
        --clean) shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage; exit 1 ;;
    esac
done
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd -P)"
[ -f "$PROJECT_ROOT/AGENTS.md" ] || { echo "Project root must contain AGENTS.md." >&2; exit 1; }
case "$AGENT" in ""|claude|codex) ;; *) usage; exit 1 ;; esac
HOSTS=(.claude .agents)
case "$AGENT" in claude) HOSTS=(.claude) ;; codex) HOSTS=(.agents) ;; esac
SKILLS_DIR="$PROJECT_ROOT/skills"
[ -d "$SKILLS_DIR" ] || { echo "No canonical skills directory." >&2; exit 1; }
reject_links() {
    if [ -L "$1" ] || { [ -d "$1" ] && [ -n "$(find "$1" -type l -print -quit)" ]; }; then
        echo "Refusing linked skill path: $1" >&2
        exit 1
    fi
}
reject_links "$SKILLS_DIR"
SKILLS=()
for skill in "$SKILLS_DIR/"*/; do
    [ -f "$skill/SKILL.md" ] || continue
    name="${skill%/}"; name="${name##*/}"
    if [[ ! "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || [ "${#name}" -gt 64 ]; then
        echo "Invalid skill directory: $name" >&2; exit 1
    fi
    SKILLS+=("$name")
done
# Validate all roots before changing any host.
for host in "${HOSTS[@]}"; do
    [ ! -L "$PROJECT_ROOT/$host" ] || { echo "Linked discovery root." >&2; exit 1; }
    reject_links "$PROJECT_ROOT/$host/skills"
done
for host in "${HOSTS[@]}"; do
    target_dir="$PROJECT_ROOT/$host/skills"
    mkdir -p "$target_dir"
    for name in "${SKILLS[@]}"; do
        target="$target_dir/$name"
        case "$target" in "$PROJECT_ROOT"/.claude/skills/*|"$PROJECT_ROOT"/.agents/skills/*) ;; *) exit 1 ;; esac
        if [ -e "$target" ]; then rm -r -- "$target"; fi
        mkdir -p "$target"
        while IFS= read -r -d '' source; do
            relative="${source#"$SKILLS_DIR/$name/"}"
            destination="$target/$relative"
            mkdir -p "$(dirname "$destination")"
            cp -p "$source" "$destination"
        done < <(find "$SKILLS_DIR/$name" -type f -not -iname '*.bootstrap' -print0)
    done
    echo "Synced ${#SKILLS[@]} skills to $host."
done
