#!/usr/bin/env bash
# PostToolUse hook: after an edit to this repo's marketplace or plugin manifest, run `task validate`
# and report failures to Claude (exit 2 shows stderr to Claude; the edit itself is not undone).
set -euo pipefail

root=${CLAUDE_PROJECT_DIR:?}
file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
  "$root"/.claude-plugin/marketplace.json | "$root"/plugins/*/.claude-plugin/plugin.json) ;;
  *) exit 0 ;;
esac

if ! out=$(cd "$root" && mise exec -- task validate 2>&1); then
  printf 'task validate failed after editing %s:\n%s\n' "${file#"$root"/}" "$out" >&2
  exit 2
fi
