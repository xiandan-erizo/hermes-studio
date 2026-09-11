from __future__ import annotations

import base64
import binascii
import json
import os
import socket
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from bridge_mcp_apps import install_mcp_apps_adapter, resolve_mcp_app_identity
from bridge_pool import AgentPool
from bridge_runtime import (
    _agent_root,
    _apply_profile_env,
    _ensure_agent_imports,
    _hermes_home,
    _install_stop_signal_handlers,
    _jsonable,
    _positive_int,
    _profile_env,
    _profile_home,
    _resolve_runtime,
    _restore_profile_env,
    _start_parent_process_watchdog,
    _worker_profile,
)
from bridge_transport import _make_listen_socket, _read_json_request, _write_json_response

class BridgeServer:
    IDLE_TIMEOUT_SECONDS = 30 * 60  # 30 minutes
    GC_INTERVAL_SECONDS = 60  # check every minute
    MAX_MCP_APP_RESOURCE_BYTES = 1024 * 1024

    def __init__(self, endpoint: str) -> None:
        self.endpoint = endpoint
        self.pool = AgentPool()
        self._stop = threading.Event()
        self._last_gc = time.time()

    def handle(self, req: dict[str, Any]) -> dict[str, Any]:
        action = str(req.get("action") or "").strip()
        if not action:
            raise ValueError("action is required")

        if action == "ping":
            with self.pool._lock:
                sessions = list(self.pool._sessions.values())
            running_sessions = sum(1 for session in sessions if session.running)
            return {
                "pong": True,
                "time": time.time(),
                "pid": os.getpid(),
                "agent_root": str(_agent_root()),
                "profile": _worker_profile() or "default",
                "hermes_home": str(_hermes_home()),
                "session_count": len(sessions),
                "running_session_count": running_sessions,
            }

        if action == "chat":
            session_id = str(req.get("session_id") or "").strip() or uuid.uuid4().hex
            message = req.get("message", req.get("input", ""))
            storage_message = req.get("storage_message")
            instructions = req.get("instructions") or req.get("system_message")
            conversation_history = req.get("conversation_history")
            profile = req.get("profile")
            model = req.get("model")
            provider = req.get("provider")
            workspace = req.get("workspace")
            source = req.get("source")
            raw_background_delegation_enabled = req.get("background_delegation_enabled")
            background_delegation_enabled = (
                raw_background_delegation_enabled
                if isinstance(raw_background_delegation_enabled, bool)
                else None
            )
            # Local patch (reasoning-effort): per-session reasoning effort override (Web UI brain button).
            reasoning_effort = req.get("reasoning_effort")
            record = self.pool.start_chat(
                session_id,
                message,
                storage_message,
                instructions,
                conversation_history,
                profile,
                bool(req.get("force_compress")),
                model,
                provider,
                workspace,
                source,
                reasoning_effort,
                background_delegation_enabled,
            )
            if req.get("wait"):
                timeout = float(req.get("timeout", 0) or 0)
                deadline = time.time() + timeout if timeout > 0 else None
                while record.status == "running":
                    if deadline is not None and time.time() >= deadline:
                        break
                    time.sleep(0.05)
                return self.pool.get_result(record.run_id)
            return {"run_id": record.run_id, "session_id": session_id, "status": record.status}

        if action == "context_estimate":
            session_id = str(req.get("session_id") or "").strip() or uuid.uuid4().hex
            messages = req.get("messages") or req.get("conversation_history") or []
            if not isinstance(messages, list):
                raise ValueError("messages must be a list")
            raw_background_delegation_enabled = req.get("background_delegation_enabled")
            background_delegation_enabled = (
                raw_background_delegation_enabled
                if isinstance(raw_background_delegation_enabled, bool)
                else None
            )
            return self.pool.estimate_context(
                session_id,
                messages=messages,
                instructions=req.get("instructions") or req.get("system_message"),
                profile=req.get("profile"),
                model=req.get("model"),
                provider=req.get("provider"),
                workspace=req.get("workspace"),
                background_delegation_enabled=background_delegation_enabled,
            )

        if action == "provider_credentials":
            requested_provider = str(req.get("provider") or "").strip().lower()
            if not requested_provider:
                raise ValueError("provider is required")
            runtime_provider = "anthropic" if requested_provider == "claude-oauth" else requested_provider
            try:
                if requested_provider == "minimax-oauth":
                    # MiniMax access tokens are short-lived. Its generic
                    # credential-pool row is diagnostic and may still contain
                    # the previous access token, so call Hermes' authoritative
                    # refresh-aware resolver directly.
                    _ensure_agent_imports()
                    from hermes_cli.auth import resolve_minimax_oauth_runtime_credentials

                    credentials = resolve_minimax_oauth_runtime_credentials()
                    runtime = {
                        "provider": requested_provider,
                        "api_mode": "anthropic_messages",
                        "base_url": credentials.get("base_url", ""),
                        "api_key": credentials.get("api_key", ""),
                        "source": credentials.get("source", "oauth"),
                    }
                else:
                    runtime = _resolve_runtime(str(req.get("model") or "").strip(), runtime_provider)
                api_key = runtime.get("api_key")
                if callable(api_key):
                    api_key = api_key()
                token = str(api_key or "").strip()
                if not token:
                    raise RuntimeError(
                        f"Hermes Agent returned no runtime token for {requested_provider}"
                    )
                return {
                    "resolved": True,
                    "requested_provider": requested_provider,
                    "provider": str(runtime.get("provider") or runtime_provider),
                    "api_key": token,
                    "base_url": str(runtime.get("base_url") or "").rstrip("/"),
                    "api_mode": str(runtime.get("api_mode") or ""),
                    "source": str(runtime.get("source") or ""),
                    "last_refresh": runtime.get("last_refresh"),
                    "expires_at": runtime.get("expires_at"),
                    "expires_at_ms": runtime.get("expires_at_ms"),
                }
            except Exception as exc:
                return {
                    "resolved": False,
                    "requested_provider": requested_provider,
                    "error": str(exc),
                    "code": str(getattr(exc, "code", "") or ""),
                    "relogin_required": bool(getattr(exc, "relogin_required", False)),
                }

        if action == "get_result":
            return self.pool.get_result(str(req.get("run_id") or ""))

        if action == "get_output":
            return self.pool.get_output(
                str(req.get("run_id") or ""),
                int(req.get("cursor") or 0),
                int(req.get("event_cursor") or 0),
            )

        if action == "interrupt":
            return self.pool.interrupt(str(req.get("session_id") or ""), req.get("message"))

        if action == "request_boundary_interrupt":
            return self.pool.request_boundary_interrupt(
                str(req.get("session_id") or ""),
                req.get("expected_run_id"),
            )

        if action == "steer":
            text = str(req.get("text") or req.get("message") or "").strip()
            if not text:
                raise ValueError("text is required")
            return self.pool.steer(str(req.get("session_id") or ""), text)

        if action == "approval_respond":
            approval_id = str(req.get("approval_id") or "").strip()
            if not approval_id:
                raise ValueError("approval_id is required")
            return self.pool.respond_approval(approval_id, str(req.get("choice") or "deny"))

        if action == "clarify_respond":
            clarify_id = str(req.get("clarify_id") or "").strip()
            if not clarify_id:
                raise ValueError("clarify_id is required")
            response = str(req.get("response") or "").strip()
            return self.pool.respond_clarify(clarify_id, response)

        if action == "compression_respond":
            request_id = str(req.get("request_id") or "").strip()
            if not request_id:
                raise ValueError("request_id is required")
            messages = req.get("messages")
            if messages is not None and not isinstance(messages, list):
                raise ValueError("messages must be a list")
            return self.pool.respond_compression(
                request_id,
                messages=messages,
                system_message=req.get("system_message"),
                error=req.get("error"),
            )

        if action == "get_history":
            return self.pool.get_history(str(req.get("session_id") or ""))

        if action == "get_session_title":
            return self.pool.get_session_title(
                str(req.get("session_id") or ""),
                req.get("profile"),
            )

        if action == "command":
            session_id = str(req.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            return self.pool.dispatch_command(
                session_id,
                str(req.get("command") or ""),
                req.get("profile"),
            )

        if action == "skills_reload":
            return self._reload_skills(req.get("profile"))

        if action == "switch_session_model":
            session_id = str(req.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            model = str(req.get("model") or "").strip()
            if not model:
                raise ValueError("model is required")
            return self.pool.switch_session_model(
                session_id,
                model,
                str(req.get("provider") or "").strip(),
                req.get("profile"),
            )

        if action == "goal_evaluate":
            session_id = str(req.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            return self.pool.evaluate_goal(
                session_id,
                str(req.get("final_response") or ""),
                req.get("profile"),
            )

        if action == "goal_pause":
            session_id = str(req.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            return self.pool.pause_goal(
                session_id,
                str(req.get("reason") or ""),
                req.get("profile"),
            )

        if action == "status":
            return self.pool.status(str(req.get("session_id") or ""))

        if action == "background_poll":
            session_ids = req.get("session_ids")
            return self.pool.poll_background(session_ids if isinstance(session_ids, list) else None)

        if action == "background_notification_complete":
            delegation_id = str(req.get("delegation_id") or "").strip()
            claim_id = str(req.get("claim_id") or "").strip()
            if not delegation_id or not claim_id:
                raise ValueError("delegation_id and claim_id are required")
            return self.pool.complete_background_notification(delegation_id, claim_id)

        if action == "background_notification_release":
            delegation_id = str(req.get("delegation_id") or "").strip()
            claim_id = str(req.get("claim_id") or "").strip()
            if not delegation_id or not claim_id:
                raise ValueError("delegation_id and claim_id are required")
            return self.pool.release_background_notification(delegation_id, claim_id)

        if action == "destroy":
            return self.pool.destroy(str(req.get("session_id") or ""))

        if action == "destroy_all":
            return self.pool.destroy_all()

        if action == "list":
            return self.pool.list_sessions()

        if action == "shutdown":
            cleanup = self.pool.shutdown()
            cleanup["mcp_servers"] = self._shutdown_all_mcp_servers()
            self._stop.set()
            return {"status": "shutting_down", "cleanup": cleanup}

        # ───── MCP Management (forwarded from broker) ─────
        if action.startswith("mcp_"):
            return self._handle_mcp_action(action, req, req.get("profile"))

        raise ValueError(f"unknown action: {action}")

    # ───── MCP Management Methods (for BridgeServer worker process) ─────

    @staticmethod
    def _mcp_json_object(value: Any) -> dict[str, Any]:
        # The Python MCP SDK represents annotations as a Pydantic model.
        # str(model) is not a valid MCP descriptor for the App SDK handshake.
        if callable(getattr(value, "model_dump", None)):
            value = value.model_dump(mode="json", by_alias=True, exclude_none=True)
        return _jsonable(value) if isinstance(value, dict) else {}

    def _read_mcp_config(self, profile=None):
        """Read config.yaml for the given profile."""
        import yaml
        config_path = _profile_home(profile) / "config.yaml"
        try:
            with open(config_path, encoding="utf-8") as f:
                return yaml.safe_load(f) or {}
        except Exception:
            return {}

    def _save_mcp_config(self, cfg, profile=None):
        """Save config.yaml for the given profile using atomic write."""
        import yaml
        from utils import atomic_yaml_write
        config_path = _profile_home(profile) / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            atomic_yaml_write(config_path, cfg, sort_keys=False)
        except Exception as e:
            raise RuntimeError(f"Failed to save config to {config_path}: {e}")

    @staticmethod
    def _run_mcp_discovery_bg(discover_fn, profile: str | None = None):
        """Run MCP discovery in a background thread to avoid blocking."""
        def _bg():
            original = _apply_profile_env(profile)
            try:
                discover_fn()
            except Exception as e:
                print(f"[mcp-discovery-bg] failed: {e}", file=sys.stderr, flush=True)
            finally:
                _restore_profile_env(original)
        threading.Thread(target=_bg, daemon=True).start()

    def _shutdown_all_mcp_servers(self) -> int:
        try:
            from tools.mcp_tool import _run_on_mcp_loop, _servers, _lock
        except ImportError:
            return 0
        with _lock:
            names = list(_servers.keys())
        return self._shutdown_mcp_servers(names, _servers, _lock, _run_on_mcp_loop)

    def _handle_mcp_action(self, action: str, req: dict[str, Any], profile: str | None = None) -> dict[str, Any]:
        """Handle MCP management actions in worker process."""
        try:
            import tools.mcp_tool as mcp_tool
        except ImportError:
            return {"error": "MCP tool module not available", "ok": False}
        install_mcp_apps_adapter(mcp_tool)
        discover_mcp_tools = mcp_tool.discover_mcp_tools
        mcp_prefixed_tool_name = mcp_tool.mcp_prefixed_tool_name
        register_mcp_servers = mcp_tool.register_mcp_servers
        _run_on_mcp_loop = mcp_tool._run_on_mcp_loop
        _servers = mcp_tool._servers
        _lock = mcp_tool._lock

        if profile is None:
            profile = _worker_profile() or "default"

        if action == "mcp_portable_reload":
            try:
                from hermes_cli.plugins import discover_plugins, get_plugin_manager
                from tools.mcp_tool import _interpolate_env_vars
            except ImportError:
                return {
                    "error": "Portable Agent Plugins are not supported by this Hermes runtime",
                    "ok": False,
                }
            return self._mcp_portable_reload(
                profile,
                _servers,
                _lock,
                _run_on_mcp_loop,
                register_mcp_servers,
                discover_plugins,
                get_plugin_manager,
                _interpolate_env_vars,
            )

        dispatch = {
            "mcp_list":            lambda: self._mcp_list(profile, _servers, _lock),
            "mcp_server_add":      lambda: self._mcp_server_add(req, profile, discover_mcp_tools),
            "mcp_server_update":   lambda: self._mcp_server_update(req, profile, _servers, _lock, _run_on_mcp_loop, discover_mcp_tools),
            "mcp_server_remove":   lambda: self._mcp_server_remove(req, profile, _servers, _lock, _run_on_mcp_loop),
            "mcp_server_test":     lambda: self._mcp_server_test(req, _servers, _lock),
            "mcp_tools_list":      lambda: self._mcp_tools_list(req, profile, _servers, _lock),
            "mcp_app_resolve":     lambda: self._mcp_app_resolve(
                req, profile, _servers, _lock, _run_on_mcp_loop, mcp_prefixed_tool_name
            ),
            "mcp_reload":          lambda: self._mcp_reload(req, profile, _servers, _lock, _run_on_mcp_loop, discover_mcp_tools, register_mcp_servers),
        }
        handler = dispatch.get(action)
        if handler:
            return handler()
        return {"error": f"unknown MCP action: {action}", "ok": False}

    def _reload_skills(self, profile: str | None = None) -> dict[str, Any]:
        resolved_profile = profile or _worker_profile() or "default"
        with _profile_env(resolved_profile):
            from agent.skill_commands import reload_skills

            result = reload_skills()
        return {
            "ok": True,
            "action": "reload-skills",
            **_jsonable(result),
        }

    # ───── MCP sub-handlers ─────

    @staticmethod
    def _mcp_field(value: Any, snake_name: str, camel_name: str | None = None) -> Any:
        if isinstance(value, dict):
            if snake_name in value:
                return value[snake_name]
            return value.get(camel_name) if camel_name else None
        result = getattr(value, snake_name, None)
        if result is None and camel_name:
            result = getattr(value, camel_name, None)
        return result

    def _portable_mcp_server_names(self, profile: str) -> set[str]:
        try:
            with _profile_env(profile):
                from hermes_cli.plugins import get_portable_mcp_server_names_nowait

                return set(get_portable_mcp_server_names_nowait())
        except Exception:
            return set()

    def _profile_mcp_server_names(self, profile: str, config: dict | None = None) -> set[str]:
        resolved = config if isinstance(config, dict) else self._read_mcp_config(profile)
        native = resolved.get("mcp_servers", {}) if isinstance(resolved, dict) else {}
        names = set(native) if isinstance(native, dict) else set()
        names.update(self._portable_mcp_server_names(profile))
        return names

    @staticmethod
    def _mcp_app_resource_uri(meta: Any) -> str | None:
        if not isinstance(meta, dict):
            return None
        ui = meta.get("ui")
        nested = ui.get("resourceUri") if isinstance(ui, dict) else None
        uri = nested if isinstance(nested, str) else meta.get("ui/resourceUri")
        if not isinstance(uri, str) or not uri.startswith("ui://"):
            return None
        return uri

    @staticmethod
    def _is_mcp_app_mime(value: Any) -> bool:
        if not isinstance(value, str):
            return False
        parts = [part.strip().lower() for part in value.split(";") if part.strip()]
        return bool(parts and parts[0] == "text/html" and "profile=mcp-app" in parts[1:])

    def _build_server_entry(self, name: str, cfg: dict, connected: bool = False,
                            tools_count: int = 0, registered_count: int = 0,
                            raw_names: list | None = None, registered_names: list | None = None,
                            tool_details: list | None = None,
                            error: str | None = None) -> dict[str, Any]:
        """Build a normalized server entry dict for API responses."""
        transport = "http" if cfg.get("url") else "stdio"
        return {
            "name": name,
            "transport": transport,
            "connected": connected,
            "tools": tools_count,
            "tools_registered": registered_count,
            "tool_names": raw_names or [],
            "tool_names_registered": registered_names or [],
            "tool_details": tool_details or [],
            "error": error,
            "raw_config": cfg if isinstance(cfg, dict) else {},
        }

    def _mcp_list(self, profile: str, _servers, _lock) -> dict[str, Any]:
        servers = []
        total_tools = 0

        config = self._read_mcp_config(profile)
        mcp_configs = config.get("mcp_servers", {}) or {} if config else {}
        profile_server_names = self._profile_mcp_server_names(profile, config)

        with _lock:
            server_snapshot = list(_servers.items())
        for name, task in server_snapshot:
            if name not in profile_server_names:
                continue
            raw_tool_names = []
            try:
                for mcp_tool in getattr(task, "_tools", []):
                    if hasattr(mcp_tool, "name"):
                        raw_tool_names.append(mcp_tool.name)
            except Exception:
                pass
            registered = list(getattr(task, "_registered_tool_names", None) or [])
            if not registered:
                registered = list(raw_tool_names)
            t = getattr(task, "_task", None)
            connected = bool(t and not t.done())
            err = getattr(task, "_error", None)
            cfg = getattr(task, "_config", {})
            # Build filtered tool_details (name + description) for card display
            srv_cfg = mcp_configs.get(name, {}) if isinstance(mcp_configs.get(name), dict) else {}
            tools_filter = srv_cfg.get("tools") if isinstance(srv_cfg.get("tools"), dict) else {}
            has_include_filter = "include" in tools_filter
            has_exclude_filter = "exclude" in tools_filter
            include_set = set(tools_filter.get("include") or [])
            exclude_set = set(tools_filter.get("exclude") or [])
            tool_details = []
            try:
                for mcp_tool in getattr(task, "_tools", []):
                    tname = getattr(mcp_tool, "name", "?")
                    if has_include_filter and tname not in include_set:
                        continue
                    if has_exclude_filter and tname in exclude_set:
                        continue
                    tool_details.append({
                        "name": tname,
                        "description": getattr(mcp_tool, "description", ""),
                    })
            except Exception:
                pass
            entry = self._build_server_entry(
                name, cfg, connected=connected,
                tools_count=len(raw_tool_names), registered_count=len(registered),
                raw_names=raw_tool_names, registered_names=registered,
                tool_details=tool_details,
                error=str(err) if err else None,
            )
            servers.append(entry)
            total_tools += len(registered)

        # Add servers from config that are not in runtime _servers
        if config:
            existing = {s["name"] for s in servers}
            for name, cfg in mcp_configs.items():
                if name not in existing and isinstance(cfg, dict):
                    servers.append(self._build_server_entry(name, cfg))

        return {"servers": servers, "total_tools": total_tools, "ok": True}

    def _mcp_server_add(self, req: dict, profile: str, discover_mcp_tools) -> dict[str, Any]:
        name = str(req.get("name") or "").strip()
        config = req.get("config", {})
        if not name or not isinstance(config, dict):
            return {"error": "name and config are required", "ok": False}

        cfg = self._read_mcp_config(profile)
        if not cfg:
            return {"error": "config.yaml not found", "ok": False}

        mcp_servers = cfg.setdefault("mcp_servers", {})
        if not isinstance(mcp_servers, dict):
            mcp_servers = {}
            cfg["mcp_servers"] = mcp_servers
        if name in mcp_servers:
            return {"error": f"server '{name}' already exists, use update instead", "ok": False}
        mcp_servers[name] = config

        self._save_mcp_config(cfg, profile)
        self._run_mcp_discovery_bg(discover_mcp_tools, profile)

        return {"ok": True, "name": name}

    @staticmethod
    def _shutdown_mcp_server(name: str, _servers, _lock, run_on_mcp_loop) -> bool:
        with _lock:
            task = _servers.get(name)
        if task is None:
            return False

        try:
            run_on_mcp_loop(lambda: task.shutdown(), timeout=15)
        except Exception as e:
            print(f"[mcp-server-shutdown] failed for {name}: {e}", file=sys.stderr, flush=True)
        finally:
            with _lock:
                if _servers.get(name) is task:
                    _servers.pop(name, None)
        return True

    def _shutdown_mcp_servers(self, names: list[str], _servers, _lock, run_on_mcp_loop) -> int:
        stopped = 0
        for name in names:
            if self._shutdown_mcp_server(name, _servers, _lock, run_on_mcp_loop):
                stopped += 1
        return stopped

    def _mcp_server_update(self, req: dict, profile: str, _servers, _lock, run_on_mcp_loop, discover_mcp_tools) -> dict[str, Any]:
        name = str(req.get("name") or "").strip()
        config = req.get("config", {})
        if not name or not isinstance(config, dict):
            return {"error": "name and config are required", "ok": False}

        cfg = self._read_mcp_config(profile)
        if not cfg:
            return {"error": "config.yaml not found", "ok": False}

        mcp_servers = cfg.setdefault("mcp_servers", {})
        if not isinstance(mcp_servers, dict):
            mcp_servers = {}
            cfg["mcp_servers"] = mcp_servers
        if name not in mcp_servers:
            return {"error": f"server \'{name}\' not found in config", "ok": False}

        mcp_servers[name] = config

        self._save_mcp_config(cfg, profile)

        self._shutdown_mcp_server(name, _servers, _lock, run_on_mcp_loop)

        self._run_mcp_discovery_bg(discover_mcp_tools, profile)

        return {"ok": True}

    def _mcp_server_remove(self, req: dict, profile: str, _servers, _lock, run_on_mcp_loop) -> dict[str, Any]:
        name = str(req.get("name") or "").strip()
        if not name:
            return {"error": "name is required", "ok": False}

        # Write config first, then remove from memory
        cfg = self._read_mcp_config(profile)
        if cfg:
            mcp_servers = cfg.get("mcp_servers", {})
            if isinstance(mcp_servers, dict) and name in mcp_servers:
                del mcp_servers[name]
                self._save_mcp_config(cfg, profile)

        self._shutdown_mcp_server(name, _servers, _lock, run_on_mcp_loop)

        return {"ok": True}

    def _mcp_server_test(self, req: dict, _servers, _lock) -> dict[str, Any]:
        name = str(req.get("name") or "").strip()
        if not name:
            return {"error": "name is required", "ok": False}

        with _lock:
            task = _servers.get(name)
        if not task:
            return {"error": f"server \'{name}\' is not connected", "ok": False}

        tool_names = []
        try:
            for mcp_tool in getattr(task, "_tools", []):
                if hasattr(mcp_tool, "name"):
                    tool_names.append(mcp_tool.name)
        except Exception as e:
            return {"error": f"failed to list tools: {e}", "ok": False}

        return {"ok": True, "tools": tool_names}

    def _mcp_tools_list(self, req: dict, profile: str, _servers, _lock) -> dict[str, Any]:
        server_filter = str(req.get("server") or "").strip() or None
        raw_mode = bool(req.get("raw"))  # Return unfiltered tools for visibility management
        results = []

        config = self._read_mcp_config(profile)
        mcp_configs = config.get("mcp_servers", {}) or {} if config else {}
        profile_server_names = self._profile_mcp_server_names(profile, config)

        with _lock:
            server_snapshot = list(_servers.items())
        for sname, task in server_snapshot:
            if sname not in profile_server_names:
                continue
            if server_filter and sname != server_filter:
                continue
            registered = set(getattr(task, "_registered_tool_names", None) or [])
            tools = []
            srv_cfg = mcp_configs.get(sname, {}) if isinstance(mcp_configs.get(sname), dict) else {}
            tools_filter = srv_cfg.get("tools") if isinstance(srv_cfg.get("tools"), dict) else {}
            has_include_filter = "include" in tools_filter
            has_exclude_filter = "exclude" in tools_filter
            include_set = set(tools_filter.get("include") or [])
            exclude_set = set(tools_filter.get("exclude") or [])
            def _should_include(tn):
                if raw_mode:
                    return True  # Skip filter in raw mode
                if has_include_filter:
                    return tn in include_set
                if has_exclude_filter:
                    return tn not in exclude_set
                return True
            try:
                for mcp_tool in getattr(task, "_tools", []):
                    tname = getattr(mcp_tool, "name", "?")
                    if not _should_include(tname):
                        continue
                    tools.append({
                        "name": tname,
                        "description": getattr(mcp_tool, "description", ""),
                        "input_schema": _jsonable(
                            self._mcp_field(mcp_tool, "input_schema", "inputSchema") or {}
                        ),
                        "output_schema": _jsonable(
                            self._mcp_field(mcp_tool, "output_schema", "outputSchema") or {}
                        ),
                        "annotations": self._mcp_json_object(
                            self._mcp_field(mcp_tool, "annotations") or {}
                        ),
                        "_meta": _jsonable(self._mcp_field(mcp_tool, "meta", "_meta") or {}),
                    })
            except Exception as e:
                results.append({"server": sname, "tools": [], "error": str(e)})
                continue
            results.append({"server": sname, "tools": tools})

        return {"ok": True, "results": results}

    def _mcp_app_resolve(self, req: dict, profile: str, _servers, _lock,
                         run_on_mcp_loop, prefixed_tool_name) -> dict[str, Any]:
        registered_name = str(req.get("tool_name") or "").strip()
        if not registered_name:
            return {"ok": False, "code": "mcp_app_invalid_tool", "error": "tool_name is required"}

        config = self._read_mcp_config(profile)
        mcp_configs = config.get("mcp_servers", {}) or {} if config else {}
        allowed_servers = self._profile_mcp_server_names(profile, config)
        with _lock:
            snapshot = [(name, task) for name, task in _servers.items() if name in allowed_servers]

        for server_name, task in snapshot:
            server_config = mcp_configs.get(server_name, {}) if isinstance(mcp_configs.get(server_name), dict) else {}
            tools_filter = server_config.get("tools") if isinstance(server_config.get("tools"), dict) else {}
            has_include_filter = "include" in tools_filter
            has_exclude_filter = "exclude" in tools_filter
            include_set = set(tools_filter.get("include") or [])
            exclude_set = set(tools_filter.get("exclude") or [])
            for mcp_tool in getattr(task, "_tools", []):
                raw_name = str(getattr(mcp_tool, "name", "") or "")
                if not raw_name or prefixed_tool_name(server_name, raw_name) != registered_name:
                    continue
                if has_include_filter and raw_name not in include_set:
                    continue
                if has_exclude_filter and raw_name in exclude_set:
                    continue
                tool_meta = _jsonable(self._mcp_field(mcp_tool, "meta", "_meta") or {})
                resource_uri = self._mcp_app_resource_uri(tool_meta)
                if not resource_uri:
                    return {
                        "ok": False,
                        "code": "mcp_app_not_found",
                        "error": "The MCP tool does not declare an App resource",
                    }
                session = getattr(task, "session", None)
                if session is None:
                    return {
                        "ok": False,
                        "code": "mcp_app_server_unavailable",
                        "error": "The MCP server is not connected",
                    }

                async def _read_declared_resource():
                    rpc_lock = getattr(task, "_rpc_lock", None)
                    if rpc_lock is None:
                        return await session.read_resource(resource_uri)
                    async with rpc_lock:
                        return await session.read_resource(resource_uri)

                try:
                    read_result = run_on_mcp_loop(_read_declared_resource, timeout=30)
                except Exception as exc:
                    return {
                        "ok": False,
                        "code": "mcp_app_resource_error",
                        "error": f"Failed to read the declared MCP App resource: {exc}",
                    }

                for content in self._mcp_field(read_result, "contents") or []:
                    content_uri = str(self._mcp_field(content, "uri") or "")
                    if content_uri != resource_uri:
                        continue
                    mime_type = self._mcp_field(content, "mime_type", "mimeType")
                    text = self._mcp_field(content, "text")
                    if self._is_mcp_app_mime(mime_type) and not isinstance(text, str):
                        blob = self._mcp_field(content, "blob")
                        if isinstance(blob, str):
                            max_blob_chars = 4 * ((self.MAX_MCP_APP_RESOURCE_BYTES + 2) // 3)
                            if len(blob) > max_blob_chars:
                                return {
                                    "ok": False,
                                    "code": "mcp_app_resource_too_large",
                                    "error": "The MCP App resource exceeds the 1 MiB limit",
                                }
                            try:
                                raw = base64.b64decode(blob, validate=True)
                                if len(raw) > self.MAX_MCP_APP_RESOURCE_BYTES:
                                    return {
                                        "ok": False,
                                        "code": "mcp_app_resource_too_large",
                                        "error": "The MCP App resource exceeds the 1 MiB limit",
                                    }
                                text = raw.decode("utf-8")
                            except (binascii.Error, ValueError, UnicodeDecodeError):
                                text = None
                    if not self._is_mcp_app_mime(mime_type) or not isinstance(text, str):
                        return {
                            "ok": False,
                            "code": "mcp_app_invalid_resource",
                            "error": "The declared resource is not an MCP App HTML document",
                        }
                    if len(text.encode("utf-8")) > self.MAX_MCP_APP_RESOURCE_BYTES:
                        return {
                            "ok": False,
                            "code": "mcp_app_resource_too_large",
                            "error": "The MCP App resource exceeds the 1 MiB limit",
                        }
                    tool = {
                            "name": registered_name,
                            "raw_name": raw_name,
                            "server": server_name,
                            "description": str(getattr(mcp_tool, "description", "") or ""),
                            "input_schema": _jsonable(
                                self._mcp_field(mcp_tool, "input_schema", "inputSchema") or {}
                            ),
                            "output_schema": _jsonable(
                                self._mcp_field(mcp_tool, "output_schema", "outputSchema") or {}
                            ),
                            "annotations": self._mcp_json_object(
                                self._mcp_field(mcp_tool, "annotations") or {}
                            ),
                            "_meta": tool_meta,
                    }
                    title = self._mcp_field(mcp_tool, "title")
                    if isinstance(title, str) and title:
                        tool["title"] = title
                    return {
                        "ok": True,
                        "app": resolve_mcp_app_identity(server_name),
                        "tool": tool,
                        "resource": {
                            "uri": resource_uri,
                            "mimeType": str(mime_type),
                            "text": text,
                            "_meta": _jsonable(self._mcp_field(content, "meta", "_meta") or {}),
                        },
                    }
                return {
                    "ok": False,
                    "code": "mcp_app_invalid_resource",
                    "error": "The MCP server did not return its declared App resource",
                }

        return {
            "ok": False,
            "code": "mcp_app_not_found",
            "error": "No MCP App descriptor was found for this tool",
        }

    def _mcp_portable_reload(self, profile: str, _servers, _lock, run_on_mcp_loop,
                             register_mcp_servers, discover_plugins, get_plugin_manager,
                             interpolate_env_vars=None) -> dict[str, Any]:
        if interpolate_env_vars is None:
            interpolate_env_vars = lambda config: config
        with _profile_env(profile):
            manager = get_plugin_manager()
            old_names = set(manager.get_portable_mcp_servers())
            discover_plugins(force=True)
            configs = {
                name: resolved
                for name, config in get_plugin_manager().get_portable_mcp_servers().items()
                if isinstance((resolved := interpolate_env_vars(config)), dict)
            }

            new_names = set(configs)
            with _lock:
                connected_names = set(_servers)
            replace_names = sorted((old_names | new_names) & connected_names)
            stopped = self._shutdown_mcp_servers(
                replace_names, _servers, _lock, run_on_mcp_loop
            )
            tools = register_mcp_servers(configs) if configs else []
        return {
            "ok": True,
            "stopped": stopped,
            "servers": sorted(new_names),
            "tools": list(tools),
        }

    def _mcp_reload(self, req: dict, profile: str, _servers, _lock, run_on_mcp_loop,
                    discover_mcp_tools, register_mcp_servers) -> dict[str, Any]:
        target = str(req.get("server") or "").strip() or None

        config = self._read_mcp_config(profile)
        mcp_configs = config.get("mcp_servers", {}) or {} if config else {}
        profile_server_names = set(mcp_configs.keys())

        if target and target not in mcp_configs:
            return {"error": "server \'%s\' not found in config" % target, "ok": False}

        if target:
            self._shutdown_mcp_server(target, _servers, _lock, run_on_mcp_loop)
        else:
            self._shutdown_mcp_servers(list(profile_server_names), _servers, _lock, run_on_mcp_loop)

        # Run discovery in background to avoid blocking the request
        if target:
            def _reload_single():
                original = _apply_profile_env(profile)
                try:
                    server_config = {target: mcp_configs.get(target, {})}
                    register_mcp_servers(server_config)
                finally:
                    _restore_profile_env(original)
            self._run_mcp_discovery_bg(_reload_single, profile)
        else:
            self._run_mcp_discovery_bg(discover_mcp_tools, profile)

        return {"ok": True, "message": "MCP servers reloaded"}

    def _make_server_socket(self) -> socket.socket:
        return _make_listen_socket(self.endpoint)

    def _read_request(self, conn: socket.socket) -> dict[str, Any]:
        return _read_json_request(conn)

    def _write_response(self, conn: socket.socket, resp: dict[str, Any]) -> None:
        _write_json_response(conn, resp)

    def _gc_idle_sessions(self) -> None:
        """Destroy sessions idle longer than IDLE_TIMEOUT_SECONDS."""
        now = time.time()
        if now - self._last_gc < self.GC_INTERVAL_SECONDS:
            return
        self._last_gc = now
        with self.pool._lock:
            idle_ids = [
                sid for sid, s in self.pool._sessions.items()
                if not s.running and now - s.last_used_at > self.IDLE_TIMEOUT_SECONDS
            ]
        for sid in idle_ids:
            if self.pool.has_active_background_for_session(sid):
                continue
            self.pool.destroy(sid)

    def serve_forever(self) -> None:
        server = self._make_server_socket()
        restore_signals = _install_stop_signal_handlers(self._stop)
        _start_parent_process_watchdog(
            _positive_int(os.environ.get("HERMES_AGENT_BRIDGE_BROKER_PID")),
            self._stop,
            f"worker:{_worker_profile() or 'default'}",
        )
        try:
            server.listen(16)
            server.settimeout(0.2)
            print(json.dumps({"event": "ready", "endpoint": self.endpoint}), flush=True)

            while not self._stop.is_set():
                conn: socket.socket | None = None
                try:
                    try:
                        conn, _addr = server.accept()
                    except socket.timeout:
                        self._gc_idle_sessions()
                        continue
                    try:
                        req = self._read_request(conn)
                        data = self.handle(req)
                        resp = {"ok": True, **_jsonable(data)}
                    except Exception as exc:
                        resp = {
                            "ok": False,
                            "error": str(exc),
                            "error_type": exc.__class__.__name__,
                        }
                    self._write_response(conn, resp)
                except KeyboardInterrupt:
                    break
                except Exception as exc:
                    print(f"[hermes-bridge] server loop error: {exc}", file=sys.stderr, flush=True)
                finally:
                    if conn is not None:
                        try:
                            conn.close()
                        except OSError:
                            pass
        finally:
            restore_signals()
            server.close()
            if self.endpoint.startswith("ipc://"):
                try:
                    Path(self.endpoint.removeprefix("ipc://")).unlink(missing_ok=True)
                except OSError:
                    pass
