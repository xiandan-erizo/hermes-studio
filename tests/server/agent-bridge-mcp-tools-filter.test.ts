import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): any {
  try {
    const output = execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return JSON.parse(output)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python bridge MCP filter script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

describe('agent bridge MCP tools filtering', () => {
  it('treats an empty include list as an active filter and keeps raw listing unfiltered', () => {
    const result = runPython(String.raw`
import importlib.util
import json
import sys
import threading
from pathlib import Path

path = Path("packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

class Tool:
    def __init__(self, name):
        self.name = name
        self.description = f"{name} description"
        self.inputSchema = {"type": "object"}

class Task:
    _task = None
    _error = None

    def __init__(self):
        self._tools = [Tool("read_file"), Tool("write_file"), Tool("delete_file")]
        self._registered_tool_names = ["read_file", "write_file", "delete_file"]
        self._config = {"command": "mcp-server"}

server = bridge.BridgeServer("tcp://127.0.0.1:0")
servers = {"fs": Task()}
lock = threading.RLock()

def names(response):
    return [tool["name"] for tool in response["results"][0]["tools"]]

server._read_mcp_config = lambda profile: {
    "mcp_servers": {
        "fs": {
            "command": "mcp-server",
            "tools": {"include": []},
        },
    },
}
include_empty = server._mcp_tools_list({"server": "fs"}, "default", servers, lock)
include_empty_list = server._mcp_list("default", servers, lock)
include_empty_raw = server._mcp_tools_list({"server": "fs", "raw": True}, "default", servers, lock)

server._read_mcp_config = lambda profile: {
    "mcp_servers": {
        "fs": {
            "command": "mcp-server",
            "tools": {"include": ["read_file"]},
        },
    },
}
include_one = server._mcp_tools_list({"server": "fs"}, "default", servers, lock)

server._read_mcp_config = lambda profile: {
    "mcp_servers": {
        "fs": {
            "command": "mcp-server",
            "tools": {"exclude": ["delete_file"]},
        },
    },
}
exclude_one = server._mcp_tools_list({"server": "fs"}, "default", servers, lock)

print(json.dumps({
    "include_empty": names(include_empty),
    "include_empty_details": include_empty_list["servers"][0]["tool_details"],
    "include_empty_raw": names(include_empty_raw),
    "include_one": names(include_one),
    "exclude_one": names(exclude_one),
}))
`)

    expect(result).toEqual({
      include_empty: [],
      include_empty_details: [],
      include_empty_raw: ['read_file', 'write_file', 'delete_file'],
      include_one: ['read_file'],
      exclude_one: ['read_file', 'write_file'],
    })
  })

  it('forwards app metadata and reads only the resource declared by a portable MCP tool', () => {
    const result = runPython(String.raw`
import asyncio
import base64
import importlib.util
import json
import sys
import threading
from pathlib import Path

path = Path("packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge_apps", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

class Annotations:
    def model_dump(self, *, mode, by_alias, exclude_none):
        assert mode == "json" and by_alias and exclude_none
        return {"readOnlyHint": True, "destructiveHint": False}

class Tool:
    def __init__(self, name, meta=None, title=None):
        self.name = name
        self.title = title
        self.description = f"{name} description"
        self.inputSchema = {"type": "object"}
        self.outputSchema = {"type": "object", "required": ["kind"]}
        self.annotations = Annotations()
        self.meta = meta

class Content:
    def __init__(self, mime="text/html;profile=mcp-app", text="<html><body>ticket</body></html>", blob=None):
        self.uri = "ui://ticket/view-v1.html"
        self.mimeType = mime
        self.text = text
        self.blob = blob
        self.meta = {"ui": {"prefersBorder": False, "csp": {"connectDomains": []}}}

class Result:
    def __init__(self, content):
        self.contents = [content]

class Session:
    def __init__(self):
        self.content = Content()
        self.read = []

    async def read_resource(self, uri):
        self.read.append(uri)
        return Result(self.content)

class AsyncLock:
    async def __aenter__(self):
        return self
    async def __aexit__(self, *_args):
        return False

class Task:
    _task = None
    _error = None
    _config = {"command": "node"}

    def __init__(self):
        self._tools = [
            Tool("render", {"ui": {"resourceUri": "ui://ticket/view-v1.html"}}, "Ticket preview"),
            Tool("hidden", {"ui": {"resourceUri": "ui://ticket/view-v1.html"}}),
            Tool("plain"),
        ]
        self._registered_tool_names = ["mcp__portable__render", "mcp__portable__plain"]
        self.session = Session()
        self._rpc_lock = AsyncLock()

server = bridge.BridgeServer("tcp://127.0.0.1:0")
server._read_mcp_config = lambda _profile: {"mcp_servers": {"portable": {"tools": {"exclude": ["hidden"]}}}}
server._portable_mcp_server_names = lambda _profile: {"portable"}
bridge._server.resolve_mcp_app_identity = lambda server_name: {
    "id": "ticket-intake",
    "name": "Ticket Intake",
    "version": "4.0.2",
}
task = Task()
servers = {"portable": task}
lock = threading.RLock()
run = lambda factory, timeout=30: asyncio.run(factory())
prefixed = lambda server_name, tool_name: f"mcp__{server_name}__{tool_name}"

listed = server._mcp_tools_list({}, "research", servers, lock)
resolved = server._mcp_app_resolve(
    {"tool_name": "mcp__portable__render", "resource_uri": "file:///etc/passwd"},
    "research", servers, lock, run, prefixed,
)
plain = server._mcp_app_resolve(
    {"tool_name": "mcp__portable__plain"}, "research", servers, lock, run, prefixed,
)
hidden = server._mcp_app_resolve(
    {"tool_name": "mcp__portable__hidden"}, "research", servers, lock, run, prefixed,
)
task.session.content = Content(mime="text/html")
wrong_mime = server._mcp_app_resolve(
    {"tool_name": "mcp__portable__render"}, "research", servers, lock, run, prefixed,
)
task.session.content = Content(text="x" * (1024 * 1024 + 1))
oversized = server._mcp_app_resolve(
    {"tool_name": "mcp__portable__render"}, "research", servers, lock, run, prefixed,
)
task.session.content = Content(text=None, blob=base64.b64encode("<p>工单</p>".encode("utf-8")).decode("ascii"))
blob = server._mcp_app_resolve(
    {"tool_name": "mcp__portable__render"}, "research", servers, lock, run, prefixed,
)
task.session.content = Content(text=None, blob=base64.b64encode(b"\xff\xfe").decode("ascii"))
invalid_utf8 = server._mcp_app_resolve(
    {"tool_name": "mcp__portable__render"}, "research", servers, lock, run, prefixed,
)
task.session.content = Content(text=None, blob="A" * (4 * ((server.MAX_MCP_APP_RESOURCE_BYTES + 2) // 3) + 4))
original_b64decode = bridge._server.base64.b64decode
bridge._server.base64.b64decode = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("oversized blob was decoded"))
oversized_blob = server._mcp_app_resolve(
    {"tool_name": "mcp__portable__render"}, "research", servers, lock, run, prefixed,
)
bridge._server.base64.b64decode = original_b64decode
task.session.content = Content(text=None, blob="%%%");
malformed_blob = server._mcp_app_resolve(
    {"tool_name": "mcp__portable__render"}, "research", servers, lock, run, prefixed,
)

print(json.dumps({
    "listed": listed,
    "resolved": resolved,
    "plain": plain,
    "hidden": hidden,
    "wrong_mime": wrong_mime,
    "oversized": oversized,
    "blob": blob,
    "invalid_utf8": invalid_utf8,
    "oversized_blob": oversized_blob,
    "malformed_blob": malformed_blob,
    "read": task.session.read,
}))
`)

    const tool = result.listed.results[0].tools[0]
    expect(tool).toMatchObject({
      name: 'render',
      output_schema: { type: 'object', required: ['kind'] },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: 'ui://ticket/view-v1.html' } },
    })
    expect(result.resolved).toMatchObject({
      ok: true,
      tool: {
        name: 'mcp__portable__render', raw_name: 'render', server: 'portable',
        title: 'Ticket preview',
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      app: { id: 'ticket-intake', name: 'Ticket Intake', version: '4.0.2' },
      resource: {
        uri: 'ui://ticket/view-v1.html',
        mimeType: 'text/html;profile=mcp-app',
        text: '<html><body>ticket</body></html>',
        _meta: { ui: { prefersBorder: false } },
      },
    })
    expect(result.plain).toMatchObject({ ok: false, code: 'mcp_app_not_found' })
    expect(result.hidden).toMatchObject({ ok: false, code: 'mcp_app_not_found' })
    expect(result.wrong_mime).toMatchObject({ ok: false, code: 'mcp_app_invalid_resource' })
    expect(result.oversized).toMatchObject({ ok: false, code: 'mcp_app_resource_too_large' })
    expect(result.blob).toMatchObject({
      ok: true,
      resource: { text: '<p>工单</p>' },
    })
    expect(result.invalid_utf8).toMatchObject({ ok: false, code: 'mcp_app_invalid_resource' })
    expect(result.oversized_blob).toMatchObject({ ok: false, code: 'mcp_app_resource_too_large' })
    expect(result.malformed_blob).toMatchObject({ ok: false, code: 'mcp_app_invalid_resource' })
    expect(result.read[0]).toBe('ui://ticket/view-v1.html')
    expect(result.read).not.toContain('file:///etc/passwd')
  })
})
