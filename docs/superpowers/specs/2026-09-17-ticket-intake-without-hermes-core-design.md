# Ticket Intake Without Hermes Core Changes

## Goal

Keep `/root/code/hermes-agent` byte-for-byte aligned with its upstream branch while
retaining authenticated, session-isolated ticket drafts and standard MCP Apps UI
interactions in Hermes Studio.

## Boundaries

- Hermes Agent core remains unmodified. Integration uses its public native plugin
  tool and lifecycle-hook APIs.
- Studio owns authenticated users, sessions, profile access, model-run tokens,
  uploaded assets, MCP App host authorization, and UI context persistence.
- Ticket Intake owns Jira workflow policy, draft versioning, idempotency, business
  validation, and plugin-private state.
- The MCP server owns `ui://` resources, card rendering, and app-visible draft
  read/update tools. It does not receive Jira credentials.
- The iframe uses standard MCP Apps methods only: `tools/call`,
  `ui/update-model-context`, `ui/open-link`, and display-mode requests.

## Architecture

Ticket Intake ships two coordinated Hermes extensions.

The portable Agent Plugin continues to expose the skill and MCP App server. The
MCP server is reduced to presentation and draft editing: `render_ticket_card`,
`get_ticket_draft`, `update_ticket_draft`, and the ticket `ui://` resource.

A companion native Hermes plugin registers the model-facing
`ticket_intake_workflow` tool. Because native handlers execute in the Agent
process, they can read Hermes' request-scoped session context and the configured
Jira credential without forwarding either into an MCP subprocess. The native
plugin calls the existing workflow bridge and stores bindings under the same
profile-local plugin-data state root.

The companion also registers a narrowly scoped `pre_tool_call` hook for
`render_ticket_card`. The hook overwrites a reserved host-context argument with
the current session ID. The render MCP handler treats model input as untrusted,
resolves identity through Studio's restricted per-session JWT, and grants an edit
token only when the stored draft owner matches. A caller-supplied value can never
win over the hook.

Studio already binds each App interaction to the authenticated user, profile,
session, one persisted successful source invocation, and the originating MCP
server. App-visible get/update calls therefore continue through the standard MCP
Apps bridge using only the opaque edit token returned in tool-result `_meta`.

## Packaging

The native companion is packaged as the internal
`ticket-intake/hermes-plugin/` runtime asset and installed as a separate Hermes
plugin directory because portable Agent Plugins intentionally do not import
arbitrary Python. Its implementation locates the matching portable plugin and
profile-local `PLUGIN_DATA` explicitly. The portable and companion versions must
match, and either component fails closed when the other is unavailable. It is not
published as a second Marketplace Skill or independently installable product.

Studio's plugin activation path installs and enables both components together.
No Hermes source file, built-in manifest parser, MCP client, or environment
allowlist is changed.

## State And Credentials

Draft bodies and session bindings remain in Ticket Intake plugin state, keyed by
storage identity, profile, tenant, authenticated Studio user, and Studio session.
Existing legacy draft compatibility remains read-only unless a binding already
points at legacy storage.

`JIRA_PAT` stays in the native Hermes process and is passed only to the immediate
workflow bridge child. It is never included in MCP arguments, tool results, App
metadata, Studio model context, or the MCP server environment.

The MCP server receives only its standard `PLUGIN_ROOT` and `PLUGIN_DATA` values.
Static Studio connection information needed for identity verification is written
as a restricted plugin-data configuration by the Studio activation path; the
per-session bearer token remains a restricted Studio-owned file.

## Failure Behavior

- Missing companion plugin: the workflow tool is absent; the skill reports an
  installation/configuration error and does not create a draft.
- Missing or forged session binding: workflow and edit authorization fail closed.
- Missing Studio identity or token: no owner authority or Jira operation is
  granted; historical cards remain readable.
- Missing MCP server: workflow state remains intact and the model receives a
  render failure without retrying a mutation.
- Stale edit token/version: preserve unsaved browser input and require reload.

## Migration

1. Add and test the companion native plugin while the existing MCP workflow tool
   remains available only in test fixtures.
2. Switch the skill to the companion tool and remove the workflow tool plus
   Hermes session-context extension from the portable MCP package.
3. Preserve existing draft/state files; no schema rewrite is required.
4. Restore `/root/code/hermes-agent` to `origin/main` after retaining the existing
   WIP stash and verify the feature against the unmodified runtime.
5. Deploy Studio and both Ticket Intake components together, then smoke test with
   a draft-only request. Do not submit Jira during deployment verification.

## Acceptance Criteria

- `git status` and `git diff origin/main` are clean in Hermes Agent.
- A normal Studio user can prepare, render, reopen, and edit a draft in one
  session without exposing it to another user, profile, or session.
- Jira dry-run/submit paths can access `JIRA_PAT` only through the native tool.
- The MCP subprocess environment and request metadata contain no Jira credential.
- Existing Studio MCP Apps interaction, sandbox, build, and harness tests pass.
- Ticket Intake Node and Python suites pass against the unmodified Hermes Agent.
