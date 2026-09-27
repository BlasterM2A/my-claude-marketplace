# Agent Instructions

This repository is a Claude Code plugin marketplace. The catalog is `.claude-plugin/marketplace.json`; each plugin lives in `plugins/<name>/` with its own `.claude-plugin/plugin.json`.

- **Adding a plugin:** add its directory under `plugins/`, add an entry to `marketplace.json` (`source` is `./plugins/<name>`, and the entry `name` must equal the `name` in the plugin's `plugin.json`), and add a row to the table in `README.md`.
- **Releasing a plugin change:** bump `version` in the plugin's `plugin.json` AND in its `marketplace.json` entry, keep them identical, and update the README table.
- **Validation:** run `claude plugin validate .` (marketplace) and `claude plugin validate plugins/<name>` after every change to a manifest.
- **Per-plugin rules:** a plugin's own `AGENTS.md` (e.g. `plugins/superpowers-parallel/AGENTS.md`) governs work inside that plugin; run its tests from its directory (e.g. `task test`).
