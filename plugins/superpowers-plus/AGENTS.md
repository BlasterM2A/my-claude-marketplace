# superpowers-plus

Claude Code plugin that runs approved Superpowers plans in parallel.

- Spec: `docs/superpowers/specs/2026-09-27-parallel-plan-execution-design.md`
- Run tests with `task test` (bats for `scripts/lanes`, `scripts/merge-queue`, `scripts/preflight`; `node:test` for everything else).
- `workflows/parallel-sdd.js` is a Claude Code Workflow script: plain JS, no imports, no filesystem, no `Date.now()`/`Math.random()`. Test it through `test/harness.mjs`.
- Shell scripts: `set -euo pipefail`, usage text in the header comment, exit 2 on bad usage, exit 3 on unsafe state.
