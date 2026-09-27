# Shared bats helpers.
make_repo() {
  local dir
  dir=$(mktemp -d)
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name test
  printf '.worktrees/\n.superpowers/\n' >"$dir/.gitignore"
  echo base >"$dir/file.txt"
  git -C "$dir" add -A
  git -C "$dir" commit -qm init
  echo "$dir"
}
