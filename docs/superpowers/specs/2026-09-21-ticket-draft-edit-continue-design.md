# Ticket Draft Default Editing And Continue Design

## Goal

Make an owned, unsubmitted Ticket Intake draft editable whenever its MCP App is
rendered, save edits without an AI turn, and use the standard MCP Apps
`ui/message` request to start one AI turn only when the user chooses to continue
the submission workflow.

## User Experience

- A current user's `kind=draft` card exposes editable evidence fields in its
  details view without asking for an internal token or special chat command.
- `保存草稿` persists changes and updates model context but does not run AI.
- `继续提交` persists pending changes, updates model context, then sends one
  short user-role message asking the Agent to read the current draft and perform
  pre-submit validation. It never submits Jira directly.
- Jira receipts, drafts not owned by the current user/session, stale or invalid
  invocations, and failed authorization remain read-only.

## Protocol Boundary

Use only stable MCP Apps protocol methods:

- `tools/call` for local get/update draft tools;
- `ui/update-model-context` for the latest draft version and summary;
- `ui/message` for the explicit user-initiated continuation turn;
- existing `ui/request-display-mode` and `ui/open-link` behavior unchanged.

Studio advertises the standard `message` capability only for a persisted source
invocation that is already eligible for App interactions. The Host accepts only
one bounded text block with role `user`, and only while the invocation's session
is the active session. The App cannot choose another session or profile.

## Authorization

The existing edit capability remains an implementation detail in tool-result
`_meta`; it is not shown to users or sent to the model. Draft authorization uses
the signed Studio identity and current stored draft. Public workflow snapshots
may omit `tenant_id` and `user_id`; if those fields are present they must match
the trusted owner. Forged owner, stale version, receipt, or missing draft fails
closed.

## Data Flow

1. An eligible workflow result is rendered as an MCP App.
2. The App receives its internal editing capability and loads the latest draft.
3. User edits fields locally.
4. `保存草稿` calls `update_ticket_draft`, then replaces the invocation's model
   context snapshot. No chat run starts.
5. `继续提交` performs step 4 if needed, updates context with the latest version,
   then calls `ui/message` with a short continuation request.
6. Studio validates the current invocation and active session, appends the user
   message, and starts the normal Hermes turn.
7. Hermes reads the server-authoritative current draft and continues identity,
   missing-field, Jira dry-run, confirmation, and approval steps.

## Failure Behavior

- Save failure: preserve inputs, show the actionable error, do not send a
  message.
- Missing `ui/message`: keep saving available and report that continuation must
  happen in chat.
- Message rejection or session switch: keep saved draft and show a retryable
  continuation error.
- Concurrent version update: preserve local input and require reload; never
  overwrite silently.
- The App never calls Jira submit and never claims submission success.

## Acceptance Criteria

- New owned draft cards expose editing without user-supplied parameters.
- Save changes draft state and context but produces no AI/user chat message.
- Continue sends exactly one bounded user message after a successful save.
- Host rejects malformed, non-user, multi-block, oversized, inactive-session,
  or unbound App messages.
- Receipts and unauthorized cards remain read-only.
- Existing MCP App isolation, editing, conflict, build, and browser tests pass.
