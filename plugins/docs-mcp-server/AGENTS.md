# docs-mcp-server

Claude Code plugin that connects to a shared, remote docs-mcp-server and ships the `docs-mcp` CLI and the `shared-docs` skill.

- Spec: `docs/superpowers/specs/2026-09-27-docs-mcp-server-plugin-design.md`
- Run `task test` (ruff lint + format check, then `unittest`). Run `ruff format .` before committing Python changes.
- `bin/docs-mcp` is a single Python file using only the standard library (Python 3.10+). Tests load it with `importlib` and talk to `test/fake_mcp_server.py`; never call a real server from tests.
- MCP tool names and argument names come from upstream docs-mcp-server (`src/mcp/mcpServer.ts`); check upstream before changing a mapping.
- This repository is public: never add organisation-specific hostnames, account ids, library names or document conventions. Use `docs.example.internal` in examples.
