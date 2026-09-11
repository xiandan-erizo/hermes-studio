# MCP App Plugin Results

## Goal

Render rich plugin results in Hermes Studio through the portable Agent Plugin
and MCP Apps contracts. Plugin business tools remain usable in clients without
MCP Apps support through normal text results.

## Boundaries

- A plugin owns its skills, MCP server, render tools, and versioned `ui://`
  resources.
- Hermes owns MCP connections and forwards standard tool descriptors, tool
  results, and declared resources. It does not know ticket-specific fields.
- Studio is an MCP Apps host. It resolves only the UI resource declared by the
  completed tool and renders it in a sandboxed iframe.
- The Marketplace installs the whole portable plugin package. Legacy packages
  without a root `plugin.json` keep their existing skill-only installation.

## Plugin Contract

`ticket-intake` uses the portable package layout:

```text
plugins/ticket-intake/
  plugin.json
  mcp.json
  .codex-plugin/plugin.json
  mcp/server.cjs
  assets/ticket-card.html
  skills/ticket-intake/...
```

The read-only `render_ticket_card` MCP tool accepts an already returned ticket
result. It validates and allowlists business fields, then returns:

- textual `content` for every MCP client;
- sanitized `structuredContent` for the view;
- no Jira reads or writes and no authorization decisions.

Its descriptor declares `_meta.ui.resourceUri` for a versioned MCP App resource.
The skill invokes the render tool only for a prepared draft or confirmed Jira
receipt. Existing prepare, validation, confirmation, submission, identity, and
ownership behavior stays unchanged.

## Hermes Bridge Contract

Studio's profile worker resolves an app from the completed registered MCP tool
name. The worker:

1. finds the raw tool descriptor in the same connected MCP server;
2. accepts only `ui://` URIs declared by `_meta.ui.resourceUri` (or the legacy
   MCP Apps alias);
3. reads that exact resource through the existing MCP session;
4. accepts only `text/html;profile=mcp-app`, applies size limits, and returns
   the resource text and UI metadata.

There is no arbitrary URI read endpoint. Resolution remains scoped to the
requesting profile's bridge worker and configured or enabled portable servers.

## Studio Host Contract

Completed MCP tool messages with a standard result or a Hermes text result produce a presentation row
that remains visible when technical tool traces are hidden. The row asks the
authenticated, profile-scoped server endpoint to resolve the tool's declared
resource.

Live delivery, reconnect replay, and history snapshots preserve complete MCP
result envelopes up to 256 KiB of UTF-8 JSON, including
their text fallback and `_meta`. Ordinary tool previews retain the 1000-character
limit. Larger MCP results fall back to a text preview so a partially truncated
view model is never rendered as a complete App. Persisted results remain intact.

The host connects to a different-origin sandbox proxy before navigating its
outer iframe. After `sandbox-proxy-ready` it sends the declared resource; the
proxy applies resource CSP in HTTP headers and a restricted inner document.
Input and result follow the View's initialized notification. Moving a chat row
may recreate its iframe window, in which case the host reconnects. Initialized
resources receive a teardown request before replacement; controlled replacement
waits up to 800 ms, and Vue/page unmount sends teardown on a best-effort basis.
If initialization does not finish within 12 seconds, the host displays the text
fallback and a retry control instead of leaving an empty frame. Retrying reloads
the declared resource; it does not invoke the tool or repeat business actions.

Studio uses `@modelcontextprotocol/ext-apps` `AppBridge` and
`PostMessageTransport`. It sends the original tool arguments followed by a
standard `CallToolResult`. The first version advertises only:

- external HTTP/HTTPS links through a host-validated `ui/open-link` handler;
- inline/fullscreen display, theme variables, locale, timezone, and measured resize context.

It does not advertise app-initiated tool calls, messages, model-context updates,
sampling, downloads, camera, microphone, geolocation, or clipboard access.
The different-origin proxy has `sandbox="allow-scripts allow-same-origin"`; the
inner View has only `allow-scripts`. The proxy validates message source windows
and parent origin and forwards protocol IDs unchanged. Display mode switches use
the native dialog top layer and retain the existing iframe document.

### Sandbox deployment

Set `HERMES_MCP_APP_SANDBOX_ORIGIN` to a dedicated HTTP(S) origin, for example
`https://views.example.com`. HTTPS hosts require an HTTPS sandbox. Route only
`/api/studio/mcp-apps/sandbox` on that origin to Studio's backend; do not expose
the Studio UI or authenticated API routes on the sandbox hostname. The endpoint
serves a public bootstrap with no credentials or business data; the host sends
the declared HTML after the proxy is ready. The parent and resource-domain
parameters are validated, and the CSP response restricts the frame ancestors.

Local loopback development defaults to the alternative `localhost`/`127.0.0.1`
hostname on the browser-facing port. Hosted deployments without an isolated
origin use the existing text/error fallback; they never load a same-origin proxy.

## Marketplace Contract

The catalog prefers the root portable `plugin.json` as package identity and
uses `.codex-plugin/plugin.json` only as an interface compatibility overlay.
Portable installation copies the complete plugin into the selected profile's
`plugins/` directory, records provenance and a content hash, enables the plugin
in that profile, and leaves `plugin-data/` untouched on uninstall. Existing
skill-only installs and lock entries remain readable and updatable.

## Compatibility

- MCP Apps hosts render the widget.
- MCP clients without Apps support receive the text result.
- Skill-only clients can still execute the existing ticket workflow; the rich
  view is an optional final presentation call.
- No custom `_ui` result envelope is accepted or emitted.
