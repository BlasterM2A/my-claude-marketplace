# docs-mcp-server Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `docs-mcp-server` plugin: an MCP connection to a shared, remote docs-mcp-server (URL from `DOCS_MCP_URL` or the install-time option), a stdlib-only `docs-mcp` CLI, and a `shared-docs` skill.

**Architecture:** The manifest declares an `http` MCP server whose URL is `${DOCS_MCP_URL:-${user_config.url}}`. `bin/docs-mcp` is one Python file implementing a minimal MCP Streamable HTTP client plus one subcommand per server tool and job waiting; it is unit-tested in-process against a fake MCP server built on `http.server`. The skill is Markdown that teaches shared-index etiquette and how to call the CLI.

**Tech Stack:** Claude Code plugin manifest, Python 3 standard library (CLI and tests, `unittest`), ruff (lint + format), mise (tool pinning), Task (`Taskfile.yml`).

**Spec:** `plugins/docs-mcp-server/docs/superpowers/specs/2026-09-27-docs-mcp-server-plugin-design.md`

## Global Constraints

- Public repository: no organisation-specific hostnames, account ids, library names or document conventions anywhere in the plugin, the catalog or the READMEs. Example URLs use `docs.example.internal`.
- `bin/docs-mcp`: one file, Python standard library only, runs on Python 3.10+ (`ruff` `target-version = "py310"`), shebang `#!/usr/bin/env python3`, executable bit set.
- Endpoint precedence, first non-empty value wins: `--url`, `DOCS_MCP_URL`, `CLAUDE_PLUGIN_OPTION_URL`. MCP connection URL: `${DOCS_MCP_URL:-${user_config.url}}`.
- Exit codes: 0 success; 1 the server reported an error or a waited job failed/was cancelled; 2 usage error or missing endpoint; 3 connection, TLS or protocol error; 4 `wait` timed out.
- MCP protocol version sent in `initialize`: `2025-06-18`.
- Tools pinned only with `mise use` (never edit `mise.toml` by hand): python 3.14.7, ruff 0.16.9, task 3.53.1.
- Plugin version `0.1.0`, identical in `plugin.json`, the catalog entry and the README table; `task validate` must pass.
- Work on branch `feature/docs-mcp-server-plugin`; conventional commit messages; all artifacts in English.
- Run plugin commands from `plugins/docs-mcp-server` with `mise exec -- …`; run catalog commands from the repository root.

## Review Focus

- An endpoint copied into an environment variable with surrounding spaces or a trailing newline must still work (trimmed), and a blank value must fall through to the next source — Task 2 `test_empty_and_blank_values_are_skipped_and_whitespace_trimmed`.
- Global options written after the command (`docs-mcp search react hooks --url …`) must work exactly like before it — Task 2 `test_global_options_may_follow_the_command`.
- A reverse proxy in front of the server answering with an HTML error page (e.g. 502) must give exit 3 and a one-line message naming the HTTP status, never a Python traceback — Task 2 `test_http_error_page_exits_3_without_traceback`.
- An SSE reply that carries notification events before the actual response must still yield the response (matched by request id) — Task 2 `test_sse_response_after_a_notification_event`.
- If the server's "job started" text stops containing a job id, `--wait` must fail with exit 3 and show the server's text instead of polling forever or crashing — Task 3 `test_scrape_wait_without_job_id_exits_3_and_shows_the_text`.

---

## File Structure

```
plugins/docs-mcp-server/
├── .claude-plugin/plugin.json      # Task 1: identity, userConfig.url, http MCP server
├── AGENTS.md, CLAUDE.md            # Task 1: plugin development rules (@AGENTS.md bridge)
├── mise.toml                       # Task 1: python, ruff, task (via mise use)
├── ruff.toml                       # Task 1: lint/format config incl. extensionless bin/docs-mcp
├── Taskfile.yml                    # Task 1: lint + test
├── bin/docs-mcp                    # Tasks 2-3: the CLI (MCP client + commands + job waiting)
├── skills/shared-docs/SKILL.md     # Task 4: model-invocable skill
├── README.md                       # Task 4: user documentation
├── test/test_plugin_files.py       # Tasks 1, 4: manifest and skill checks
├── test/fake_mcp_server.py         # Task 2: in-process MCP server for CLI tests
└── test/test_cli.py                # Tasks 2-3: CLI tests
.claude-plugin/marketplace.json     # Task 1: catalog entry
README.md                           # Task 1: table row; Task 4: plugin section
```

---

### Task 1: Plugin scaffold, manifest and catalog entry

**Files:**
- Create: `plugins/docs-mcp-server/.claude-plugin/plugin.json`
- Create: `plugins/docs-mcp-server/test/test_plugin_files.py`
- Create: `plugins/docs-mcp-server/ruff.toml`, `plugins/docs-mcp-server/Taskfile.yml`, `plugins/docs-mcp-server/AGENTS.md`, `plugins/docs-mcp-server/CLAUDE.md`
- Create (via `mise use`): `plugins/docs-mcp-server/mise.toml`
- Modify: `.claude-plugin/marketplace.json` (append entry), `README.md` (table row)

**Interfaces:**
- Consumes: nothing.
- Produces: plugin directory with `task test` (runs `task lint`, then `python -m unittest discover -s test -v`) and `task lint` (`ruff check .` + `ruff format --check .`); `test/test_plugin_files.py` with `ROOT: Path` (plugin root) that Task 4 extends; catalog entry named `docs-mcp-server`.

- [ ] **Step 1: Create the tooling files**

`plugins/docs-mcp-server/ruff.toml`:

```toml
target-version = "py310"
line-length = 120
extend-include = ["bin/docs-mcp"]
```

`plugins/docs-mcp-server/Taskfile.yml`:

```yaml
version: '3'

tasks:
  test:
    desc: Lint, then run all tests
    cmds:
      - task: lint
      - python -m unittest discover -s test -v
  lint:
    desc: Check lint and formatting with ruff
    cmds:
      - ruff check .
      - ruff format --check .
```

`plugins/docs-mcp-server/AGENTS.md`:

```markdown
# docs-mcp-server

Claude Code plugin that connects to a shared, remote docs-mcp-server and ships the `docs-mcp` CLI and the `shared-docs` skill.

- Spec: `docs/superpowers/specs/2026-09-27-docs-mcp-server-plugin-design.md`
- Run `task test` (ruff lint + format check, then `unittest`). Run `ruff format .` before committing Python changes.
- `bin/docs-mcp` is a single Python file using only the standard library (Python 3.10+). Tests load it with `importlib` and talk to `test/fake_mcp_server.py`; never call a real server from tests.
- MCP tool names and argument names come from upstream docs-mcp-server (`src/mcp/mcpServer.ts`); check upstream before changing a mapping.
- This repository is public: never add organisation-specific hostnames, account ids, library names or document conventions. Use `docs.example.internal` in examples.
```

`plugins/docs-mcp-server/CLAUDE.md`:

```markdown
@AGENTS.md
```

- [ ] **Step 2: Pin the tools with mise**

Run (from `plugins/docs-mcp-server`):

```bash
mise use --path mise.toml python@3.14.7 ruff@0.16.9 task@3.53.1
mise trust mise.toml
```

Expected: `mise ~/…/plugins/docs-mcp-server/mise.toml tools: python@3.14.7, ruff@0.16.9, task@3.53.1`. Confirm the path in that line is the plugin's `mise.toml`, not a file outside the repository.

- [ ] **Step 3: Write the failing manifest test**

`plugins/docs-mcp-server/test/test_plugin_files.py`:

```python
"""Checks on the plugin's static files: manifest and skill."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text())

    def test_identity(self):
        self.assertEqual(self.manifest["name"], "docs-mcp-server")
        self.assertRegex(self.manifest["version"], r"^\d+\.\d+\.\d+$")

    def test_url_option_is_optional_not_secret_and_has_no_default(self):
        option = self.manifest["userConfig"]["url"]
        self.assertEqual(option["type"], "string")
        self.assertFalse(option.get("required", False))
        self.assertFalse(option.get("sensitive", False))
        self.assertNotIn("default", option)
        self.assertIn("DOCS_MCP_URL", option["description"])

    def test_http_server_prefers_the_environment_variable(self):
        server = self.manifest["mcpServers"]["docs-mcp-server"]
        self.assertEqual(server, {"type": "http", "url": "${DOCS_MCP_URL:-${user_config.url}}"})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `mise exec -- python -m unittest discover -s test -v`
Expected: 3 errors, `FileNotFoundError` for `.claude-plugin/plugin.json`.

- [ ] **Step 5: Create the manifest**

`plugins/docs-mcp-server/.claude-plugin/plugin.json`:

```json
{
  "name": "docs-mcp-server",
  "description": "Connect Claude Code to a shared docs-mcp-server and drive it from the shell with the docs-mcp CLI.",
  "version": "0.1.0",
  "userConfig": {
    "url": {
      "type": "string",
      "title": "Server URL",
      "description": "MCP endpoint of a docs-mcp-server, e.g. https://docs.example.internal/mcp. Leave empty to use the DOCS_MCP_URL environment variable."
    }
  },
  "mcpServers": {
    "docs-mcp-server": {
      "type": "http",
      "url": "${DOCS_MCP_URL:-${user_config.url}}"
    }
  }
}
```

- [ ] **Step 6: Run the plugin's checks**

Run: `mise exec -- task test`
Expected: `ruff check .` → `All checks passed!`; `ruff format --check .` passes (run `mise exec -- ruff format .` first if it reports the test file); unittest `Ran 3 tests … OK`.

- [ ] **Step 7: Register the plugin in the catalog and README**

Run from the repository root:

```bash
M=.claude-plugin/marketplace.json
jq '.plugins += [{"name": "docs-mcp-server", "source": "./plugins/docs-mcp-server", "description": "Connect Claude Code to a shared docs-mcp-server and drive it from the shell with the docs-mcp CLI.", "version": "0.1.0"}]' "$M" > "$M.tmp" && mv "$M.tmp" "$M"
python3 - <<'EOF'
import pathlib
p = pathlib.Path("README.md"); s = p.read_text()
row = "| [superpowers-plus](plugins/superpowers-plus) |"
line = next(l for l in s.splitlines() if l.startswith(row))
new = "| [docs-mcp-server](plugins/docs-mcp-server) | 0.1.0 | Connect Claude Code to a shared [docs-mcp-server](https://github.com/arabold/docs-mcp-server) and drive it from the shell. |"
p.write_text(s.replace(line, line + "\n" + new, 1))
EOF
mise exec -- task validate
```

Expected: `task validate` ends with `✔ Validation passed` (warnings about `author` and the plugin-root `CLAUDE.md` are known and acceptable) and exit 0.

- [ ] **Step 8: Commit**

```bash
git add .claude-plugin/marketplace.json README.md plugins/docs-mcp-server/.claude-plugin plugins/docs-mcp-server/test plugins/docs-mcp-server/ruff.toml plugins/docs-mcp-server/Taskfile.yml plugins/docs-mcp-server/mise.toml plugins/docs-mcp-server/AGENTS.md plugins/docs-mcp-server/CLAUDE.md
git commit -m "feat(docs-mcp-server): scaffold plugin with http MCP server and URL option"
```

---

### Task 2: `docs-mcp` CLI — MCP client and tool commands

**Files:**
- Create: `plugins/docs-mcp-server/bin/docs-mcp` (executable)
- Create: `plugins/docs-mcp-server/test/fake_mcp_server.py`
- Create: `plugins/docs-mcp-server/test/test_cli.py`

**Interfaces:**
- Consumes: Task 1 tooling (`task test`, `ruff.toml` with `extend-include = ["bin/docs-mcp"]`).
- Produces (module-level names in `bin/docs-mcp`, used by Task 3 and its tests):
  - `EXIT_OK, EXIT_TOOL, EXIT_USAGE, EXIT_CONNECTION, EXIT_TIMEOUT = 0, 1, 2, 3, 4`
  - `class CliError(Exception)` with attribute `code: int`
  - `resolve_url(cli_url: str | None, env: Mapping[str, str]) -> str`
  - `class McpClient(url: str, insecure: bool = False, timeout: float = 120.0)` with `initialize() -> dict`, `request(method: str, params: dict | None = None) -> dict`, `call_tool(name: str, arguments: dict) -> tuple[dict, str]` (raw result, joined text content), `list_tools() -> list[dict]`
  - `build_parser() -> argparse.ArgumentParser` (subparser objects named `scrape`, `refresh`, `cancel` inside it)
  - `tool_call_for(args) -> tuple[str, dict]`, `emit(result: dict, text: str, as_json: bool, stdout) -> None`, `print_tools(client, as_json, stdout) -> None`, `run(args, env, stdout, stderr) -> int`, `main(argv=None, env=None, stdout=None, stderr=None) -> int`
  - `test/fake_mcp_server.py`: `text_result(text: str, is_error: bool = False) -> dict`; `class FakeMcpServer(tools=None, sse=True, notify_first=False, http_error=None)` — context manager; `.url: str`; `.requests: list[dict]` (keys `method`, `params`, `headers` with lower-case header names); `.calls(tool: str) -> list[dict]` (arguments of each call)
  - `test/test_cli.py`: `cli` (the loaded module), `run_cli(*argv, env=None) -> tuple[int, str, str]`, `free_port_url() -> str`

- [ ] **Step 1: Write the fake MCP server**

`plugins/docs-mcp-server/test/fake_mcp_server.py`:

```python
"""In-process MCP Streamable HTTP server for testing bin/docs-mcp."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SESSION_ID = "test-session-1"
PROTOCOL_VERSION = "2025-06-18"


def text_result(text: str, is_error: bool = False) -> dict:
    """A tools/call result whose only content is one text item."""
    result = {"content": [{"type": "text", "text": text}]}
    if is_error:
        result["isError"] = True
    return result


class FakeMcpServer:
    """Serves tools from a dict of name -> handler(arguments) -> result and records every request.

    sse: answer requests as text/event-stream (True) or application/json (False).
    notify_first: in SSE mode, send a progress notification event before each response.
    http_error: (status, body) returned for every tools/call instead of a JSON-RPC reply.
    The server requires the session id and protocol version headers on every request after initialize.
    """

    def __init__(self, tools=None, sse=True, notify_first=False, http_error=None):
        self.tools = dict(tools or {})
        self.sse = sse
        self.notify_first = notify_first
        self.http_error = http_error
        self.requests: list[dict] = []
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler_class())
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/mcp"

    def calls(self, tool: str) -> list[dict]:
        """Arguments of every tools/call to the given tool, in order."""
        return [
            request["params"].get("arguments", {})
            for request in self.requests
            if request["method"] == "tools/call" and request["params"].get("name") == tool
        ]

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc_info):
        self._server.shutdown()
        self._server.server_close()

    def _handler_class(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                message = json.loads(self.rfile.read(length) or b"{}")
                method = message.get("method")
                headers = {name.lower(): value for name, value in self.headers.items()}
                fake.requests.append({"method": method, "params": message.get("params") or {}, "headers": headers})
                if method == "initialize":
                    result = {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "fake-docs-mcp", "version": "0"},
                    }
                    return self._reply(message, result, session=True)
                if headers.get("mcp-session-id") != SESSION_ID:
                    return self._plain(400, "missing or unknown Mcp-Session-Id")
                if headers.get("mcp-protocol-version") != PROTOCOL_VERSION:
                    return self._plain(400, "missing MCP-Protocol-Version")
                if "id" not in message:
                    return self._plain(202, "")
                if method == "tools/list":
                    tools = [{"name": name, "description": f"{name} tool\nsecond line"} for name in fake.tools]
                    return self._reply(message, {"tools": tools})
                if method == "tools/call":
                    if fake.http_error:
                        status, body = fake.http_error
                        return self._plain(status, body)
                    name = message["params"].get("name")
                    handler = fake.tools.get(name)
                    if handler is None:
                        return self._error(message, -32602, f"Unknown tool: {name}")
                    return self._reply(message, handler(message["params"].get("arguments") or {}))
                return self._error(message, -32601, f"Method not found: {method}")

            def _reply(self, request, result, session=False):
                self._send({"jsonrpc": "2.0", "id": request["id"], "result": result}, session)

            def _error(self, request, code, text):
                self._send({"jsonrpc": "2.0", "id": request["id"], "error": {"code": code, "message": text}}, False)

            def _send(self, message, session):
                if fake.sse:
                    events = []
                    if fake.notify_first:
                        events.append({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 1}})
                    events.append(message)
                    body = "".join(f"event: message\ndata: {json.dumps(event)}\n\n" for event in events).encode()
                    content_type = "text/event-stream"
                else:
                    body = json.dumps(message).encode()
                    content_type = "application/json"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                if session:
                    self.send_header("Mcp-Session-Id", SESSION_ID)
                self.end_headers()
                self.wfile.write(body)

            def _plain(self, status, text):
                body = text.encode()
                self.send_response(status)
                self.send_header("Content-Type", "text/html" if status >= 500 else "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return Handler
```

- [ ] **Step 2: Write the failing CLI tests**

`plugins/docs-mcp-server/test/test_cli.py`:

```python
"""Tests for bin/docs-mcp against an in-process fake MCP server."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import socket
import unittest
from pathlib import Path

from fake_mcp_server import FakeMcpServer, text_result

BIN = Path(__file__).resolve().parent.parent / "bin" / "docs-mcp"
_loader = importlib.machinery.SourceFileLoader("docs_mcp_cli", str(BIN))
_spec = importlib.util.spec_from_loader("docs_mcp_cli", _loader)
cli = importlib.util.module_from_spec(_spec)
_loader.exec_module(cli)


def run_cli(*argv: str, env: dict | None = None) -> tuple[int, str, str]:
    """Run docs-mcp in-process; returns (exit code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    code = cli.main(list(argv), env=env or {}, stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


def free_port_url() -> str:
    """A URL on a local port with nothing listening."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return f"http://127.0.0.1:{port}/mcp"


def ok(_arguments):
    return text_result("ok")


class ExecutableTest(unittest.TestCase):
    def test_is_an_executable_python3_script(self):
        self.assertTrue(os.access(BIN, os.X_OK))
        self.assertEqual(BIN.read_text().splitlines()[0], "#!/usr/bin/env python3")


class EndpointResolutionTest(unittest.TestCase):
    def test_cli_flag_wins_over_both_variables(self):
        env = {"DOCS_MCP_URL": "https://env.example/mcp", "CLAUDE_PLUGIN_OPTION_URL": "https://opt.example/mcp"}
        self.assertEqual(cli.resolve_url("https://flag.example/mcp", env), "https://flag.example/mcp")

    def test_docs_mcp_url_wins_over_plugin_option(self):
        env = {"DOCS_MCP_URL": "https://env.example/mcp", "CLAUDE_PLUGIN_OPTION_URL": "https://opt.example/mcp"}
        self.assertEqual(cli.resolve_url(None, env), "https://env.example/mcp")

    def test_empty_and_blank_values_are_skipped_and_whitespace_trimmed(self):
        env = {"DOCS_MCP_URL": "   ", "CLAUDE_PLUGIN_OPTION_URL": " https://opt.example/mcp\n"}
        self.assertEqual(cli.resolve_url("", env), "https://opt.example/mcp")

    def test_missing_endpoint_is_a_usage_error_naming_all_sources(self):
        code, _, err = run_cli("libraries")
        self.assertEqual(code, 2)
        for source in ("--url", "DOCS_MCP_URL", "CLAUDE_PLUGIN_OPTION_URL"):
            self.assertIn(source, err)

    def test_non_http_url_is_a_usage_error(self):
        code, _, err = run_cli("libraries", "--url", "file:///tmp/docs")
        self.assertEqual(code, 2)
        self.assertIn("http://", err)


class ProtocolTest(unittest.TestCase):
    def test_handshake_then_session_and_protocol_headers_on_every_later_request(self):
        with FakeMcpServer({"list_libraries": lambda a: text_result("Indexed libraries:\n\n- react")}) as server:
            code, out, _ = run_cli("libraries", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertIn("- react", out)
        self.assertEqual(
            [request["method"] for request in server.requests],
            ["initialize", "notifications/initialized", "tools/call"],
        )
        self.assertEqual(server.requests[0]["params"]["protocolVersion"], "2025-06-18")
        for later in server.requests[1:]:
            self.assertEqual(later["headers"].get("mcp-session-id"), "test-session-1")
            self.assertEqual(later["headers"].get("mcp-protocol-version"), "2025-06-18")

    def test_plain_json_responses(self):
        with FakeMcpServer({"list_libraries": lambda a: text_result("- react")}, sse=False) as server:
            code, out, _ = run_cli("libraries", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertIn("- react", out)

    def test_sse_response_after_a_notification_event(self):
        with FakeMcpServer({"list_libraries": lambda a: text_result("- react")}, notify_first=True) as server:
            code, out, _ = run_cli("libraries", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertIn("- react", out)

    def test_endpoint_from_environment_variable(self):
        with FakeMcpServer({"list_libraries": ok}) as server:
            code, out, _ = run_cli("libraries", env={"DOCS_MCP_URL": server.url})
        self.assertEqual((code, out.strip()), (0, "ok"))

    def test_global_options_may_follow_the_command(self):
        with FakeMcpServer({"search_docs": ok}) as server:
            code, _, _ = run_cli("search", "react", "hooks", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertEqual(server.calls("search_docs"), [{"library": "react", "query": "hooks"}])

    def test_json_flag_prints_the_raw_result(self):
        with FakeMcpServer({"list_libraries": ok}) as server:
            code, out, _ = run_cli("--json", "libraries", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), text_result("ok"))


class ErrorTest(unittest.TestCase):
    def test_tool_error_exits_1_with_text_on_stderr(self):
        failing = {"search_docs": lambda a: text_result("Library nope not found in store.", is_error=True)}
        with FakeMcpServer(failing) as server:
            code, out, err = run_cli("search", "nope", "anything", "--url", server.url)
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("Library nope not found", err)

    def test_json_rpc_error_exits_1(self):
        with FakeMcpServer({}) as server:
            code, _, err = run_cli("call", "nope", "--url", server.url)
        self.assertEqual(code, 1)
        self.assertIn("Unknown tool: nope", err)

    def test_http_error_page_exits_3_without_traceback(self):
        with FakeMcpServer({"list_libraries": ok}, http_error=(502, "<html>Bad Gateway</html>")) as server:
            code, _, err = run_cli("libraries", "--url", server.url)
        self.assertEqual(code, 3)
        self.assertIn("HTTP 502", err)
        self.assertNotIn("Traceback", err)

    def test_unreachable_server_exits_3(self):
        url = free_port_url()
        code, _, err = run_cli("libraries", "--url", url)
        self.assertEqual(code, 3)
        self.assertIn(url, err)

    def test_invalid_json_arguments_exit_2_before_any_request(self):
        with FakeMcpServer({"search_docs": ok}) as server:
            code, _, err = run_cli("call", "search_docs", "{not json", "--url", server.url)
        self.assertEqual(code, 2)
        self.assertIn("JSON", err)
        self.assertEqual(server.requests, [])

    def test_non_object_json_arguments_exit_2(self):
        with FakeMcpServer({"search_docs": ok}) as server:
            code, _, _ = run_cli("call", "search_docs", "[1, 2]", "--url", server.url)
        self.assertEqual(code, 2)
        self.assertEqual(server.requests, [])

    def test_insecure_prints_a_warning(self):
        with FakeMcpServer({"list_libraries": ok}) as server:
            code, _, err = run_cli("libraries", "--insecure", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertIn("TLS certificate verification is disabled", err)


class CommandMappingTest(unittest.TestCase):
    def test_scrape_maps_all_options_and_repeats_patterns(self):
        with FakeMcpServer({"scrape_docs": ok}) as server:
            code, _, _ = run_cli(
                "scrape", "react", "https://react.dev/reference",
                "--version", "19.0.0", "--max-pages", "50", "--max-depth", "2", "--scope", "hostname",
                "--include", "**/hooks/*", "--include", "**/apis/*", "--exclude", "**/legacy/*",
                "--url", server.url,
            )  # fmt: skip
        self.assertEqual(code, 0)
        expected = {
            "library": "react",
            "url": "https://react.dev/reference",
            "version": "19.0.0",
            "maxPages": 50,
            "maxDepth": 2,
            "scope": "hostname",
            "includePatterns": ["**/hooks/*", "**/apis/*"],
            "excludePatterns": ["**/legacy/*"],
        }
        self.assertEqual(server.calls("scrape_docs"), [expected])

    def test_unset_options_are_not_sent(self):
        with FakeMcpServer({"scrape_docs": ok}) as server:
            run_cli("scrape", "react", "https://react.dev/reference", "--url", server.url)
        self.assertEqual(server.calls("scrape_docs"), [{"library": "react", "url": "https://react.dev/reference"}])

    def test_simple_commands_map_to_their_tools(self):
        cases = [
            (["versions", "react", "--target", "18.x"], "find_version", {"library": "react", "targetVersion": "18.x"}),
            (
                ["search", "react", "useEffect cleanup", "--version", "19.0.0", "--limit", "3"],
                "search_docs",
                {"library": "react", "query": "useEffect cleanup", "version": "19.0.0", "limit": 3},
            ),
            (["refresh", "react", "--version", "19.0.0"], "refresh_version", {"library": "react", "version": "19.0.0"}),
            (["jobs", "--status", "running"], "list_jobs", {"status": "running"}),
            (["job", "abc"], "get_job_info", {"jobId": "abc"}),
            (["cancel", "abc"], "cancel_job", {"jobId": "abc"}),
            (
                ["fetch", "https://example.com/page", "--no-follow-redirects"],
                "fetch_url",
                {"url": "https://example.com/page", "followRedirects": False},
            ),
            (["call", "list_libraries"], "list_libraries", {}),
        ]
        for argv, tool, expected in cases:
            with self.subTest(argv=argv), FakeMcpServer({tool: ok}) as server:
                code, _, _ = run_cli(*argv, "--url", server.url)
                self.assertEqual(code, 0)
                self.assertEqual(server.calls(tool), [expected])

    def test_remove_without_yes_is_refused_before_any_request(self):
        with FakeMcpServer({"remove_docs": ok}) as server:
            code, _, err = run_cli("remove", "react", "--version", "18.3.1", "--url", server.url)
        self.assertEqual(code, 2)
        self.assertIn("--yes", err)
        self.assertEqual(server.requests, [])

    def test_remove_with_yes(self):
        with FakeMcpServer({"remove_docs": ok}) as server:
            code, _, _ = run_cli("remove", "react", "--version", "18.3.1", "--yes", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertEqual(server.calls("remove_docs"), [{"library": "react", "version": "18.3.1"}])

    def test_tools_lists_names_and_first_description_line(self):
        with FakeMcpServer({"search_docs": ok, "list_libraries": ok}) as server:
            code, out, _ = run_cli("tools", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertIn("search_docs\tsearch_docs tool", out)
        self.assertNotIn("second line", out)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `mise exec -- python -m unittest discover -s test -v`
Expected: the `test_cli` module fails to import with `FileNotFoundError` for `bin/docs-mcp` (the 3 manifest tests still pass).

- [ ] **Step 4: Write the CLI**

`plugins/docs-mcp-server/bin/docs-mcp`:

```python
#!/usr/bin/env python3
"""docs-mcp: command-line client for a remote docs-mcp-server.

Speaks MCP Streamable HTTP to the server's /mcp endpoint using only the Python standard library.
The endpoint is the first non-empty value of --url, DOCS_MCP_URL and CLAUDE_PLUGIN_OPTION_URL.

Exit codes: 0 success, 1 the server reported an error, 2 usage error or no endpoint,
3 connection, TLS or protocol error, 4 timed out waiting for a job.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import TextIO

VERSION = "0.1.0"
PROTOCOL_VERSION = "2025-06-18"
EXIT_OK, EXIT_TOOL, EXIT_USAGE, EXIT_CONNECTION, EXIT_TIMEOUT = 0, 1, 2, 3, 4


class CliError(Exception):
    """An error that ends the command with a specific exit code."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


def resolve_url(cli_url: str | None, env: Mapping[str, str]) -> str:
    """Return the first non-empty endpoint from --url, DOCS_MCP_URL and CLAUDE_PLUGIN_OPTION_URL."""
    for value in (cli_url, env.get("DOCS_MCP_URL"), env.get("CLAUDE_PLUGIN_OPTION_URL")):
        if value and value.strip():
            url = value.strip()
            if not url.startswith(("http://", "https://")):
                raise CliError(EXIT_USAGE, f"server URL must start with http:// or https://: {url}")
            return url
    raise CliError(EXIT_USAGE, "no server URL: pass --url, or set DOCS_MCP_URL or CLAUDE_PLUGIN_OPTION_URL")


def parse_reply(body: str, content_type: str, request_id: int) -> dict:
    """Find the JSON-RPC response to request_id in a JSON or text/event-stream body."""
    if "text/event-stream" in content_type:
        payloads: list[str] = []
        data: list[str] = []
        for line in body.splitlines():
            if line.startswith("data:"):
                data.append(line[5:].removeprefix(" "))
            elif not line.strip() and data:
                payloads.append("\n".join(data))
                data = []
        if data:
            payloads.append("\n".join(data))
    else:
        payloads = [body]
    for payload in payloads:
        try:
            message = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(message, dict) and message.get("id") == request_id and ("result" in message or "error" in message):
            return message
    kind = content_type or "no content type"
    raise CliError(EXIT_CONNECTION, f"no JSON-RPC response to request {request_id} in the server reply ({kind})")


class McpClient:
    """Minimal MCP Streamable HTTP client: initialize once, then JSON-RPC requests on the same session."""

    def __init__(self, url: str, insecure: bool = False, timeout: float = 120.0) -> None:
        self.url = url
        self.timeout = timeout
        self.session_id: str | None = None
        self.protocol_version: str | None = None
        self._last_id = 0
        # None keeps Python's default verification, which honours SSL_CERT_FILE and SSL_CERT_DIR.
        self._ssl_context: ssl.SSLContext | None = None
        if insecure:
            self._ssl_context = ssl.create_default_context()
            self._ssl_context.check_hostname = False
            self._ssl_context.verify_mode = ssl.CERT_NONE

    def _post(self, message: dict) -> tuple[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        if self.protocol_version:
            headers["MCP-Protocol-Version"] = self.protocol_version
        request = urllib.request.Request(self.url, data=json.dumps(message).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout, context=self._ssl_context) as response:
                self.session_id = response.headers.get("Mcp-Session-Id") or self.session_id
                return response.read().decode("utf-8"), response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace").strip()[:200]
            raise CliError(EXIT_CONNECTION, f"{self.url}: HTTP {error.code} {error.reason} {detail}".rstrip()) from None
        except (urllib.error.URLError, OSError) as error:
            reason = getattr(error, "reason", error)
            raise CliError(EXIT_CONNECTION, f"{self.url}: {reason}") from None

    def request(self, method: str, params: dict | None = None) -> dict:
        """Send one JSON-RPC request and return its result; JSON-RPC errors raise CliError(EXIT_TOOL)."""
        self._last_id += 1
        request_id = self._last_id
        message: dict = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        body, content_type = self._post(message)
        reply = parse_reply(body, content_type, request_id)
        if "error" in reply:
            error = reply["error"] or {}
            detail = error.get("message", error) if isinstance(error, dict) else error
            raise CliError(EXIT_TOOL, f"{method} failed: {detail}")
        return reply.get("result") or {}

    def initialize(self) -> dict:
        params = {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "docs-mcp", "version": VERSION},
        }
        result = self.request("initialize", params)
        self.protocol_version = result.get("protocolVersion") or PROTOCOL_VERSION
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return result

    def call_tool(self, name: str, arguments: dict) -> tuple[dict, str]:
        """Call a tool; returns the raw result and its text content joined by newlines."""
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        content = result.get("content") or []
        text = "\n".join(item.get("text", "") for item in content if item.get("type") == "text")
        return result, text

    def list_tools(self) -> list[dict]:
        return self.request("tools/list").get("tools") or []


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--url",
        default=argparse.SUPPRESS,
        help="MCP endpoint (default: $DOCS_MCP_URL, then $CLAUDE_PLUGIN_OPTION_URL)",
    )
    common.add_argument(
        "--insecure",
        action="store_true",
        default=argparse.SUPPRESS,
        help="disable TLS certificate verification",
    )
    common.add_argument(
        "--json",
        action="store_true",
        default=argparse.SUPPRESS,
        help="print the raw JSON result instead of its text",
    )
    parser = argparse.ArgumentParser(
        prog="docs-mcp", parents=[common], description="Command-line client for a remote docs-mcp-server."
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    def command(name: str, help_text: str) -> argparse.ArgumentParser:
        return commands.add_parser(name, parents=[common], help=help_text, description=help_text)

    command("tools", "list the server's tools")
    call = command("call", "call any tool with JSON arguments")
    call.add_argument("tool")
    call.add_argument("arguments", nargs="?", default="{}", help="JSON object (default: {})")
    command("libraries", "list indexed libraries")
    versions = command("versions", "find the best matching version of a library")
    versions.add_argument("library")
    versions.add_argument("--target", help="version or X-range to match")
    search = command("search", "search a library's documentation")
    search.add_argument("library")
    search.add_argument("query")
    search.add_argument("--version")
    search.add_argument("--limit", type=int)
    scrape = command("scrape", "index documentation from a URL (replaces that library version)")
    scrape.add_argument("library")
    scrape.add_argument("source_url", metavar="URL")
    scrape.add_argument("--version")
    scrape.add_argument("--max-pages", type=int)
    scrape.add_argument("--max-depth", type=int)
    scrape.add_argument("--scope", choices=["subpages", "hostname", "domain"])
    scrape.add_argument("--include", action="append", help="URL include pattern (repeatable)")
    scrape.add_argument("--exclude", action="append", help="URL exclude pattern (repeatable)")
    refresh = command("refresh", "re-scrape an indexed library version, skipping unchanged pages")
    refresh.add_argument("library")
    refresh.add_argument("--version")
    remove = command("remove", "delete an indexed library or version (destructive)")
    remove.add_argument("library")
    remove.add_argument("--version")
    remove.add_argument("--yes", action="store_true", help="confirm the deletion")
    jobs = command("jobs", "list indexing jobs")
    jobs.add_argument("--status", choices=["queued", "running", "completed", "failed", "cancelling", "cancelled"])
    job = command("job", "show one indexing job")
    job.add_argument("job_id")
    cancel = command("cancel", "cancel a queued or running job")
    cancel.add_argument("job_id")
    fetch = command("fetch", "fetch one URL as Markdown without indexing it")
    fetch.add_argument("source_url", metavar="URL")
    fetch.add_argument("--no-follow-redirects", action="store_true")
    return parser


def compact(arguments: dict) -> dict:
    """Drop arguments the user did not set, so the server applies its own defaults."""
    return {key: value for key, value in arguments.items() if value is not None}


def tool_call_for(args: argparse.Namespace) -> tuple[str, dict]:
    """Map a parsed command to the MCP tool it calls and that tool's arguments."""
    command = args.command
    if command == "call":
        try:
            arguments = json.loads(args.arguments)
        except json.JSONDecodeError as error:
            raise CliError(EXIT_USAGE, f"arguments are not valid JSON: {error}") from None
        if not isinstance(arguments, dict):
            raise CliError(EXIT_USAGE, "arguments must be a JSON object")
        return args.tool, arguments
    if command == "libraries":
        return "list_libraries", {}
    if command == "versions":
        return "find_version", compact({"library": args.library, "targetVersion": args.target})
    if command == "search":
        arguments = {"library": args.library, "query": args.query, "version": args.version, "limit": args.limit}
        return "search_docs", compact(arguments)
    if command == "scrape":
        arguments = {
            "library": args.library,
            "url": args.source_url,
            "version": args.version,
            "maxPages": args.max_pages,
            "maxDepth": args.max_depth,
            "scope": args.scope,
            "includePatterns": args.include,
            "excludePatterns": args.exclude,
        }
        return "scrape_docs", compact(arguments)
    if command == "refresh":
        return "refresh_version", compact({"library": args.library, "version": args.version})
    if command == "remove":
        if not args.yes:
            target = f"{args.library}@{args.version}" if args.version else args.library
            raise CliError(EXIT_USAGE, f"refusing to remove {target}: pass --yes to confirm")
        return "remove_docs", compact({"library": args.library, "version": args.version})
    if command == "jobs":
        return "list_jobs", compact({"status": args.status})
    if command == "job":
        return "get_job_info", {"jobId": args.job_id}
    if command == "cancel":
        return "cancel_job", {"jobId": args.job_id}
    if command == "fetch":
        return "fetch_url", {"url": args.source_url, "followRedirects": not args.no_follow_redirects}
    raise CliError(EXIT_USAGE, f"unknown command: {command}")


def emit(result: dict, text: str, as_json: bool, stdout: TextIO) -> None:
    print(json.dumps(result, indent=2, ensure_ascii=False) if as_json else text, file=stdout)


def print_tools(client: McpClient, as_json: bool, stdout: TextIO) -> None:
    tools = client.list_tools()
    if as_json:
        print(json.dumps(tools, indent=2, ensure_ascii=False), file=stdout)
        return
    for tool in tools:
        lines = (tool.get("description") or "").strip().splitlines()
        print(f"{tool.get('name')}\t{lines[0] if lines else ''}", file=stdout)


def run(args: argparse.Namespace, env: Mapping[str, str], stdout: TextIO, stderr: TextIO) -> int:
    as_json = getattr(args, "json", False)
    call = None if args.command == "tools" else tool_call_for(args)
    url = resolve_url(getattr(args, "url", None), env)
    insecure = getattr(args, "insecure", False)
    if insecure:
        print("docs-mcp: warning: TLS certificate verification is disabled (--insecure)", file=stderr)
    client = McpClient(url, insecure=insecure)
    client.initialize()
    if call is None:
        print_tools(client, as_json, stdout)
        return EXIT_OK
    name, arguments = call
    result, text = client.call_tool(name, arguments)
    if result.get("isError"):
        print(text or f"{name} failed", file=stderr)
        return EXIT_TOOL
    emit(result, text, as_json, stdout)
    return EXIT_OK


def main(argv=None, env=None, stdout=None, stderr=None) -> int:
    env = os.environ if env is None else env
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exit_request:
        return exit_request.code if isinstance(exit_request.code, int) else EXIT_USAGE
    try:
        return run(args, env, stdout, stderr)
    except CliError as error:
        print(f"docs-mcp: {error}", file=stderr)
        return error.code


if __name__ == "__main__":
    sys.exit(main())
```

Then make it executable: `chmod +x bin/docs-mcp`.

- [ ] **Step 5: Format and run the tests**

Run: `mise exec -- ruff format . && mise exec -- task test`
Expected: lint clean (`ruff check .` reports `All checks passed!` and lists no issue in `bin/docs-mcp`); unittest `OK`, 28 tests (3 manifest + 25 CLI; subtests count once).

- [ ] **Step 6: Smoke-test the executable**

Run: `mise exec -- bin/docs-mcp --help` → usage listing the commands, exit 0. Run: `env -u DOCS_MCP_URL -u CLAUDE_PLUGIN_OPTION_URL bin/docs-mcp libraries; echo "exit=$?"` → `docs-mcp: no server URL: …` and `exit=2`.

- [ ] **Step 7: Commit**

```bash
git add plugins/docs-mcp-server/bin plugins/docs-mcp-server/test
git commit -m "feat(docs-mcp-server): add docs-mcp CLI with MCP Streamable HTTP client"
```

---

### Task 3: Job waiting (`wait`, `scrape --wait`, `refresh --wait`)

**Files:**
- Modify: `plugins/docs-mcp-server/bin/docs-mcp`
- Modify: `plugins/docs-mcp-server/test/test_cli.py` (append a test class)

**Interfaces:**
- Consumes (from Task 2): `CliError`, `EXIT_*`, `McpClient.call_tool`, `build_parser` (the `scrape`, `refresh` and `cancel` subparsers inside it), `tool_call_for`, `emit`, `print_tools`, `run`; tests use `run_cli`, `FakeMcpServer`, `text_result`, `cli`.
- Produces: `parse_job_id(text: str) -> str`, `job_status(text: str) -> str | None`, `wait_for_job(client, job_id: str, timeout: float, interval: float) -> tuple[str, dict, str]`, `report_wait(client, job_id: str, args, stdout, stderr) -> int`, `add_wait_options(parser, with_flag: bool) -> None`; commands `wait <id> [--timeout S] [--interval S]`, and `--wait/--timeout/--interval` on `scrape` and `refresh`.

- [ ] **Step 1: Write the failing tests**

Append to `plugins/docs-mcp-server/test/test_cli.py`, before the final `if __name__ == "__main__":` block:

```python
JOB = "11111111-2222-3333-4444-555555555555"


def job_info(status: str) -> dict:
    return text_result(f"Job Info:\n\n- ID: {JOB}\n  Status: {status}\n  Library: react@19.0.0")


def statuses(*sequence: str):
    """A get_job_info handler returning the given statuses in order, then repeating the last one."""
    remaining = list(sequence)

    def handler(_arguments):
        status = remaining.pop(0) if len(remaining) > 1 else remaining[0]
        return job_info(status)

    return handler


def started(kind: str = "Scraping"):
    return lambda _arguments: text_result(f"🚀 {kind} job started with ID: {JOB}.")


class WaitTest(unittest.TestCase):
    def test_parse_job_id_from_scrape_and_refresh_replies(self):
        self.assertEqual(cli.parse_job_id(f"🚀 Scraping job started with ID: {JOB}."), JOB)
        self.assertEqual(cli.parse_job_id(f"🔄 Refresh job started with ID: {JOB}."), JOB)

    def test_job_status_is_lower_cased(self):
        self.assertEqual(cli.job_status("- ID: x\n  Status: Running"), "running")
        self.assertIsNone(cli.job_status("no status here"))

    def test_scrape_wait_polls_until_completed(self):
        tools = {"scrape_docs": started(), "get_job_info": statuses("queued", "running", "completed")}
        with FakeMcpServer(tools) as server:
            code, out, _ = run_cli("scrape", "react", "https://react.dev", "--wait", "--interval", "0", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertIn("Status: completed", out)
        self.assertEqual(server.calls("get_job_info"), [{"jobId": JOB}] * 3)

    def test_refresh_wait(self):
        tools = {"refresh_version": started("Refresh"), "get_job_info": statuses("completed")}
        with FakeMcpServer(tools) as server:
            code, _, _ = run_cli("refresh", "react", "--wait", "--interval", "0", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertEqual(server.calls("refresh_version"), [{"library": "react"}])

    def test_scrape_without_wait_does_not_poll(self):
        with FakeMcpServer({"scrape_docs": started(), "get_job_info": statuses("completed")}) as server:
            code, _, _ = run_cli("scrape", "react", "https://react.dev", "--url", server.url)
        self.assertEqual(code, 0)
        self.assertEqual(server.calls("get_job_info"), [])

    def test_failed_job_exits_1_with_job_info_on_stderr(self):
        with FakeMcpServer({"get_job_info": statuses("running", "failed")}) as server:
            code, out, err = run_cli("wait", JOB, "--interval", "0", "--url", server.url)
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("Status: failed", err)

    def test_cancelled_job_exits_1(self):
        with FakeMcpServer({"get_job_info": statuses("cancelled")}) as server:
            code, _, _ = run_cli("wait", JOB, "--interval", "0", "--url", server.url)
        self.assertEqual(code, 1)

    def test_wait_times_out_with_exit_4(self):
        with FakeMcpServer({"get_job_info": statuses("running")}) as server:
            code, _, err = run_cli("wait", JOB, "--timeout", "0.2", "--interval", "0.05", "--url", server.url)
        self.assertEqual(code, 4)
        self.assertIn("still running", err)

    def test_scrape_wait_without_job_id_exits_3_and_shows_the_text(self):
        tools = {"scrape_docs": lambda a: text_result("Scraping finished"), "get_job_info": statuses("completed")}
        with FakeMcpServer(tools) as server:
            code, _, err = run_cli("scrape", "react", "https://react.dev", "--wait", "--url", server.url)
        self.assertEqual(code, 3)
        self.assertIn("Scraping finished", err)
        self.assertEqual(server.calls("get_job_info"), [])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `mise exec -- python -m unittest discover -s test -v`
Expected: the `WaitTest` tests fail — `AttributeError: module 'docs_mcp_cli' has no attribute 'parse_job_id'` for the first two, exit code 2 (argparse rejects `--wait` / `wait`) for the rest.

- [ ] **Step 3: Add the imports and constants**

In `bin/docs-mcp`, replace the import block and constants:

```python
import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import TextIO

VERSION = "0.1.0"
PROTOCOL_VERSION = "2025-06-18"
EXIT_OK, EXIT_TOOL, EXIT_USAGE, EXIT_CONNECTION, EXIT_TIMEOUT = 0, 1, 2, 3, 4
```

with:

```python
import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import TextIO

VERSION = "0.1.0"
PROTOCOL_VERSION = "2025-06-18"
EXIT_OK, EXIT_TOOL, EXIT_USAGE, EXIT_CONNECTION, EXIT_TIMEOUT = 0, 1, 2, 3, 4
TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
JOB_ID_RE = re.compile(r"\bID:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})")
STATUS_RE = re.compile(r"^\s*-?\s*Status:\s*(\w+)", re.MULTILINE)
```

- [ ] **Step 4: Add the wait options to the parser**

In `build_parser`, replace:

```python
    scrape.add_argument("--exclude", action="append", help="URL exclude pattern (repeatable)")
    refresh = command("refresh", "re-scrape an indexed library version, skipping unchanged pages")
    refresh.add_argument("library")
    refresh.add_argument("--version")
```

with:

```python
    scrape.add_argument("--exclude", action="append", help="URL exclude pattern (repeatable)")
    add_wait_options(scrape, with_flag=True)
    refresh = command("refresh", "re-scrape an indexed library version, skipping unchanged pages")
    refresh.add_argument("library")
    refresh.add_argument("--version")
    add_wait_options(refresh, with_flag=True)
```

and replace:

```python
    cancel = command("cancel", "cancel a queued or running job")
    cancel.add_argument("job_id")
```

with:

```python
    cancel = command("cancel", "cancel a queued or running job")
    cancel.add_argument("job_id")
    wait = command("wait", "wait for an indexing job to finish")
    wait.add_argument("job_id")
    add_wait_options(wait, with_flag=False)
```

Then insert this function directly above `def build_parser()`:

```python
def add_wait_options(parser: argparse.ArgumentParser, with_flag: bool) -> None:
    if with_flag:
        parser.add_argument("--wait", action="store_true", help="wait for the job to finish")
    parser.add_argument("--timeout", type=float, default=1800.0, help="seconds to wait for the job (default: 1800)")
    parser.add_argument("--interval", type=float, default=5.0, help="seconds between status checks (default: 5)")
```

- [ ] **Step 5: Add the job functions and the new `run`**

Insert directly above `def run(`:

```python
def parse_job_id(text: str) -> str:
    """Extract the job id from a scrape_docs or refresh_version reply."""
    match = JOB_ID_RE.search(text)
    if not match:
        raise CliError(EXIT_CONNECTION, f"no job id in the server reply: {text.strip() or '(empty)'}")
    return match.group(1)


def job_status(text: str) -> str | None:
    """Extract the lower-cased status from a get_job_info reply."""
    match = STATUS_RE.search(text)
    return match.group(1).lower() if match else None


def wait_for_job(client: McpClient, job_id: str, timeout: float, interval: float) -> tuple[str, dict, str]:
    """Poll get_job_info until the job reaches a terminal status; returns (status, result, text)."""
    deadline = time.monotonic() + timeout
    while True:
        result, text = client.call_tool("get_job_info", {"jobId": job_id})
        if result.get("isError"):
            raise CliError(EXIT_TOOL, text or f"get_job_info failed for job {job_id}")
        status = job_status(text)
        if status in TERMINAL_STATUSES:
            return status, result, text
        if time.monotonic() >= deadline:
            raise CliError(EXIT_TIMEOUT, f"job {job_id} still {status or 'in an unknown state'} after {timeout:g}s")
        time.sleep(interval)


def report_wait(client: McpClient, job_id: str, args: argparse.Namespace, stdout: TextIO, stderr: TextIO) -> int:
    status, result, text = wait_for_job(client, job_id, args.timeout, args.interval)
    if status == "completed":
        emit(result, text, getattr(args, "json", False), stdout)
        return EXIT_OK
    print(text, file=stderr)
    return EXIT_TOOL
```

Replace the whole `run` function with:

```python
def run(args: argparse.Namespace, env: Mapping[str, str], stdout: TextIO, stderr: TextIO) -> int:
    as_json = getattr(args, "json", False)
    call = None if args.command in ("tools", "wait") else tool_call_for(args)
    url = resolve_url(getattr(args, "url", None), env)
    insecure = getattr(args, "insecure", False)
    if insecure:
        print("docs-mcp: warning: TLS certificate verification is disabled (--insecure)", file=stderr)
    client = McpClient(url, insecure=insecure)
    client.initialize()
    if args.command == "tools":
        print_tools(client, as_json, stdout)
        return EXIT_OK
    if args.command == "wait":
        return report_wait(client, args.job_id, args, stdout, stderr)
    name, arguments = call
    result, text = client.call_tool(name, arguments)
    if result.get("isError"):
        print(text or f"{name} failed", file=stderr)
        return EXIT_TOOL
    emit(result, text, as_json, stdout)
    if getattr(args, "wait", False):
        return report_wait(client, parse_job_id(text), args, stdout, stderr)
    return EXIT_OK
```

- [ ] **Step 6: Format and run the tests**

Run: `mise exec -- ruff format . && mise exec -- task test`
Expected: lint clean; unittest `OK`, 37 tests.

- [ ] **Step 7: Commit**

```bash
git add plugins/docs-mcp-server/bin/docs-mcp plugins/docs-mcp-server/test/test_cli.py
git commit -m "feat(docs-mcp-server): wait for indexing jobs in the docs-mcp CLI"
```

---

### Task 4: `shared-docs` skill and documentation

**Files:**
- Create: `plugins/docs-mcp-server/skills/shared-docs/SKILL.md`
- Create: `plugins/docs-mcp-server/README.md`
- Modify: `plugins/docs-mcp-server/test/test_plugin_files.py` (append a test class)
- Modify: `README.md` (root: plugin section)

**Interfaces:**
- Consumes: `ROOT` from `test/test_plugin_files.py` (Task 1); CLI commands and exit codes (Tasks 2-3).
- Produces: skill `shared-docs` (invoked as `docs-mcp-server:shared-docs`).

- [ ] **Step 1: Write the failing skill test**

Append to `plugins/docs-mcp-server/test/test_plugin_files.py`, before the final `if __name__ == "__main__":` block:

```python
class SkillTest(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / "skills" / "shared-docs" / "SKILL.md").read_text()
        _, frontmatter, self.body = self.text.split("---\n", 2)
        self.meta = dict(line.split(": ", 1) for line in frontmatter.strip().splitlines())

    def test_frontmatter(self):
        self.assertEqual(self.meta["name"], "shared-docs")
        self.assertGreater(len(self.meta["description"]), 80)

    def test_cli_calls_let_the_variable_override_the_saved_url(self):
        self.assertIn('DOCS_MCP_URL="${DOCS_MCP_URL:-${user_config.url}}" docs-mcp', self.body)

    def test_removal_needs_an_explicit_request(self):
        self.assertIn("remove_docs", self.body)
        self.assertIn("unless the user", self.body)

    def test_documents_how_the_server_fetches_content(self):
        for phrase in ("replaces", "file://", "Content-Type", "application/octet-stream", ".zip"):
            self.assertIn(phrase, self.body)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mise exec -- python -m unittest discover -s test -v`
Expected: 4 errors in `SkillTest`, `FileNotFoundError` for `skills/shared-docs/SKILL.md`.

- [ ] **Step 3: Write the skill**

`plugins/docs-mcp-server/skills/shared-docs/SKILL.md`:

````markdown
---
name: shared-docs
description: Search, index and maintain library documentation on the team's shared docs-mcp-server. Use when looking up a library's API or documentation, when documentation should be indexed or refreshed, or when managing the shared index (libraries, versions, indexing jobs).
---

# Shared docs

The `docs-mcp-server` tools (`mcp__plugin_docs-mcp-server_docs-mcp-server__*`) work on one documentation index shared by the whole team. What you index, refresh or remove changes it for everyone.

## Search

1. If you are not sure a library is indexed, call `list_libraries` (or `find_version` for a version range) first.
2. Call `search_docs` with an explicit `library`, and with `version` when the project pins one. Ask one question per call; for several libraries, make one call per library.
3. If the library is not indexed, say so and offer to index it (below) instead of answering from memory.

## Index and refresh

- **Names**: lower-case kebab-case, prefixed with the team or area that owns the docs (`<area>-<name>`). Reuse an existing library name exactly (check `list_libraries`). Set a version label when the source is versioned.
- **Bound every scrape**: point at the documentation subtree (e.g. `/docs/`, `/reference/`) rather than a whole site, keep `scope` at `subpages` unless the docs span the host, and set `maxPages`, `maxDepth`, `includePatterns` or `excludePatterns` to skip changelogs, blogs and other languages.
- **A scrape replaces the whole library version.** Separate scrapes into the same library and version overwrite each other; to index several documents in one library, they must all be reachable from one root URL (for example an index page that links them).
- **Scrapes run as jobs.** `scrape_docs` returns a job id; check `get_job_info` (or `list_jobs`) until the job is `completed` before searching, and report the error of a `failed` job.
- Prefer `refresh_version` over a new scrape to pick up changes: it skips unchanged pages.
- **The server fetches every URL itself.** `file://` paths refer to the server's own disk, not yours. Private documents need a URL the server can reach, served with their exact `Content-Type` (a `.docx` needs `application/vnd.openxmlformats-officedocument.wordprocessingml.document`); `application/octet-stream` is rejected even when the URL ends in `.docx`, and remote `.zip` archives are not indexed.
- Never call `remove_docs` (or `docs-mcp remove`) unless the user asked to delete that exact library or version; confirm the name and version with them first.

## The `docs-mcp` command

For a single lookup use the MCP tools. Use the `docs-mcp` command (on the `PATH` while this plugin is enabled) for loops over many libraries or URLs, for waiting on jobs, and from scripts or other skills. Always run it in this form, so a `DOCS_MCP_URL` set in the environment wins over the URL saved in the plugin's settings, exactly as for the MCP connection:

```bash
DOCS_MCP_URL="${DOCS_MCP_URL:-${user_config.url}}" docs-mcp libraries
DOCS_MCP_URL="${DOCS_MCP_URL:-${user_config.url}}" docs-mcp search react "useEffect cleanup" --version 19.x
DOCS_MCP_URL="${DOCS_MCP_URL:-${user_config.url}}" docs-mcp scrape web-react https://react.dev/reference --version 19.0.0 --max-pages 300 --wait
```

| Command | Does |
|---|---|
| `libraries` | list indexed libraries |
| `versions <library> [--target V]` | best matching version |
| `search <library> <query> [--version V] [--limit N]` | search one library |
| `scrape <library> <url> [--version V] [--max-pages N] [--max-depth N] [--scope S] [--include P]… [--exclude P]… [--wait]` | index a URL (replaces the version) |
| `refresh <library> [--version V] [--wait]` | re-scrape changed pages |
| `jobs [--status S]`, `job <id>`, `wait <id> [--timeout S]`, `cancel <id>` | indexing jobs |
| `fetch <url>` | read one page as Markdown without indexing |
| `remove <library> [--version V] --yes` | delete (only when the user asked) |
| `tools`, `call <tool> [JSON]` | list or call any server tool |

Add `--json` for the raw result. Exit codes: 0 success, 1 server error or failed job, 2 usage error or no URL, 3 connection, TLS or protocol error, 4 timed out waiting. For a server with a private CA, set `SSL_CERT_FILE`; use `--insecure` only if the user agrees.
````

- [ ] **Step 4: Write the plugin README**

`plugins/docs-mcp-server/README.md`:

````markdown
# docs-mcp-server

Connects Claude Code to a shared [docs-mcp-server](https://github.com/arabold/docs-mcp-server) (Grounded Docs) so the whole team searches and maintains one documentation index, and adds the `docs-mcp` command for scripts and other skills.

## Install and configure

```bash
claude plugin install docs-mcp-server@blasterm2a
```

The plugin asks for the server's MCP endpoint (for example `https://docs.example.internal/mcp`); change it later in `/config`. Instead of a saved value you can set `DOCS_MCP_URL`; when both are set, the variable wins.

If you already configured the same server by hand (`claude mcp add …`), Claude Code ignores the plugin's copy as a duplicate: remove your manual entry (`claude mcp remove <name> -s user`) to switch to the plugin.

## Requirements

- A docs-mcp-server reachable from your machine (on its private network or VPN if it has one).
- Python 3.10+ for the `docs-mcp` command.
- For a server with a certificate from a private CA: `SSL_CERT_FILE` pointing to that CA bundle.

## What you get

- **MCP tools** `mcp__plugin_docs-mcp-server_docs-mcp-server__*`: `search_docs`, `list_libraries`, `find_version`, `scrape_docs`, `refresh_version`, `remove_docs`, `fetch_url`, `list_jobs`, `get_job_info`, `cancel_job`.
- **Skill** `docs-mcp-server:shared-docs`: search first, conventions for a shared index, and how the server fetches content.
- **Command** `docs-mcp` (on the `PATH` of Claude's shell while the plugin is enabled):

```bash
docs-mcp libraries
docs-mcp search react "useEffect cleanup" --version 19.x
docs-mcp scrape web-react https://react.dev/reference --version 19.0.0 --max-pages 300 --wait
docs-mcp wait <job-id> --timeout 600
docs-mcp remove web-react --version 18.3.1 --yes
docs-mcp --help
```

The endpoint is the first non-empty value of `--url`, `DOCS_MCP_URL` and `CLAUDE_PLUGIN_OPTION_URL`. Exit codes: 0 success, 1 server error or failed job, 2 usage error or no URL, 3 connection/TLS/protocol error, 4 timed out waiting.

## Things to know about the server

- It fetches every URL itself: `file://` means the server's disk, and private documents need a URL it can reach, served with their exact `Content-Type`.
- A scrape replaces the whole library version; separate scrapes into the same version overwrite each other.

## Development

`task test` runs ruff and the unit tests (no server needed). Design: `docs/superpowers/specs/2026-09-27-docs-mcp-server-plugin-design.md`.

## Credits

The skill is original text modelled on the `docs-search`, `docs-manage` and `fetch-url` skills of [arabold/docs-mcp-server](https://github.com/arabold/docs-mcp-server) (MIT).
````

- [ ] **Step 5: Add the plugin section to the root README**

Run from the repository root (the root README's order is: plugins table, one `###` section per plugin, then `## Development`, so the new section goes right before `## Development`):

```bash
python3 - <<'EOF'
import pathlib
p = pathlib.Path("README.md"); s = p.read_text()
section = (
    "### docs-mcp-server\n\n"
    "Connects Claude Code to a shared [docs-mcp-server](https://github.com/arabold/docs-mcp-server) over MCP "
    "and adds the `docs-mcp` command and the `shared-docs` skill. On install it asks for the server's MCP URL; "
    "leave it empty to use `DOCS_MCP_URL` instead (the variable wins when both are set). The `docs-mcp` command "
    "needs Python 3.10+. See the [plugin README](plugins/docs-mcp-server/README.md).\n\n"
)
assert s.count("\n## Development") == 1
p.write_text(s.replace("\n## Development", "\n" + section + "## Development", 1))
EOF
grep -n '^##' README.md
```

Expected: the headings list `### superpowers-plus`, then `### docs-mcp-server`, then `## Development`.

- [ ] **Step 6: Run all checks**

Run from `plugins/docs-mcp-server`: `mise exec -- task test` → unittest `OK`, 41 tests.
Run from the repository root: `mise exec -- task validate` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add README.md plugins/docs-mcp-server/README.md plugins/docs-mcp-server/skills plugins/docs-mcp-server/test/test_plugin_files.py
git commit -m "docs(docs-mcp-server): add shared-docs skill and plugin README"
```

---

### Task 5: Verification against a real server

**Files:** none changed unless a check fails (then fix in the owning file and commit).

**Interfaces:**
- Consumes: the finished plugin; from the human partner: the server URL (never written to the repository) and, optionally, a local file of organisation-specific patterns for the public-safety check.
- Produces: a verification report (commands run and their output) for the final review.

- [ ] **Step 1: Full local checks**

Run from the repository root: `mise exec -- task` → validate and every plugin's tests pass, exit 0.

- [ ] **Step 2: Public-safety check**

Ask the human partner for the path of their private pattern file (one extended regex per line; it is not in the repository). Run:

```bash
git grep -niE -f "<pattern file>" -- plugins/docs-mcp-server .claude-plugin README.md
```

Expected: no output. If they have no pattern file, record that the check was skipped.

- [ ] **Step 3: Install in an isolated configuration and check the connection**

Ask the human partner for the server URL and export it as `SERVER_URL` in the shell (do not write it to any file in the repository). Then, from the repository root:

```bash
export CLAUDE_CONFIG_DIR="$(mktemp -d)"
claude plugin marketplace add "$PWD"
claude plugin install docs-mcp-server@blasterm2a
DOCS_MCP_URL="$SERVER_URL" claude mcp list | grep docs-mcp-server
```

Expected: `plugin:docs-mcp-server:docs-mcp-server: $SERVER_URL (HTTP) - ✔ Connected`.

Saved value only, then both with the variable winning:

```bash
jq -n --arg u "$SERVER_URL" '{pluginConfigs: {"docs-mcp-server@blasterm2a": {options: {url: $u}}}}' > "$CLAUDE_CONFIG_DIR/settings.json"
env -u DOCS_MCP_URL claude mcp list | grep docs-mcp-server
jq -n '{pluginConfigs: {"docs-mcp-server@blasterm2a": {options: {url: "https://unreachable.example.invalid/mcp"}}}}' > "$CLAUDE_CONFIG_DIR/settings.json"
DOCS_MCP_URL="$SERVER_URL" claude mcp list | grep docs-mcp-server
rm -rf "$CLAUDE_CONFIG_DIR"; unset CLAUDE_CONFIG_DIR
```

Expected: both `grep` lines show `$SERVER_URL` and `✔ Connected`.

- [ ] **Step 4: Exercise the CLI end to end**

From `plugins/docs-mcp-server`, with `export DOCS_MCP_URL="$SERVER_URL"`:

```bash
LIB="zz-e2e-$(date +%Y%m%d%H%M)"
bin/docs-mcp libraries
bin/docs-mcp scrape "$LIB" https://docs.python.org/3/library/json.html --max-pages 1 --max-depth 0 --wait --timeout 300
bin/docs-mcp search "$LIB" "dump indent"
bin/docs-mcp remove "$LIB" --yes
bin/docs-mcp libraries
```

Expected: the scrape ends with `Status: completed` (exit 0); the search returns text from the `json` module page; after `remove`, `$LIB` is no longer listed. If a server with a private CA fails with a certificate error, retry with `SSL_CERT_FILE` set to that CA bundle, not with `--insecure`.

- [ ] **Step 5: Check how the skill renders the saved URL when none is saved**

Run from the repository root: `claude -p "Show the first bash code block of the shared-docs skill exactly as it was given to you." --plugin-dir plugins/docs-mcp-server`
Expected: the lines read `DOCS_MCP_URL="${DOCS_MCP_URL:-}" docs-mcp …` (empty saved value substituted). If the literal text `${user_config.url}` is still present, stop and report it to the human partner: in bash that is a "bad substitution" error, and the skill's command form must change.

- [ ] **Step 6: Report**

Summarise, for the final review: the output of Steps 1-5, any fixes made (with their commits), and anything skipped.

---

## Rollout (after the final review, run by the human partner)

1. `/release-plugin docs-mcp-server 0.1.0`.
2. `claude plugin install docs-mcp-server@blasterm2a`, enter the server URL (or set `DOCS_MCP_URL`).
3. Remove the manual MCP entry for the same server (`claude mcp remove <name> -s user`), start a new session and check the `mcp__plugin_docs-mcp-server_docs-mcp-server__*` tools are listed.
