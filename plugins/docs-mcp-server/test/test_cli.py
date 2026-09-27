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
