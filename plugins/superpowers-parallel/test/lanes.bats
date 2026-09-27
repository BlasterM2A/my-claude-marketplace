setup() {
  load helpers
  REPO=$(make_repo)
  git -C "$REPO" branch plan/p
  LANES="$BATS_TEST_DIRNAME/../scripts/lanes"
  L1="$REPO/.worktrees/p-lane-1"
  L2="$REPO/.worktrees/p-lane-2"
}

teardown() { rm -rf "$REPO"; }

@test "create makes N detached lanes and is idempotent" {
  run "$LANES" create "$REPO" p 2 plan/p
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "$L1" ]
  [ "${lines[1]}" = "$L2" ]
  run "$LANES" create "$REPO" p 2 plan/p
  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" worktree list | wc -l)" -eq 3 ]
}

@test "create fails on an unknown base branch" {
  run "$LANES" create "$REPO" p 1 nope
  [ "$status" -eq 2 ]
}

@test "checkout creates the task branch from the base branch" {
  "$LANES" create "$REPO" p 1 plan/p >/dev/null
  run "$LANES" checkout "$L1" plan/p--T1 plan/p
  [ "$status" -eq 0 ]
  [ "$(git -C "$L1" branch --show-current)" = plan/p--T1 ]
  [ "$(git -C "$L1" rev-parse HEAD)" = "$(git -C "$REPO" rev-parse plan/p)" ]
}

@test "checkout keeps existing commits on a resumed task branch" {
  "$LANES" create "$REPO" p 1 plan/p >/dev/null
  "$LANES" checkout "$L1" plan/p--T1 plan/p
  echo work >"$L1/new.txt"
  git -C "$L1" add new.txt
  git -C "$L1" commit -qm "T1: work"
  sha=$(git -C "$L1" rev-parse HEAD)
  git -C "$L1" checkout -q --detach
  run "$LANES" checkout "$L1" plan/p--T1 plan/p
  [ "$status" -eq 0 ]
  [ "$(git -C "$L1" rev-parse HEAD)" = "$sha" ]
}

@test "checkout moves a task branch out of another clean lane" {
  "$LANES" create "$REPO" p 2 plan/p >/dev/null
  "$LANES" checkout "$L1" plan/p--T1 plan/p
  run "$LANES" checkout "$L2" plan/p--T1 plan/p
  [ "$status" -eq 0 ]
  [ "$(git -C "$L2" branch --show-current)" = plan/p--T1 ]
  [ -z "$(git -C "$L1" branch --show-current)" ]
}

@test "checkout refuses a dirty lane" {
  "$LANES" create "$REPO" p 1 plan/p >/dev/null
  echo dirty >"$L1/file.txt"
  run "$LANES" checkout "$L1" plan/p--T1 plan/p
  [ "$status" -eq 3 ]
}

@test "remove deletes lanes except the kept ones" {
  "$LANES" create "$REPO" p 2 plan/p >/dev/null
  run "$LANES" remove "$REPO" p "$L2"
  [ "$status" -eq 0 ]
  [ ! -d "$L1" ]
  [ -d "$L2" ]
}
