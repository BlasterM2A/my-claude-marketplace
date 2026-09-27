setup() {
  load helpers
  export CLAUDE_CONFIG_DIR=$(mktemp -d)
  unset SP_ROOT AGENTS_DIR
  REPO=$(make_repo)
  PF="$BATS_TEST_DIRNAME/../scripts/preflight"
  CACHE="$CLAUDE_CONFIG_DIR/plugins/cache/claude-plugins-official/superpowers"
  make_superpowers 6.4.1
  make_superpowers 6.5.0
  mkdir -p "$CLAUDE_CONFIG_DIR/agents"
  mkdir -p "$REPO/docs"
  printf '# Plan\n\n### Task 1: A\n\n### Task 2: B\n' >"$REPO/docs/plan.md"
  git -C "$REPO" add docs && git -C "$REPO" commit -qm plan
}

teardown() { rm -rf "$REPO" "$CLAUDE_CONFIG_DIR"; }

make_superpowers() {
  local sdd="$CACHE/$1/skills/subagent-driven-development"
  mkdir -p "$sdd/scripts" "$CACHE/$1/skills/requesting-code-review"
  for f in scripts/sdd-workspace scripts/task-brief scripts/review-package implementer-prompt.md task-reviewer-prompt.md re-review-prompt.md; do
    touch "$sdd/$f"
  done
  touch "$CACHE/$1/skills/requesting-code-review/code-reviewer.md"
}

record_install() { # record_install VERSION [SCOPE] [PROJECT_PATH]
  jq -n --arg p "$CACHE/$1" --arg v "$1" --arg s "${2:-user}" --arg pp "${3:-}" \
    '{version: 2, plugins: {"superpowers@claude-plugins-official": [{scope: $s, installPath: $p, version: $v} + (if $pp == "" then {} else {projectPath: $pp} end)]}}' \
    >"$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"
}

user_agent() { printf -- '---\nname: %s\nmodel: sonnet\n---\n' "$1" >"$2/$1.md"; }

field() { printf '%s\n' "${lines[@]}" | sed -n "s/^$1=//p"; }

@test "without an install record, uses the newest cached superpowers and reports the task count" {
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 0 ]
  [ "$(field SP_SKILLS)" = "$CACHE/6.5.0/skills" ]
  [ "$(field TASKS)" = "2" ]
}

@test "uses the installed superpowers version, not the newest cache directory" {
  record_install 6.4.1
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 0 ]
  [ "$(field SP_SKILLS)" = "$CACHE/6.4.1/skills" ]
}

@test "a project-scoped install for this repo wins over the user install" {
  jq -n --arg c "$CACHE" --arg r "$REPO" '{version: 2, plugins: {"superpowers@claude-plugins-official": [
    {scope: "user", installPath: "\($c)/6.5.0", version: "6.5.0"},
    {scope: "project", projectPath: $r, installPath: "\($c)/6.4.1", version: "6.4.1"}]}}' \
    >"$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 0 ]
  [ "$(field SP_SKILLS)" = "$CACHE/6.4.1/skills" ]
}

@test "SP_ROOT overrides the install record" {
  record_install 6.4.1
  SP_ROOT="$CACHE" run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 0 ]
  [ "$(field SP_SKILLS)" = "$CACHE/6.5.0/skills" ]
}

@test "refuses superpowers older than 6.4.1" {
  make_superpowers 6.3.0
  record_install 6.3.0
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"error: superpowers 6.3.0 is older than 6.4.1"* ]]
}

@test "refuses when superpowers is not installed" {
  rm -rf "$CACHE"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"error: superpowers is not installed"* ]]
}

@test "uses the bundled agents when the user defines none" {
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 0 ]
  [ "$(field AGENTS | jq -c .)" = '{"fast":"superpowers-parallel:sp-implementer-fast","standard":"superpowers-parallel:sp-implementer","reviewer":"superpowers-parallel:sp-reviewer","escalation":"superpowers-parallel:sp-final-reviewer"}' ]
}

@test "user and project agents replace the bundled ones by name" {
  user_agent sp-reviewer "$CLAUDE_CONFIG_DIR/agents"
  mkdir -p "$REPO/.claude/agents/sub"
  printf -- '---\nname: sp-implementer-fast\n---\n' >"$REPO/.claude/agents/sub/fast.md"
  git -C "$REPO" add .claude && git -C "$REPO" commit -qm agents
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 0 ]
  [ "$(field AGENTS | jq -r .reviewer)" = "sp-reviewer" ]
  [ "$(field AGENTS | jq -r .fast)" = "sp-implementer-fast" ]
  [ "$(field AGENTS | jq -r .standard)" = "superpowers-parallel:sp-implementer" ]
}

@test "refuses a dirty checkout" {
  echo change >>"$REPO/file.txt"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"error: uncommitted changes"* ]]
}

@test "refuses when .worktrees/ is not ignored" {
  printf '.superpowers/\n' >"$REPO/.gitignore"
  git -C "$REPO" commit -qam "unignore"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"error: .worktrees/ is not git-ignored; add it to .gitignore"* ]]
}

@test "refuses a plan without Task headings" {
  printf '# Plan\n\n## Step one\n' >"$REPO/docs/plan.md"
  git -C "$REPO" commit -qam "bad plan"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: no "### Task N:" headings in'* ]]
}

@test "reports missing superpowers files" {
  record_install 6.4.1
  rm "$CACHE/6.4.1/skills/subagent-driven-development/scripts/task-brief"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"error: missing superpowers file"*"task-brief"* ]]
}
