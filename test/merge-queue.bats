setup() {
  load helpers
  REPO=$(make_repo)
  git -C "$REPO" switch -q -c plan/p
  MQ="$BATS_TEST_DIRNAME/../scripts/merge-queue"
  LEDGER="$REPO/.superpowers/sdd/p/progress.md"
  mkdir -p "$(dirname "$LEDGER")"
  echo "# SDD ledger — plan: docs/p.md" >"$LEDGER"
  TEST_CMD='! grep -q BAD *.txt'
}

teardown() { rm -rf "$REPO"; }

# task_branch ID FILE CONTENT: commit FILE on plan/p--ID branched from plan/p.
task_branch() {
  git -C "$REPO" branch -q "plan/p--$1" plan/p
  local wt="$REPO/.worktrees/$1"
  git -C "$REPO" worktree add -q "$wt" "plan/p--$1"
  echo "$3" >"$wt/$2"
  git -C "$wt" add "$2"
  git -C "$wt" commit -qm "$1: change"
}

@test "merges clean branches, runs tests once and writes the ledger" {
  task_branch T1 a.txt one
  task_branch T2 b.txt two
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1 T2=plan/p--T2
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.merged[].task]' <<<"$output")" = '["T1","T2"]' ]
  [ "$(jq -r .tests_passed <<<"$output")" = true ]
  grep -q '^Task 1: complete (merge ' "$LEDGER"
  grep -q '^Task 2: complete (merge ' "$LEDGER"
}

@test "leaves a conflicting branch out" {
  task_branch T1 file.txt one
  task_branch T2 file.txt two
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1 T2=plan/p--T2
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.merged[].task]' <<<"$output")" = '["T1"]' ]
  [ "$(jq -c .conflicts <<<"$output")" = '["T2"]' ]
  [ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]
}

@test "bisects a red batch and undoes the culprit" {
  task_branch T1 a.txt one
  task_branch T2 bad.txt BAD
  task_branch T3 c.txt three
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1 T2=plan/p--T2 T3=plan/p--T3
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.merged[].task]' <<<"$output")" = '["T1","T3"]' ]
  [ "$(jq -c .culprits <<<"$output")" = '["T2"]' ]
  [ "$(jq -r .tests_passed <<<"$output")" = true ]
  [ ! -f "$REPO/bad.txt" ]
  ! grep -q '^Task 2:' "$LEDGER"
}

@test "aborts a merge left in progress by an interrupted run" {
  task_branch T1 file.txt one
  task_branch T2 file.txt two
  git -C "$REPO" merge -q --no-ff plan/p--T1 -m "Merge T1"
  git -C "$REPO" merge -q --no-ff plan/p--T2 -m "Merge T2" || true
  git -C "$REPO" rev-parse -q --verify MERGE_HEAD
  task_branch T3 c.txt three
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T3=plan/p--T3
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.merged[].task]' <<<"$output")" = '["T3"]' ]
}

@test "refuses when the repo is not on the plan branch" {
  git -C "$REPO" switch -q main
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1
  [ "$status" -eq 2 ]
}

@test "re-running a merged batch does not duplicate ledger lines" {
  task_branch T1 a.txt one
  "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1 >/dev/null
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.merged[].task]' <<<"$output")" = '["T1"]' ]
  [ "$(grep -c '^Task 1:' "$LEDGER")" -eq 1 ]
}
