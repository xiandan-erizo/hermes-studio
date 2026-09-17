# MCP Apps interactions

Studio uses `@modelcontextprotocol/ext-apps` as the iframe host. Plugins use the
standard MCP Apps JSON-RPC messages, not Studio-specific events. Internal HTTP
endpoints transport those requests between the browser host and Hermes bridge;
they are not a plugin API.

Supported interactions are `tools/call`, `ui/update-model-context`,
`ui/open-link`, and `ui/request-display-mode`. There is no automatic model turn
on save and no `window.openai` upload shim. A plugin must detect capabilities.

For tool calls, Studio validates the authenticated profile, session operation
permission, and a unique successful persisted source invocation. The bridge
requires a resource declaration on that originating tool and forwards only to
app-visible tools on its own enabled MCP server, respecting configured filters.
This first implementation permits read-only tools and non-destructive local
updates; other mutations are denied by host policy. Tool annotations are taken
from the installed server descriptor, not from the iframe. Plugin servers still
own business authorization, validation, concurrency, and durable data.

Context updates use the official MCP Apps schema. Text (including standard
annotations/metadata) and structured content are supported. Each update replaces
that invocation's previous snapshot. Studio stores at most eight snapshots per
session/profile, at most 8 KiB each, in `mcp_app_context`, with cascade deletion
when its session is removed. The next foreground Hermes turn includes those
snapshots as explicitly untrusted UI data, never as proof of a successful write.
Updating context does not create a chat run or replay a tool action.

The ticket-intake plugin's form and draft capability are business implementation
inside the plugin. Its edit token is returned in tool-result `_meta`; it is never
part of the model context. Receipts and old snapshots without edit authorization
remain read-only. To enable editing, read the existing owned draft and render its
current snapshot; do not create a replacement draft just to enable the UI.

Portable packages may include one internal `hermes-plugin/` native companion.
Marketplace installation validates its standalone manifest, installs and enables
it beside the portable package, records it in the provenance lock, and removes it
with the package while preserving both components' plugin data. This keeps
runtime-specific session and credential access in Hermes' public plugin surface;
Studio does not patch Hermes Agent or add private MCP App messages.

Validation covers real bridge routing, HTTP session isolation, persistent
latest-context replacement, next-turn inclusion, and Chromium iframe save,
conflict, reload and replay flows. The optional bundled widget test accepts
`MCP_APP_VISUAL_WIDGET_PATH`; plugin source is maintained in its separate repo.
