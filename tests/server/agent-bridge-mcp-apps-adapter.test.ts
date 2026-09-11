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
      err.message || 'Python MCP Apps adapter script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

describe('agent bridge MCP Apps protocol adapter', () => {
  it('merges the UI extension into initialize and installs idempotently', () => {
    const result = runPython(String.raw`
import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

path = Path("packages/server/src/modules/hermes/services/bridge/python/bridge_mcp_apps.py")
spec = importlib.util.spec_from_file_location("bridge_mcp_apps_protocol", path)
apps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apps)

sent = []
class ClientSession:
    async def send_request(self, request, *args, **kwargs):
        sent.append(request)
        return {"ok": True}

module = SimpleNamespace(ClientSession=None)
ensured = []
def ensure_mcp_sdk():
    ensured.append(True)
    module.ClientSession = ClientSession
    return True
module._ensure_mcp_sdk = ensure_mcp_sdk
first = apps.install_mcp_apps_adapter(module)
installed_class = module.ClientSession
second = apps.install_mcp_apps_adapter(module)

sampling = {"tools": {"listChanged": True}}
capabilities = {
    "sampling": sampling,
    "extensions": {"com.example/other": {"enabled": True}},
}
initialize = SimpleNamespace(
    root=SimpleNamespace(
        method="initialize",
        params=SimpleNamespace(capabilities=capabilities),
    )
)
ping = SimpleNamespace(root=SimpleNamespace(method="ping", params={}))
session = module.ClientSession()
asyncio.run(session.send_request(initialize))
asyncio.run(session.send_request(ping))

print(json.dumps({
    "first": first,
    "second": second,
    "same_class": installed_class is module.ClientSession,
    "capabilities": capabilities,
    "sampling_same": capabilities["sampling"] is sampling,
    "ping_has_capabilities": hasattr(ping.root.params, "capabilities") if not isinstance(ping.root.params, dict) else "capabilities" in ping.root.params,
    "sent": len(sent),
    "ensured": len(ensured),
}))
`)

    expect(result).toEqual({
      first: true,
      second: true,
      same_class: true,
      capabilities: {
        sampling: { tools: { listChanged: true } },
        extensions: {
          'com.example/other': { enabled: true },
          'io.modelcontextprotocol/ui': {
            mimeTypes: ['text/html;profile=mcp-app'],
          },
        },
      },
      sampling_same: true,
      ping_has_capabilities: false,
      sent: 2,
      ensured: 1,
    })
  })

  it('filters app-only tools only during model registration and tolerates old runtimes', () => {
    const result = runPython(String.raw`
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

path = Path("packages/server/src/modules/hermes/services/bridge/python/bridge_mcp_apps.py")
spec = importlib.util.spec_from_file_location("bridge_mcp_apps_filter", path)
apps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apps)

class ClientSession:
    pass

class Tool:
    def __init__(self, name, meta=None):
        self.name = name
        self.meta = meta

observed = []
raw_task = None
def register(name, task, config):
    observed.append({
        "registration": [tool.name for tool in task._tools],
        "concurrent_raw": [tool.name for tool in raw_task._tools],
    })
    task.registration_note = "forwarded"
    return [tool.name for tool in task._tools]

module = SimpleNamespace(ClientSession=ClientSession, _register_server_tools=register)
apps.install_mcp_apps_adapter(module)
apps.install_mcp_apps_adapter(module)
task = SimpleNamespace(_tools=[
    Tool("app_only", {"ui": {"visibility": ["app"]}}),
    Tool("no_audience", {"ui": {"visibility": []}}),
    Tool("model_only", {"ui": {"visibility": ["model"]}}),
    Tool("both", {"ui": {"resourceUri": "ui://both/view.html"}}),
])
raw_task = task
registered = module._register_server_tools("demo", task, {})
legacy = SimpleNamespace()

print(json.dumps({
    "registered": registered,
    "observed": observed,
    "raw": [tool.name for tool in task._tools],
    "registration_note": task.registration_note,
    "legacy": apps.install_mcp_apps_adapter(legacy),
}))
`)

    expect(result).toEqual({
      registered: ['model_only', 'both'],
      observed: [{
        registration: ['model_only', 'both'],
        concurrent_raw: ['app_only', 'no_audience', 'model_only', 'both'],
      }],
      raw: ['app_only', 'no_audience', 'model_only', 'both'],
      registration_note: 'forwarded',
      legacy: false,
    })
  })

  it('gates the actual lazy cache seam and removes stale all-app-only entries', () => {
    const result = runPython(String.raw`
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

path = Path("packages/server/src/modules/hermes/services/bridge/python/bridge_mcp_apps.py")
spec = importlib.util.spec_from_file_location("bridge_mcp_apps_cache", path)
apps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apps)

cache_entries = {
    "legacy": {"tools": [{"name": "unknown_visibility"}]},
    "all-app": {"tools": [{"name": "previously_cached_app"}]},
}
cleared = []
writes = []
cache_observed = []

def clear_cache_entry(name):
    cleared.append(name)
    cache_entries.pop(name, None)

def write_cache_entry(name, fingerprint, *, tools, utility_tools=None):
    writes.append({"name": name, "tools": tools})

def register_from_cache(name, config, entry):
    names = [tool["name"] for tool in entry.get("tools", [])]
    cache_observed.append(names)
    return names

def register_live(name, task, config):
    return [tool.name for tool in task._tools]

class ClientSession:
    pass

class Tool:
    def __init__(self, name, meta):
        self.name = name
        self.meta = meta

cache = SimpleNamespace(
    clear_cache_entry=clear_cache_entry,
    write_cache_entry=write_cache_entry,
)
module = SimpleNamespace(
    ClientSession=ClientSession,
    _register_server_tools=register_live,
    _register_from_cache_sync=register_from_cache,
)
apps.install_mcp_apps_adapter(module, cache)
apps.install_mcp_apps_adapter(module, cache)

compatible = module._register_from_cache_sync("compatible", {}, {"tools": [
    {"name": "marked", "_hermesStudioModelVisible": True},
    {"name": "model", "_meta": {"ui": {"visibility": ["model"]}}},
    {"name": "app", "_meta": {"ui": {"visibility": ["app"]}}},
    {"name": "nobody", "_meta": {"ui": {"visibility": []}}},
]})

old_error = None
try:
    module._register_from_cache_sync("legacy", {}, cache_entries["legacy"])
except Exception as exc:
    old_error = type(exc).__name__

all_app_task = SimpleNamespace(_tools=[
    Tool("app", {"ui": {"visibility": ["app"]}}),
    Tool("nobody", {"ui": {"visibility": []}}),
])
all_app_registered = module._register_server_tools("all-app", all_app_task, {})

source_tools = [{"name": "fresh-model"}]
cache.write_cache_entry("fresh", "abc", tools=source_tools)

print(json.dumps({
    "compatible": compatible,
    "cache_observed": cache_observed,
    "old_error": old_error,
    "cleared": cleared,
    "all_app_registered": all_app_registered,
    "all_app_raw": [tool.name for tool in all_app_task._tools],
    "old_all_app_remains": "all-app" in cache_entries,
    "writes": writes,
    "source_tools": source_tools,
}))
`)

    expect(result).toEqual({
      compatible: ['marked', 'model'],
      cache_observed: [['marked', 'model']],
      old_error: 'MCPAppsCacheIncompatible',
      cleared: ['legacy', 'all-app'],
      all_app_registered: [],
      all_app_raw: ['app', 'nobody'],
      old_all_app_remains: false,
      writes: [{
        name: 'fresh',
        tools: [{ name: 'fresh-model', _hermesStudioModelVisible: true }],
      }],
      source_tools: [{ name: 'fresh-model' }],
    })
  })

  it('resolves only friendly portable plugin identity with a safe server fallback', () => {
    const result = runPython(String.raw`
import importlib.util
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

path = Path("packages/server/src/modules/hermes/services/bridge/python/bridge_mcp_apps.py")
spec = importlib.util.spec_from_file_location("bridge_mcp_apps_identity", path)
apps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apps)

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    interface_dir = root / ".codex-plugin"
    interface_dir.mkdir()
    (interface_dir / "plugin.json").write_text(json.dumps({
        "name": "ticket-intake",
        "version": "4.0.2",
        "interface": {"displayName": "Ticket Intake"},
        "credentials": {"token": "must-not-leak"},
        "installPath": "/private/plugin/path",
    }), encoding="utf-8")
    manifest = SimpleNamespace(
        name="ticket-intake",
        version="4.0.2",
        path=str(root),
        portable=True,
        skill_namespace="agent-plugin-ticket-intake-deadbeef",
    )
    manager = SimpleNamespace(_plugins={"ticket-intake": SimpleNamespace(manifest=manifest)})
    resolved = apps.resolve_mcp_app_identity(
        "agent-plugin-ticket-intake-deadbeef__ticket-view", manager
    )

print(json.dumps({
    "resolved": resolved,
    "fallback": apps.resolve_mcp_app_identity("weather-server", SimpleNamespace(_plugins={})),
    "unsafe": apps.resolve_mcp_app_identity("../../private/token", SimpleNamespace(_plugins={})),
}))
`)

    expect(result).toEqual({
      resolved: { id: 'ticket-intake', name: 'Ticket Intake', version: '4.0.2' },
      fallback: { id: 'weather-server', name: 'Weather Server' },
      unsafe: { id: 'mcp-app', name: 'MCP App' },
    })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(JSON.stringify(result)).not.toContain('/private/plugin/path')
  })
})
