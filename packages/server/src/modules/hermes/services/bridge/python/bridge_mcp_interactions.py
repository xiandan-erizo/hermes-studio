"""Host-side routing for standard MCP Apps tools/call requests."""
import json


def call_app_tool(server, req, profile, servers, lock, run, prefix, jsonable):
    def failure(code, message):
        return {"ok": False, "code": code, "error": message}

    origin = req.get("tool_name")
    target = req.get("name")
    arguments = req.get("arguments", {})
    if not isinstance(target, str) or not target or len(target) > 256 or not isinstance(arguments, dict):
        return failure("mcp_app_invalid_tool", "Invalid App tool call")
    if len(json.dumps(arguments, ensure_ascii=False).encode()) > 262144:
        return failure("mcp_app_invalid_tool", "App arguments exceed 256 KiB")
    config = server._read_mcp_config(profile) or {}
    allowed = server._profile_mcp_server_names(profile, config)
    with lock:
        candidates = [(name, task) for name, task in servers.items() if name in allowed]
    for name, task in candidates:
        configured = (config.get("mcp_servers") or {}).get(name, getattr(task, "_config", {})) or {}
        if configured.get("enabled") is False:
            continue
        filters = configured.get("tools") or {}

        def enabled(raw):
            return server._mcp_tool_enabled(raw, filters)

        tools = getattr(task, "_tools", [])
        source = next((t for t in tools if prefix(name, server._mcp_field(t, "name")) == origin and enabled(server._mcp_field(t, "name"))), None)
        if source is None:
            continue
        source_meta = jsonable(server._mcp_field(source, "meta", "_meta") or {})
        if not server._mcp_app_resource_uri(source_meta):
            return failure("mcp_app_not_found", "The originating tool does not declare an App resource")
        tool = next((t for t in tools if server._mcp_field(t, "name") == target and enabled(target)), None)
        if tool is None:
            return failure("mcp_app_tool_forbidden", "Tool is not available to this App")
        meta = jsonable(server._mcp_field(tool, "meta", "_meta") or {})
        ui = meta.get("ui") or {}
        annotations = server._mcp_json_object(server._mcp_field(tool, "annotations") or {})
        if "app" not in ui.get("visibility", ["model", "app"]):
            return failure("mcp_app_tool_forbidden", "Tool is not visible to Apps")
        if not (annotations.get("readOnlyHint") is True or (
            annotations.get("destructiveHint") is False and annotations.get("openWorldHint") is False
        )):
            return failure("mcp_app_tool_forbidden", "This host permits read-only tools and non-destructive local updates from Apps")
        session = getattr(task, "session", None)
        if session is None:
            return failure("mcp_app_server_unavailable", "The MCP server is not connected")

        async def execute():
            rpc_lock = getattr(task, "_rpc_lock", None)
            if rpc_lock is None:
                return await session.call_tool(target, arguments=arguments)
            async with rpc_lock:
                return await session.call_tool(target, arguments=arguments)

        # Forward only standard arguments; browser transport metadata is never trusted.
        try:
            result = server._mcp_json_object(run(execute, timeout=60))
            if not isinstance(result, dict) or not isinstance(result.get("content"), list):
                return failure("mcp_app_invalid_result", "Invalid MCP tool result")
            if len(json.dumps(result).encode()) > 2 * 1024 * 1024:
                return failure("mcp_app_invalid_result", "MCP tool result is too large")
            return {"ok": True, "result": result}
        except Exception:
            # Provider errors may include credentials. Do not expose them to the iframe.
            return failure("mcp_app_tool_error", "The App tool call failed; read the current state before retrying")
    return failure("mcp_app_not_found", "App is not available in this profile")
