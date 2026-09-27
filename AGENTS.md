# Agent Instructions

This repository is a Claude Code plugin marketplace. The catalog is `.claude-plugin/marketplace.json`; each plugin lives in `plugins/<name>/` with its own `.claude-plugin/plugin.json`.

- **Adding a plugin:** add its directory under `plugins/`, add an entry to `marketplace.json` (`source` is `./plugins/<name>`, and the entry `name` must equal the `name` in the plugin's `plugin.json`), and add a row to the table in `README.md`.
- **Releasing a plugin change:** bump `version` in the plugin's `plugin.json` AND in its `marketplace.json` entry, keep them identical, and update the README table (`.claude/skills/release-plugin/bump-version <plugin> <version>` does all three). In Claude Code, `/release-plugin <plugin> <version>` runs the whole release: bump, `task`, fast-forward merge to `main`, push, `claude plugin tag --push` and local install update.
- **Tooling:** tools are pinned with mise (`mise.toml` at the root for `task`; each plugin pins its own test tools in `plugins/<name>/mise.toml`). Add or bump tools with `mise use <tool>@<version>` from the directory that owns them, never by editing `mise.toml` by hand; check that `mise use` reports the intended `mise.toml` (pass `--path mise.toml` if it picks a config file outside the repo).
- **Validation:** run `task validate` (validates the marketplace and every plugin, and fails when a `plugin.json` version differs from its catalog entry) after every change to a manifest. In Claude Code, a project `PostToolUse` hook (`.claude/hooks/validate-manifest.sh`) runs it automatically after each manifest edit.
- **Tests:** run `task test` from the root to run every plugin's own `task test` with that plugin's mise tools; a plugin with tests must provide a `Taskfile.yml` with a `test` task.
- **Per-plugin rules:** a plugin's own `AGENTS.md` (e.g. `plugins/superpowers-plus/AGENTS.md`) governs work inside that plugin; run its tests from its directory (e.g. `task test`).
- **Git:** work on a branch, conventional commit messages (`feat(<plugin>): …`, `chore(<plugin>): release <version>`), fast-forward merge to `main`. The repo is public: no machine-specific paths or local config names in committed files.

## Commands

```bash
task                                              # validate + test everything
task validate                                     # catalog + every plugin manifest
task test                                         # every plugin's own `task test`
mise -C plugins/<p> exec -- task test             # one plugin (lint + bats + node for superpowers-plus)
mise -C plugins/<p> exec -- bats test/preflight.bats -f '<test name regex>'           # one bats test
mise -C plugins/<p> exec -- node --test --test-name-pattern '<regex>' test/<file>.test.mjs  # one node test
```

## Claude Code plugin rules learned the hard way

- **Names are identities.** The `name` in `plugin.json` is the prefix of every skill and agent (`<plugin>:<skill>`). Two plugins cannot share a name: a second plugin named `superpowers` replaces the official one instead of adding to it.
- **Plugin agents need the prefix.** A bundled agent is only reachable as `<plugin>:<agent>`; a bare `subagent_type` never resolves to a plugin agent. A user or project agent with the same bare name is a different agent. Plugin agents ignore `hooks`, `mcpServers` and `permissionMode` frontmatter; `model` and `effort` work.
- **Cross-marketplace dependencies** (e.g. `superpowers@claude-plugins-official`) need the target marketplace in the catalog's `allowCrossMarketplaceDependenciesOn`; declare the dependency in both `plugin.json` and the catalog entry so a missing allowlist fails the install loudly. Version ranges resolve against `<plugin>--v<version>` git tags, which obra/superpowers does not create (`vX.Y.Z`), so leave that dependency unversioned.
- **Renames:** never just change a `name`; add `"<old>": "<new>"` to the catalog's `renames` map (append-only history) so existing installs migrate.
- **Updates reach users only when `version` changes**, and `plugin.json` wins over the catalog entry — hence the mismatch check in `task validate`.
