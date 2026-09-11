from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"
MCP_APP_UI_EXTENSION = "io.modelcontextprotocol/ui"
_ADAPTER_MARKER = "_hermes_studio_mcp_apps_adapter"
_CACHE_MODEL_VISIBLE_MARKER = "_hermesStudioModelVisible"
_MAX_INTERFACE_MANIFEST_BYTES = 256 * 1024
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$")


def _field(value: Any, snake_name: str, camel_name: str | None = None) -> Any:
    if isinstance(value, Mapping):
        if snake_name in value:
            return value[snake_name]
        return value.get(camel_name) if camel_name else None
    result = getattr(value, snake_name, None)
    if result is None and camel_name:
        result = getattr(value, camel_name, None)
    return result


def _set_field(value: Any, name: str, field_value: Any) -> bool:
    try:
        if isinstance(value, dict):
            value[name] = field_value
        else:
            setattr(value, name, field_value)
        return True
    except (AttributeError, TypeError, ValueError):
        return False


def _merge_ui_extension(request: Any) -> None:
    root = _field(request, "root") or request
    if _field(root, "method") != "initialize":
        return
    params = _field(root, "params")
    capabilities = _field(params, "capabilities")
    if capabilities is None:
        return

    existing_extensions = _field(capabilities, "extensions")
    extensions = dict(existing_extensions) if isinstance(existing_extensions, Mapping) else {}
    existing_ui = extensions.get(MCP_APP_UI_EXTENSION)
    ui = dict(existing_ui) if isinstance(existing_ui, Mapping) else {}
    existing_mime_types = ui.get("mimeTypes")
    mime_types = (
        [item for item in existing_mime_types if isinstance(item, str)]
        if isinstance(existing_mime_types, (list, tuple))
        else []
    )
    if MCP_APP_MIME_TYPE not in mime_types:
        mime_types.append(MCP_APP_MIME_TYPE)
    ui["mimeTypes"] = mime_types
    extensions[MCP_APP_UI_EXTENSION] = ui
    _set_field(capabilities, "extensions", extensions)


def _is_model_visible_tool(tool: Any) -> bool:
    meta = _field(tool, "meta", "_meta")
    ui = _field(meta, "ui")
    visibility = _field(ui, "visibility")
    if not isinstance(visibility, (list, tuple, set)):
        return True
    targets = {str(item).strip().lower() for item in visibility}
    return "model" in targets


def _cached_model_visibility(tool: Any) -> tuple[bool, bool]:
    if not isinstance(tool, Mapping):
        return False, False
    meta = _field(tool, "meta", "_meta")
    ui = _field(meta, "ui")
    if isinstance(ui, Mapping) and "visibility" in ui:
        visibility = ui.get("visibility")
        if not isinstance(visibility, (list, tuple, set)):
            return False, False
        targets = {str(item).strip().lower() for item in visibility}
        return True, "model" in targets
    if tool.get(_CACHE_MODEL_VISIBLE_MARKER) is True:
        return True, True
    return False, False


class _ModelRegistrationView:
    __slots__ = ("_target", "_tools")

    def __init__(self, target: Any, tools: list[Any]) -> None:
        object.__setattr__(self, "_target", target)
        object.__setattr__(self, "_tools", tools)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in {"_target", "_tools"}:
            object.__setattr__(self, name, value)
        else:
            setattr(self._target, name, value)


class MCPAppsCacheIncompatible(RuntimeError):
    pass


def install_mcp_apps_adapter(mcp_tool_module: Any, schema_cache_module: Any = None) -> bool:
    """Install Studio-only MCP Apps behavior on Hermes' imported MCP seam."""

    installed = False
    cache_module = schema_cache_module
    if cache_module is None:
        try:
            import tools.mcp_schema_cache as cache_module
        except Exception:
            cache_module = None

    clear_cache_entry = getattr(cache_module, "clear_cache_entry", None)

    def clear_server_cache(name: str) -> None:
        if callable(clear_cache_entry):
            try:
                clear_cache_entry(name)
            except Exception:
                pass

    client_session = getattr(mcp_tool_module, "ClientSession", None)
    ensure_sdk = getattr(mcp_tool_module, "_ensure_mcp_sdk", None)
    if client_session is None and callable(ensure_sdk):
        try:
            ensure_sdk()
        except Exception:
            pass
        client_session = getattr(mcp_tool_module, "ClientSession", None)
    if isinstance(client_session, type):
        if not getattr(client_session, _ADAPTER_MARKER, False):
            original_session = client_session

            class StudioMCPAppsClientSession(original_session):
                async def send_request(self, request: Any, *args: Any, **kwargs: Any) -> Any:
                    _merge_ui_extension(request)
                    return await super().send_request(request, *args, **kwargs)

            StudioMCPAppsClientSession.__name__ = original_session.__name__
            StudioMCPAppsClientSession.__qualname__ = original_session.__qualname__
            setattr(StudioMCPAppsClientSession, _ADAPTER_MARKER, True)
            mcp_tool_module.ClientSession = StudioMCPAppsClientSession
        installed = True

    register = getattr(mcp_tool_module, "_register_server_tools", None)
    if callable(register):
        if not getattr(register, _ADAPTER_MARKER, False):
            original_register = register

            def register_model_visible_tools(name: str, server: Any, config: dict) -> Any:
                raw_tools = list(getattr(server, "_tools", []) or [])
                visible_tools = [tool for tool in raw_tools if _is_model_visible_tool(tool)]
                if len(visible_tools) == len(raw_tools):
                    return original_register(name, server, config)
                clear_server_cache(name)
                return original_register(
                    name,
                    _ModelRegistrationView(server, visible_tools),
                    config,
                )

            setattr(register_model_visible_tools, _ADAPTER_MARKER, True)
            mcp_tool_module._register_server_tools = register_model_visible_tools
        installed = True

    register_cached = getattr(mcp_tool_module, "_register_from_cache_sync", None)
    if callable(register_cached):
        if not getattr(register_cached, _ADAPTER_MARKER, False):
            original_register_cached = register_cached

            def register_compatible_cached_tools(name: str, config: dict, entry: dict) -> Any:
                cached_tools = entry.get("tools") if isinstance(entry, Mapping) else None
                if not isinstance(cached_tools, list) or not cached_tools:
                    return original_register_cached(name, config, entry)
                visible_tools = []
                for tool in cached_tools:
                    if not isinstance(tool, Mapping) or not tool.get("name"):
                        continue
                    known, model_visible = _cached_model_visibility(tool)
                    if not known:
                        clear_server_cache(name)
                        raise MCPAppsCacheIncompatible(
                            f"MCP schema cache for {name!r} has no Studio model-visibility marker"
                        )
                    if model_visible:
                        visible_tools.append(tool)
                compatible_entry = dict(entry)
                compatible_entry["tools"] = visible_tools
                return original_register_cached(name, config, compatible_entry)

            setattr(register_compatible_cached_tools, _ADAPTER_MARKER, True)
            mcp_tool_module._register_from_cache_sync = register_compatible_cached_tools
        installed = True

    write_cache = getattr(cache_module, "write_cache_entry", None)
    if callable(write_cache):
        if not getattr(write_cache, _ADAPTER_MARKER, False):
            original_write_cache = write_cache

            def write_compatible_cache(*args: Any, **kwargs: Any) -> Any:
                tools = kwargs.get("tools")
                if isinstance(tools, list):
                    marked_tools = []
                    for tool in tools:
                        if isinstance(tool, Mapping):
                            marked = dict(tool)
                            marked[_CACHE_MODEL_VISIBLE_MARKER] = True
                            marked_tools.append(marked)
                        else:
                            marked_tools.append(tool)
                    kwargs["tools"] = marked_tools
                return original_write_cache(*args, **kwargs)

            setattr(write_compatible_cache, _ADAPTER_MARKER, True)
            cache_module.write_cache_entry = write_compatible_cache
        installed = True

    return installed


def _identity_text(value: Any, max_length: int = 128) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = " ".join(value.split()).strip()
    if not cleaned or any(ord(char) < 32 for char in cleaned):
        return ""
    return cleaned[:max_length]


def _portable_display_name(manifest: Any) -> str:
    raw_path = getattr(manifest, "path", None)
    if not isinstance(raw_path, str) or not raw_path:
        return ""
    interface_path = Path(raw_path) / ".codex-plugin" / "plugin.json"
    try:
        with interface_path.open("rb") as handle:
            raw = handle.read(_MAX_INTERFACE_MANIFEST_BYTES + 1)
        if len(raw) > _MAX_INTERFACE_MANIFEST_BYTES:
            return ""
        payload = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return ""
    interface = payload.get("interface") if isinstance(payload, dict) else None
    if not isinstance(interface, dict):
        return ""
    return _identity_text(interface.get("displayName"))


def _friendly_name(identifier: str) -> str:
    words = re.sub(r"[._-]+", " ", identifier).strip()
    return " ".join(word[:1].upper() + word[1:] for word in words.split())


def _fallback_identity(server_name: str) -> dict[str, str]:
    candidate = server_name.strip()
    if any(separator in candidate for separator in ("/", "\\", ":")):
        return {"id": "mcp-app", "name": "MCP App"}
    candidate = candidate.rsplit("__", 1)[-1]
    if not _SAFE_ID_RE.fullmatch(candidate):
        return {"id": "mcp-app", "name": "MCP App"}
    return {"id": candidate, "name": _friendly_name(candidate) or "MCP App"}


def resolve_mcp_app_identity(server_name: str, plugin_manager: Any = None) -> dict[str, str]:
    """Resolve public app identity without exposing plugin paths or config."""

    manager = plugin_manager
    if manager is None:
        try:
            from hermes_cli.plugins import get_plugin_manager

            manager = get_plugin_manager()
        except Exception:
            manager = None

    loaded_plugins = getattr(manager, "_plugins", {}) if manager is not None else {}
    values = loaded_plugins.values() if isinstance(loaded_plugins, Mapping) else ()
    for loaded in values:
        manifest = getattr(loaded, "manifest", None)
        if manifest is None or not bool(getattr(manifest, "portable", False)):
            continue
        namespace = _identity_text(getattr(manifest, "skill_namespace", None))
        if not namespace or not (
            server_name == namespace or server_name.startswith(f"{namespace}__")
        ):
            continue
        plugin_id = _identity_text(getattr(manifest, "name", None))
        if not _SAFE_ID_RE.fullmatch(plugin_id):
            break
        identity = {
            "id": plugin_id,
            "name": _portable_display_name(manifest) or _friendly_name(plugin_id),
        }
        version = _identity_text(getattr(manifest, "version", None), max_length=64)
        if _SAFE_VERSION_RE.fullmatch(version):
            identity["version"] = version
        return identity

    return _fallback_identity(server_name)
