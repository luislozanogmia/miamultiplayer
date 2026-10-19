"""Synthetic native-runtime gate; no account or real credentials are used."""
import asyncio
import importlib.util
import io
import json
import os
import pathlib
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client
from mcp.shared.message import SessionMessage

adapter = pathlib.Path(sys.argv[1]).resolve()
secret_module = pathlib.Path(sys.argv[2]).resolve()
python_command = os.environ.get("MIA_SMOKE_PYTHON", sys.executable)
token = "synthetic-broker-" + "r" * 26
assert len(token) == 43
calls = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        assert self.path == "/run"
        assert self.headers.get("Authorization") == "Bearer " + token
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        calls.append(body["args"])
        payload = json.dumps({"code": 0, "stdout": json.dumps({"labels": []}), "stderr": ""}).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(payload)


broker = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=broker.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{broker.server_port}"
spec = importlib.util.spec_from_file_location("mia_process_secrets_test", secret_module)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module._values.update(MIA_GOOGLE_BROKER_URL=url, MIA_GOOGLE_BROKER_RUN_TOKEN=token,
                      MIA_GOOGLE_MCP_SERVER=str(adapter), MIA_GOOGLE_MCP_PYTHON=python_command)
assert module.bootstrap_for(python_command, [str(adapter)]) == {"url": url, "token": token}
assert module.bootstrap_for(python_command, ["/untrusted/adapter.py"]) is None
assert module.bootstrap_for(python_command, [str(adapter), "extra"]) is None
assert token not in json.dumps(dict(os.environ))


async def check():
    params = StdioServerParameters(command=python_command, args=[str(adapter)], env={"PYTHONDONTWRITEBYTECODE": "1"})
    async with stdio_client(params) as (read, write):
        await write.send(SessionMessage(types.JSONRPCNotification(
            jsonrpc="2.0", method="mia/broker/bootstrap", params=module.bootstrap_for(python_command, [str(adapter)]))))
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert any(t.name == "google_gmail_labels" for t in tools.tools)
            result = await session.call_tool("google_gmail_labels", {})
            assert not getattr(result, "is_error", getattr(result, "isError", False))
            assert calls and calls[-1][:4] == ["gmail", "users", "labels", "list"]
            assert token not in str(result)
            if sys.platform == "linux":
                import psutil
                children = psutil.Process().children(recursive=True)
                assert children
                for child in children:
                    try:
                        assert token.encode() not in pathlib.Path(f"/proc/{child.pid}/environ").read_bytes()
                        assert token.encode() not in pathlib.Path(f"/proc/{child.pid}/cmdline").read_bytes()
                    except FileNotFoundError:
                        pass


async def transport_check():
    from hermes_cli import mia_process_secrets
    from tools.mcp_tool import MCPServerTask
    payload = {"MIA_GOOGLE_BROKER_URL": url, "MIA_GOOGLE_BROKER_RUN_TOKEN": token,
               "MIA_GOOGLE_MCP_SERVER": str(adapter), "MIA_GOOGLE_MCP_PYTHON": python_command}
    previous_stdin = sys.stdin
    try:
        sys.stdin = io.TextIOWrapper(io.BytesIO((json.dumps(payload) + "\n").encode()))
        os.environ["MIAOS_PROCESS_SECRETS_STDIN"] = "1"
        mia_process_secrets.load()
    finally:
        sys.stdin = previous_stdin
    assert "MIA_GOOGLE_BROKER_RUN_TOKEN" not in os.environ

    class Probe(MCPServerTask):
        async def _serve_session(self, session, *args, **kwargs):
            await session.initialize()
            result = await session.call_tool("google_gmail_labels", {})
            assert not getattr(result, "is_error", getattr(result, "isError", False))
            assert token not in str(result)
            return "MIA_TRANSPORT_PASS"

    probe = Probe("mia-broker-smoke")
    result = await probe._run_stdio({"command": python_command, "args": [str(adapter)]})
    assert result == "MIA_TRANSPORT_PASS"


try:
    asyncio.run(asyncio.wait_for(check(), 20))
    if "--transport" in sys.argv:
        asyncio.run(asyncio.wait_for(transport_check(), 30))
    print(json.dumps({"gate": "broker bootstrap, MCP initialize and bounded tool call", "passed": True,
                      "platform": sys.platform, "hermes_transport": "--transport" in sys.argv,
                      "sibling_environment_check": "passed" if sys.platform == "linux" else "not_applicable"}))
finally:
    broker.shutdown()
