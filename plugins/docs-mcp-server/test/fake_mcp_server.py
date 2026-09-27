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
