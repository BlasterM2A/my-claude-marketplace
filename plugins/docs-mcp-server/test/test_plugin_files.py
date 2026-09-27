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


class SkillTest(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / "skills" / "shared-docs" / "SKILL.md").read_text()
        _, frontmatter, self.body = self.text.split("---\n", 2)
        self.meta = dict(line.split(": ", 1) for line in frontmatter.strip().splitlines())

    def test_frontmatter(self):
        self.assertEqual(self.meta["name"], "shared-docs")
        self.assertGreater(len(self.meta["description"]), 80)

    def test_cli_calls_rely_on_the_clis_own_url_resolution(self):
        # Unlike the mcpServers "url" field, Claude Code does not substitute
        # ${user_config.url} inside skill body text, so the skill must not
        # rely on that placeholder here; the CLI already falls back from
        # --url to DOCS_MCP_URL to CLAUDE_PLUGIN_OPTION_URL on its own.
        self.assertNotIn("user_config", self.body)
        self.assertIn("docs-mcp libraries", self.body)

    def test_removal_needs_an_explicit_request(self):
        self.assertIn("remove_docs", self.body)
        self.assertIn("unless the user", self.body)

    def test_documents_how_the_server_fetches_content(self):
        for phrase in ("replaces", "file://", "Content-Type", "application/octet-stream", ".zip"):
            self.assertIn(phrase, self.body)


if __name__ == "__main__":
    unittest.main()
