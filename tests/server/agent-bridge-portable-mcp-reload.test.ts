import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): any {
  const output = execFileSync('python3', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: 'pipe',
  })
  return JSON.parse(output)
}

describe('agent bridge portable MCP reload', () => {
  it('re-discovers plugins, replaces only portable servers, and registers the new configs', () => {
    const result = runPython(String.raw`
import importlib.util
import json
import sys
import threading
import types
from contextlib import nullcontext
from pathlib import Path

path = Path("packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge_portable_reload", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)
bridge._server._profile_env = lambda _profile: nullcontext()

events = []

class Manager:
    configs = {"old-portable": {"command": "old"}}
    def get_portable_mcp_servers(self):
        return dict(self.configs)

manager = Manager()
def discover(force=False):
    events.append(["discover", force])
    manager.configs = {"new-portable": {"command": "new"}}

server = bridge.BridgeServer("tcp://127.0.0.1:0")
server._shutdown_mcp_servers = lambda names, *_args: events.append(["shutdown", sorted(names)]) or len(names)
registered = {}
def register(configs):
    registered.update(configs)
    events.append(["register", sorted(configs)])
    return ["mcp__new-portable__render"]

response = server._mcp_portable_reload(
    "research",
    {"old-portable": object(), "native": object()},
    threading.RLock(),
    lambda *_args, **_kwargs: None,
    register,
    discover,
    lambda: manager,
)
print(json.dumps({"response": response, "events": events, "registered": registered}))
`)

    expect(result.events).toEqual([
      ['discover', true],
      ['shutdown', ['old-portable']],
      ['register', ['new-portable']],
    ])
    expect(result.registered).toEqual({ 'new-portable': { command: 'new' } })
    expect(result.response).toMatchObject({
      ok: true,
      stopped: 1,
      servers: ['new-portable'],
      tools: ['mcp__new-portable__render'],
    })
  })

  it('interpolates portable MCP configs and registers them within the selected Profile environment', () => {
    const result = runPython(String.raw`
import importlib.util
import json
import os
import sys
import threading
import types
from contextlib import contextmanager
from pathlib import Path

path = Path("packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge_portable_profile", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

active_profiles = []
@contextmanager
def profile_env(profile):
    active_profiles.append(profile)
    previous = os.environ.get("PLUGIN_TOKEN")
    os.environ["PLUGIN_TOKEN"] = "research-token"
    try:
        yield
    finally:
        active_profiles.pop()
        if previous is None:
            os.environ.pop("PLUGIN_TOKEN", None)
        else:
            os.environ["PLUGIN_TOKEN"] = previous
bridge._server._profile_env = profile_env

class Manager:
    configs = {"ticket-view": {"command": "node", "env": {"TOKEN": "${'${'}PLUGIN_TOKEN}"}}}
    def get_portable_mcp_servers(self):
        return dict(self.configs)
manager = Manager()

plugins = types.ModuleType("hermes_cli.plugins")
plugins.discover_plugins = lambda force=False: None
plugins.get_plugin_manager = lambda: manager
sys.modules["hermes_cli.plugins"] = plugins

tools_package = types.ModuleType("tools")
tools_package.__path__ = []
mcp_module = types.ModuleType("tools.mcp_tool")
mcp_module.discover_mcp_tools = lambda: []
mcp_module.mcp_prefixed_tool_name = lambda server_name, tool_name: f"mcp__{server_name}__{tool_name}"
mcp_module._run_on_mcp_loop = lambda *_args, **_kwargs: None
mcp_module._servers = {}
mcp_module._lock = threading.RLock()
mcp_module._interpolate_env_vars = lambda value: {
    **value,
    "env": {**value.get("env", {}), "TOKEN": os.environ["PLUGIN_TOKEN"]},
}
events = []
def register(configs):
    events.append({
        "active_profiles": list(active_profiles),
        "token": configs["ticket-view"]["env"]["TOKEN"],
    })
    return ["mcp__ticket-view__render"]
mcp_module.register_mcp_servers = register
sys.modules["tools"] = tools_package
sys.modules["tools.mcp_tool"] = mcp_module

server = bridge.BridgeServer("tcp://127.0.0.1:0")
response = server._handle_mcp_action("mcp_portable_reload", {}, "research")
print(json.dumps({"response": response, "events": events}))
`)

    expect(result.events).toEqual([
      { active_profiles: ['research'], token: 'research-token' },
    ])
    expect(result.response).toMatchObject({
      ok: true,
      servers: ['ticket-view'],
      tools: ['mcp__ticket-view__render'],
    })
  })

  it('keeps existing MCP actions working when an older Hermes lacks portable plugin APIs', () => {
    const result = runPython(String.raw`
import builtins
import importlib.util
import json
import sys
import threading
import types
from pathlib import Path

path = Path("packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge_old_runtime", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

server = bridge.BridgeServer("tcp://127.0.0.1:0")
server._mcp_list = lambda *_args: {"ok": True, "servers": ["legacy"]}
tools_package = types.ModuleType("tools")
tools_package.__path__ = []
mcp_module = types.ModuleType("tools.mcp_tool")
mcp_module.discover_mcp_tools = lambda: []
mcp_module.register_mcp_servers = lambda _configs: []
mcp_module.mcp_prefixed_tool_name = lambda server_name, tool_name: f"mcp__{server_name}__{tool_name}"
mcp_module._run_on_mcp_loop = lambda *_args, **_kwargs: None
mcp_module._servers = {}
mcp_module._lock = threading.RLock()
sys.modules["tools"] = tools_package
sys.modules["tools.mcp_tool"] = mcp_module
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name == "hermes_cli.plugins":
        raise ImportError("portable plugin API unavailable")
    return original_import(name, *args, **kwargs)

builtins.__import__ = guarded_import
try:
    response = server._handle_mcp_action("mcp_list", {}, "default")
finally:
    builtins.__import__ = original_import
print(json.dumps(response))
`)

    expect(result).toEqual({ ok: true, servers: ['legacy'] })
  })
})
