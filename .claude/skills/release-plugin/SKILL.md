---
name: release-plugin
description: Release one plugin of this marketplace - bump its version everywhere, verify, merge to main, push, tag and update the local install. Run as /release-plugin <plugin> <version>.
disable-model-invocation: true
argument-hint: <plugin> <version>
---

# Release a plugin

Releases `$ARGUMENTS` (plugin name and new semantic version). If either is missing, list the plugins with their current versions (`jq -r '.plugins[] | "\(.name) \(.version)"' .claude-plugin/marketplace.json`), propose a version from the changes since the plugin's last tag (patch: fixes, minor: features, major: breaking), and ask before continuing.

Run every command from the marketplace root. Stop and report at the first failure; never skip a step.

## 1. Check the starting point

- `git status --porcelain` shows only the changes that belong to this release, and the current branch is a feature branch, not `main`. If the work is uncommitted, commit it first with a conventional message.
- `git fetch origin` and confirm `main` is not ahead of the branch's base (`git merge-base --is-ancestor origin/main HEAD`); otherwise rebase or ask.
- `git ls-remote --tags origin "<plugin>--v<version>"` is empty: the version is new.

## 2. Bump and verify

1. `.claude/skills/release-plugin/bump-version <plugin> <version>` updates `plugin.json`, the `marketplace.json` entry and the README table.
2. `mise exec -- task` validates every manifest and runs every plugin's tests. On any failure, stop and show it.
3. Commit: `git commit -am "chore(<plugin>): release <version>"`.

## 3. Publish

1. Show the user the commits that will land on `main` (`git log --oneline origin/main..HEAD`), then:
   `git switch main && git merge --ff-only <branch>`. If it is not a fast-forward, stop and ask.
2. `git push origin main`. Transient TLS/network errors: retry up to 3 times, then stop.
3. Delete the merged branch: `git branch -d <branch>`.
4. Tag from the plugin directory: `(cd plugins/<plugin> && claude plugin tag --push)`. It checks that `plugin.json` and the catalog entry agree and creates `<plugin>--v<version>`.

## 4. Update the local install

`MKT=$(jq -r .name .claude-plugin/marketplace.json)`, then `claude plugin marketplace update "$MKT"`. If `claude plugin list` shows `<plugin>@$MKT`, run `claude plugin update <plugin>@$MKT`; otherwise say it is not installed here.

## 5. Report

List: version change, commits released, tag, push result, and install status. Remind the user that open sessions pick up the new version after `/reload-plugins`.
