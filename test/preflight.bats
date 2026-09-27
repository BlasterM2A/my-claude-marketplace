setup() {
  load helpers
  REPO=$(make_repo)
  PF="$BATS_TEST_DIRNAME/../scripts/preflight"
  export SP_ROOT=$(mktemp -d) AGENTS_DIR=$(mktemp -d)
  sdd="$SP_ROOT/6.4.1/skills/subagent-driven-development"
  mkdir -p "$sdd/scripts" "$SP_ROOT/6.4.1/skills/requesting-code-review" "$SP_ROOT/6.3.0/skills"
  for f in scripts/sdd-workspace scripts/task-brief scripts/review-package implementer-prompt.md task-reviewer-prompt.md re-review-prompt.md; do
    touch "$sdd/$f"
  done
  touch "$SP_ROOT/6.4.1/skills/requesting-code-review/code-reviewer.md"
  for a in sp-implementer-fast sp-implementer sp-reviewer sp-final-reviewer; do touch "$AGENTS_DIR/$a.md"; done
  mkdir -p "$REPO/docs"
  printf '# Plan\n\n### Task 1: A\n\n### Task 2: B\n' >"$REPO/docs/plan.md"
  git -C "$REPO" add docs && git -C "$REPO" commit -qm plan
}

teardown() { rm -rf "$REPO" "$SP_ROOT" "$AGENTS_DIR"; }

@test "passes and reports the newest superpowers version and task count" {
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "SP_SKILLS=$SP_ROOT/6.4.1/skills" ]
  [ "${lines[1]}" = "TASKS=2" ]
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

@test "reports missing superpowers files and agents" {
  rm "$SP_ROOT/6.4.1/skills/subagent-driven-development/scripts/task-brief" "$AGENTS_DIR/sp-reviewer.md"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"error: missing superpowers file"*"task-brief"* ]]
  [[ "$output" == *"error: missing agent sp-reviewer"* ]]
}
