import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('routes App calls only to allowed tools on the resource-owning server', () => {
  const output = execFileSync(process.env.HERMES_AGENT_BRIDGE_PYTHON || 'python3', ['-c', String.raw`
import asyncio, importlib.util, json, sys, threading
from types import SimpleNamespace
try:
    from mcp.types import CallToolResult, TextContent
except ImportError:
    # Default unit runs need no Hermes environment; the runtime smoke uses the
    # installed SDK via HERMES_AGENT_BRIDGE_PYTHON and exercises the same contract.
    def TextContent(**kwargs):
        return kwargs
    class CallToolResult:
        def __init__(self, **kwargs):
            self.data = {"isError": False, **kwargs}
        def model_dump(self, *, mode, by_alias, exclude_none):
            assert mode == "json" and by_alias and exclude_none
            return self.data
spec = importlib.util.spec_from_file_location("hermes_bridge", "packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py")
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)
server = bridge.BridgeServer("tcp://127.0.0.1:0")
def tool(name, ui=None, annotations=None):
    return SimpleNamespace(name=name, meta={"ui": ui or {}}, annotations=annotations or {"readOnlyHint": True})
class Session:
    async def call_tool(self, name, arguments):
        calls.append([name, arguments])
        return CallToolResult(content=[TextContent(type="text", text="saved")], structuredContent={"version": 2}, _meta={"private": "preserved"})
calls = []
tools = [tool("render", {"resourceUri": "ui://demo/card.html", "visibility": ["model"]}),
    tool("get"), tool("update", {"visibility": ["app"]}, {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}),
    tool("hidden", {"visibility": ["model"]}), tool("delete", {}, {"destructiveHint": True})]
task = SimpleNamespace(_tools=tools, _config={}, session=Session())
servers = {"demo": task, "other": SimpleNamespace(_tools=[tool("foreign")], session=Session())}
config = {"mcp_servers": {"demo": {}}}
server._read_mcp_config = lambda p: config
server._portable_mcp_server_names = lambda p: set()
run = lambda f, timeout=30: asyncio.run(f())
prefix = lambda s, t: f"mcp__{s}__{t}"
def invoke(target="update", origin="mcp__demo__render", arguments=None):
    return server._mcp_app_call_tool({"tool_name": origin, "name": target, "arguments": arguments or {"version":1}}, "work", servers, threading.RLock(), run, prefix)
good = invoke()
denied = [invoke("hidden"), invoke("foreign"), invoke("mcp__other__foreign"), invoke("delete"), invoke(origin="mcp__demo__get")]
config["mcp_servers"]["demo"]["tools"] = {"include": ["render*", "up*"], "exclude": ["get*"]}
globGood = invoke()
globDenied = invoke("get")
config["mcp_servers"]["demo"]["tools"] = {"include": []}
denied.append(invoke())
config["mcp_servers"]["demo"] = {"enabled": False}
denied.append(invoke())
disabled_resolve = server._mcp_app_resolve({"tool_name": "mcp__demo__render"}, "work", servers, threading.RLock(), run, prefix)
print(json.dumps({"good":good, "globGood":globGood["ok"], "globDenied":globDenied["ok"], "denied":[r["ok"] for r in denied], "calls":calls, "disabledResolve":disabled_resolve["code"]}))
`], { encoding: 'utf8' })
  expect(JSON.parse(output)).toEqual({
    good: { ok: true, result: { content: [{ type: 'text', text: 'saved' }], structuredContent: { version: 2 }, _meta: { private: 'preserved' }, isError: false } },
    globGood: true, globDenied: false,
    denied: [false, false, false, false, false, false, false], calls: [['update', { version: 1 }], ['update', { version: 1 }]], disabledResolve: 'mcp_app_not_found',
  })
})
