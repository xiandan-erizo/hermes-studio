# Ticket Intake Standard MCP Apps PiP And Mobile Design

## Goal

Make Studio a standard MCP Apps host for Ticket Intake's inline, PiP, and
fullscreen presentation without adding Agent-specific Skill integration or
teaching Studio Ticket Intake business semantics.

## Protocol boundary

The MCP server owns Ticket Intake drafts, versions, authorization, validation,
submission, and receipts. Its render tool declares `_meta.ui.resourceUri` and
returns `text/html;profile=mcp-app`, `structuredContent`, text `content`, and
private `_meta` only.

Studio implements only standard MCP Apps interactions: tool input/result
notifications, `tools/call`, `ui/request-display-mode`,
`ui/update-model-context`, `ui/message`, and `ui/open-link`. Studio does not
parse `draft_id`, merge business objects, or add private MCP messages.

The App resource may request PiP after its first successful draft render. Studio
also chooses PiP as the initial presentation for any App that declares it; this
is a generic Host presentation policy expressed through the standard
`displayMode` host context, not a Ticket Intake branch. The Host remains
authoritative: it may accept PiP, keep the App inline, or present PiP as
fullscreen on a mobile host. The App renders from the actual host context.

## Update model

An active App instance reads server-authoritative state with app-visible tools.
App edits call `tools/call(update_ticket_draft)` and render the returned result.
Agent changes are observed by low-frequency `tools/call(get_ticket_draft)`
polling from the same App instance. Polling pauses while the document is hidden
and runs once immediately after visibility returns. A submitted snapshot changes
the existing view to a receipt. No cross-tool-call iframe replacement or
`draft_id` reconciliation is required.

## Presentation state

Keep host presentation and business presentation separate:

```text
hostDisplayMode: inline | pip | fullscreen
viewKind: summary | details | receipt
requestState: loading | saving | saved | version_conflict
              | authorization_expired | validation_ready
              | submitting | submitted | unknown_result | error
```

Desktop details request fullscreen and return to the previous compact host
mode. On mobile, if PiP is represented as fullscreen, details remain an App
view transition inside that host mode. The iframe and bridge are preserved for
all display mode changes.

## Mobile layout

Mobile uses a single-column summary and details layout. Labels remain above
inputs, long text wraps, attachments stack vertically, and actions use a
safe-area-aware bottom bar. Touch targets are at least 44px. Keyboard display
must not cover the focused field or actions. The UI does not rely on hover or
horizontal scrolling and preserves local edits when a newer server version is
observed.

## State and privacy

The server snapshot is authoritative. The App may retain only ephemeral
presentation state and unsaved form input. Version conflicts retain local input
and require an explicit reload to replace it. Authorization expiry does not
retry writes. `unknown_result` is distinct from submission failure and does not
offer immediate duplicate submission.

The UI never displays or places in model context `draft_id`, internal Assets
keys, SQLite details, validation/idempotency data, reporter lookup details,
session/profile identifiers, MCP tool names, or Jira credentials.

## Compatibility

Clients without MCP Apps support use the text `content` result and remain able
to complete the workflow. Hosts that reject PiP remain inline. Hosts that do
not expose the optional App interactions leave the corresponding controls
disabled while preserving text and tool workflows.
