# MCP Apps interactions

Studio uses `@modelcontextprotocol/ext-apps` as the iframe host. Plugins use the
standard MCP Apps JSON-RPC messages, not Studio-specific events. Internal HTTP
endpoints transport those requests between the browser host and Hermes bridge;
they are not a plugin API.

Supported interactions are `tools/call`, `ui/update-model-context`, `ui/message`,
`ui/open-link`, and `ui/request-display-mode`. Saving state does not start a
model turn; an App may send one bounded user text message from an explicit user
action to continue the conversation. There is no `window.openai` upload shim. A
plugin must detect capabilities.

The Host advertises the standard `inline`, `fullscreen`, and `pip` display modes.
The PIP control is shown only when the App declares `pip` in its own capabilities;
the Host remains the final authority for accepting a mode request. Studio may
choose PIP as the initial presentation for an App that declares it; this is a
host presentation policy using the standard `displayMode` host context, not a
Ticket Intake-specific branch. Apps that do not declare PIP continue to render
inline or fullscreen without a compatibility shim. A mobile host may represent
PIP as fullscreen.

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

`ui/message` accepts one non-empty user-role text block of at most 4096
characters. Studio advertises it only for a persisted source invocation, rejects
inactive-session delivery, and sends the text through the normal chat store.
Apps should update model context first, then send a short trigger message. Ticket
Intake uses this for its explicit Continue action and for a user-clicked
redisplay request after draft edit authorization expires. Save remains local
and does not invoke AI; expiry alone never starts a model turn.

The ticket-intake plugin's form and draft capability are business implementation
inside the plugin. Its edit token is returned in tool-result `_meta`; it is never
part of the model context. Receipts and old snapshots without edit authorization
remain read-only.

Studio projects repeated Ticket Intake render results for one draft into one
App row, preserving its iframe while forwarding the latest successful result.
The plugin's App-only `get_ticket_draft` tool reads newer authoritative draft
versions through standard `tools/call`. Studio does not replay a renderer from
workflow history: that would bypass the renderer's current user authorization
and could make an editable view read-only. Once the plugin reports an expired
edit capability, it stops polling and marks the model context. A subsequent
user action may request one fresh render; the plugin remains the owner of
business state and authorization.

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
