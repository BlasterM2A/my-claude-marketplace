# Agent Instructions

This repository is a Claude Code plugin marketplace. The catalog is `.claude-plugin/marketplace.json`; each plugin lives in `plugins/<name>/` with its own `.claude-plugin/plugin.json`.

- **Adding a plugin:** add its directory under `plugins/`, add an entry to `marketplace.json` (`source` is `./plugins/<name>`, and the entry `name` must equal the `name` in the plugin's `plugin.json`), and add a row to the table in `README.md`.
- **Releasing a plugin change:** bump `version` in the plugin's `plugin.json` AND in its `marketplace.json` entry, keep them identical, and update the README table.
- **Tooling:** tools are pinned with mise (`mise.toml` at the root for `task`; each plugin pins its own test tools in `plugins/<name>/mise.toml`). Add or bump tools with `mise use <tool>@<version>` from the directory that owns them, never by editing `mise.toml` by hand; check that `mise use` reports the intended `mise.toml` (pass `--path mise.toml` if it picks a config file outside the repo).
- **Validation:** run `task validate` (validates the marketplace and every plugin) after every change to a manifest.
- **Tests:** run `task test` from the root to run every plugin's own `task test` with that plugin's mise tools; a plugin with tests must provide a `Taskfile.yml` with a `test` task.
- **Per-plugin rules:** a plugin's own `AGENTS.md` (e.g. `plugins/superpowers-plus/AGENTS.md`) governs work inside that plugin; run its tests from its directory (e.g. `task test`).
