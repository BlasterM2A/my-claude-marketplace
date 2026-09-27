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
