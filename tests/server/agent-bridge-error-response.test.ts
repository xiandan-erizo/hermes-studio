import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('preserves worker domain errors across the broker while retaining transport failures', () => {
  const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', String.raw`
import json
import socket
import sys
import threading
import types

runtime = types.ModuleType("bridge_runtime")
runtime._hidden_subprocess_kwargs = lambda: {}
runtime._json_line_bytes = lambda req: (json.dumps(req) + "\n").encode()
runtime._platform_text_encoding = lambda: "utf-8"
runtime._install_stop_signal_handlers = lambda *args: None
runtime._jsonable = lambda value: value
sys.modules["bridge_runtime"] = runtime
sys.path.insert(0, "packages/server/src/modules/hermes/services/bridge/python")
from bridge_transport import _send_bridge_request
from bridge_broker import BridgeBroker

listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen()
endpoint = "tcp://127.0.0.1:%s" % listener.getsockname()[1]
responses = [
    {"ok": False, "code": "mcp_app_not_found", "error": "The MCP tool does not declare an App resource"},
    {"ok": False, "code": "mcp_app_server_unavailable", "error": "The MCP server is not connected"},
    {"ok": True, "resource": {"uri": "ui://ticket/card.html"}},
    None,
]
def serve():
    try:
        for response in responses:
            connection, _ = listener.accept()
            with connection:
                connection.recv(65536)
                if response is not None:
                    connection.sendall((json.dumps(response) + "\n").encode())
    finally:
        listener.close()
thread = threading.Thread(target=serve, daemon=True)
thread.start()

class ConnectedWorker:
    def request(self, req, timeout):
        return _send_bridge_request(endpoint, req, 5)

broker = BridgeBroker("tcp://127.0.0.1:0")
broker._workers["default"] = ConnectedWorker()
results = [broker.handle({"action": "mcp_app_resolve", "profile": "default", "tool_name": "mcp__test__tool"}) for _ in responses]
thread.join(5)
print(json.dumps(results))
`], { encoding: 'utf8', timeout: 15000 })
  expect(JSON.parse(output)).toEqual([
    { ok: false, code: 'mcp_app_not_found', error: 'The MCP tool does not declare an App resource' },
    { ok: false, code: 'mcp_app_server_unavailable', error: 'The MCP server is not connected' },
    { ok: true, resource: { uri: 'ui://ticket/card.html' } },
    { ok: false, error: 'worker closed without a response' },
  ])
})
