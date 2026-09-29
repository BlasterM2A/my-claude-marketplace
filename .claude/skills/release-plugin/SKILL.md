---
name: release-plugin
description: Release one plugin of this marketplace - bump its version everywhere, verify, merge to main, push, tag and update the local install. Use when the user asks to release, publish, merge or push a change to a plugin under plugins/, or runs /release-plugin <plugin> <version>. Never release a plugin the user did not ask to ship.
argument-hint: <plugin> <version>
---

# Release a plugin

Releases `$ARGUMENTS` (plugin name and new semantic version). If either is missing, run `.claude/skills/release-plugin/check-release` to see which plugins have shipped changes since their last tag, list the plugins with their current versions (`jq -r '.plugins[] | "\(.name) \(.version)"' .claude-plugin/marketplace.json`), propose a version from those changes (patch: fixes, minor: features, major: breaking), and ask before continuing.

Run every command from the marketplace root. Stop and report at the first failure; never skip a step, and never replace a step with a partial equivalent.

## 1. Check the starting point

- `git status --porcelain` shows only the changes that belong to this release, and the current branch is a feature branch, not `main`. If the work is uncommitted, commit it first with a conventional message.
- `git fetch origin --tags` and confirm `main` is not ahead of the branch (`git merge-base --is-ancestor origin/main HEAD`); otherwise rebase or ask.
- `git ls-remote --tags origin "<plugin>--v<version>"` is empty: the version is new.

## 2. Bump and verify

1. `.claude/skills/release-plugin/bump-version <plugin> <version>` updates `plugin.json`, the `marketplace.json` entry and the README table.
2. `mise exec -- task` validates every manifest, runs every plugin's tests and runs `check-release`. On any failure, stop and show it.
3. Commit: `git commit -am "chore(<plugin>): release <version>"`.

## 3. Publish

1. Show the user the commits that will land on `main` (`git log --oneline origin/main..HEAD`).
2. Push the branch, then fast-forward `main` on the remote without switching branches (`main` may be checked out in another worktree): `git push origin <branch>` and `git push origin HEAD:main`. A rejected non-fast-forward means `main` moved: stop and ask. Transient TLS/network errors: retry up to 3 times, then stop.
3. Tag from the plugin directory, then push the tag: `(cd plugins/<plugin> && claude plugin tag)` creates `<plugin>--v<version>` after checking that `plugin.json` and the catalog entry agree; `git push origin refs/tags/<plugin>--v<version>`. The tag is required: `check-release` compares against it.
4. If the branch is not checked out in any worktree (`git worktree list`), delete it locally and on the remote; otherwise leave it and say so.

**Push rejected with 403 "denied to <another user>":** your git credential helper picked a GitHub account without access to this repo. Retry the same push with the repo owner's token supplied through `GIT_ASKPASS` (a script that prints the token from the environment) and `-c credential.helper=` to bypass the helper. Never put the token on the command line.

## 4. Update the local install

`MKT=$(jq -r .name .claude-plugin/marketplace.json)`, then `claude plugin marketplace update "$MKT"`. If `claude plugin list` shows `<plugin>@$MKT`, run `claude plugin update <plugin>@$MKT`; otherwise say it is not installed here.

## 5. Report

List: version change, commits released, tag, push result, `check-release` output, and install status. Remind the user that open sessions pick up the new version after `/reload-plugins` or a restart.
