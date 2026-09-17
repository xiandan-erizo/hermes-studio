# Standard MCP Apps interactions

> Execution: implement the existing approved design in this session. Preserve both repositories' existing WIP; no commits or pushes until requested.

## Approved design

Studio is a generic MCP Apps host. It supports `tools/call` to the resource-owning server and `ui/update-model-context`, without ticket-specific events or fields. Plugin UI owns editable fields; plugin MCP tools own authoritative draft updates. No Jira submission, attachment upload, private UI protocol, or automatic model turn is added.

## Task 1: Host interaction transport

- Bind browser calls to an accessible session and a persisted successful MCP invocation.
- Check originating tool has a UI resource; target tools belong to that same server and allow app visibility. Respect configured include/exclude filters.
- Forward standard arguments and return standard CallToolResult. Reject browser-supplied transport metadata. Do not route UI calls through a shell.
- Retain latest model context per invocation, bounded in size, and include as untrusted context on the next user turn. Context updates never start a run.
- Add client handlers and advertise only implemented capabilities. Preserve previous error-code fix.
- Verify isolation, disabled/hidden/cross-server tools, missing invocation, errors, latest-context replacement, and no automatic run with focused tests.

## Task 2: ticket-intake plugin

- Add a details form for textual business evidence: title, description, actual/expected behavior, impact, environment, module, and attachment notes. Identity resolution, customer Assets changes, priority escalation, and Jira submission stay in the existing Skill workflow.
- Add app-visible read/update draft MCP tools. Authorize edits with an opaque, unguessable draft-scoped capability issued only when the render input matches an actual owned stored draft. Capability must survive MCP restart, reject tampering, bind owner and draft, and expire. Never trust browser owner/path values. Keep capability out of model-visible structuredContent; return in result _meta.
- Reuse the existing Python TicketTool and its owner/version/lock/validation invalidation logic. No second draft store or direct JSON rewrite.
- Old/fabricated render snapshots remain viewable but do not get editing capability. Expose useful failure messages; version conflict must preserve unsaved input and offer reload. Receipt stays read-only.
- Save updates the card and sends minimal standard model context (draft id/version and safe business data), without launching a new conversation turn.
- Bump plugin to 4.1.0; regenerate bundles and marketplaces. Tests include tampered capability, stale version, unauthorized fields, restart reuse, read-only receipts, and real browser save.

## Task 3: Verify and deploy

- Run scoped host/bridge tests, browser interaction tests, harness, build, and plugin gen/check.
- Review the combined changes against standard MCP Apps and authorization boundaries.
- Back up runtime artifacts, synchronize only changed plugin/runtime assets, restart Studio only, verify health and resolved resource. Do not create/submit live Jira issues or alter user drafts for smoke tests.

## Progress

- Initial investigation: SDK supports both handlers; existing host only advertises openLinks. Draft runtime already has locked optimistic versioned updates.
- Ruling: draft capability is plugin business authorization, carried using ordinary tool arguments and result _meta. It adds no host protocol method. Host still validates session ownership independently.
- Tasks 1 and 2 implemented. Source authorization tests, real socket routing tests, HTTP ownership tests, latest-context persistence and next-turn injection tests pass. UI saves use button RPC, preserving the sandbox's no-form-submission policy.
- Independent plugin and host reviews completed; Unicode limits, controlled errors, token renewal/replay, disabled-server context checks and standard text-block metadata compatibility were corrected and re-reviewed.
- Validation: host production build and harness pass; 87 focused host tests and 9 Chromium tests pass. Plugin full check passed 59 tests before the final targeted replay correction; all 7 edit test groups and generation passed after it.
- Runtime smoke exposed SDK object serialization; the bridge now reuses its Pydantic-aware JSON serializer. The real installed Python MCP SDK regression and the dependency-free fixture both pass.
- Task 3 complete: installed ticket-intake is 4.1.0, source/runtime bundle hashes match, Studio health is ready, live resource includes the editor, and the live App tool path returns a standard isError result for an invalid capability. Only Studio was restarted. No live draft was edited and no Jira request was made. Work remains uncommitted.
