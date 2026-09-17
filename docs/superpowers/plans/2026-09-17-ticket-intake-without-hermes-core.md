# Ticket Intake Without Hermes Core Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve authenticated session-scoped Ticket Intake and MCP App editing without modifying Hermes Agent core.

**Architecture:** Move the model-facing workflow into a native companion Hermes plugin that reads request-scoped session context and Jira credentials. Keep the portable MCP server limited to standard MCP App rendering and edit-token-based local updates, with Studio retaining host-side interaction authorization.

**Tech Stack:** Python Hermes plugin API, Node.js MCP SDK, Python TicketTool runtime, SQLite, Vue 3, Koa, Vitest, Playwright, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-17-ticket-intake-without-hermes-core-design.md`

## Global Constraints

- `/root/code/hermes-agent` must finish identical to `origin/main` with no untracked files.
- Do not expose `JIRA_PAT` in MCP environment, arguments, results, metadata, logs, or model context.
- Preserve all existing ticket drafts, submission records, plugin data, and Studio sessions.
- Browser interactions remain standard MCP Apps messages; no custom iframe protocol.
- No live Jira submission during tests or deployment smoke checks.
- Existing WIP snapshots in each repository must remain available until completion.

---

### Task 1: Add the native workflow companion contract

**Files:**
- Create: `/root/code/hose-skills/plugins/ticket-intake/hermes-plugin/plugin.yaml`
- Create: `/root/code/hose-skills/plugins/ticket-intake/hermes-plugin/__init__.py`
- Create: `/root/code/hose-skills/scripts/tests/test_ticket_intake_runtime_plugin.py`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/mcp/workflow_bridge.py`

**Interfaces:**
- Produces native tool `ticket_intake_workflow(args: object) -> JSON string`.
- Produces `pre_tool_call` modification for the installed Ticket Intake render tool, overwriting `_hostContext.sessionId`.
- Consumes Hermes `get_session_env("HERMES_SESSION_ID")`, `HERMES_WEB_UI_HOME`, `HERMES_WEB_UI_URL`, active profile, `JIRA_PAT`, and the portable plugin-data directory.

- [ ] Write tests that load the native plugin with a fake `PluginContext`, verify tool/hook registration, reject missing session identity, and prove caller-supplied host context is overwritten.
- [ ] Run `python -m unittest scripts/tests/test_ticket_intake_runtime_plugin.py -v` and confirm failure because the plugin does not exist.
- [ ] Implement the minimal native plugin and a callable workflow bridge entry point.
- [ ] Re-run the focused Python test and confirm it passes.

### Task 2: Make the MCP App presentation-only

**Files:**
- Modify: `/root/code/hose-skills/plugins/ticket-intake/mcp/src/server.mjs`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/mcp/src/workflow-context.mjs`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/.codex-plugin/plugin.json`
- Modify: `/root/code/hose-skills/scripts/tests/ticket-intake-workflow.test.mjs`
- Modify: `/root/code/hose-skills/scripts/tests/ticket-intake-edit.test.mjs`

**Interfaces:**
- Removes MCP tool `ticket_intake_workflow` and manifest extension `ai.hermes/session-context`.
- `render_ticket_card` accepts a reserved `_hostContext` object and grants edit authority only after Studio identity verification.
- App-visible `get_ticket_draft` and `update_ticket_draft` continue using opaque `editToken`.

- [ ] Add failing tests proving workflow is absent from MCP discovery, forged/missing host context cannot grant editing, and hook-injected valid context can.
- [ ] Run the focused Node tests and verify the expected failures.
- [ ] Remove the workflow MCP tool and session-context extension; adapt render authorization to validated host context.
- [ ] Regenerate `mcp/server.cjs` and card assets using the repository generator.
- [ ] Run the focused Node tests and confirm they pass.

### Task 3: Update the Ticket Intake skill and packaging

**Files:**
- Modify: `/root/code/hose-skills/plugins/ticket-intake/skills/ticket-intake/SKILL.md`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/skills/ticket-intake/README.md`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/skills/ticket-intake/references/tool-contract.md`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/plugin.json`
- Modify: `/root/code/hose-skills/.claude-plugin/marketplace.json`
- Test: `/root/code/hose-skills/scripts/tests/ticket-intake-mcp-app.test.mjs`

**Interfaces:**
- Skill calls native `ticket_intake_workflow`, then MCP `render_ticket_card`.
- Packaging declares portable and native companion versions together and documents fail-closed behavior.

- [ ] Run existing contract/generation tests before editing and capture the failures caused by the new runtime/MCP split.
- [ ] Update the skill, reference contract, plugin metadata, and marketplace entries with the exact tool sequence and no legacy JSON fallback.
- [ ] Run the skill/package checks and confirm generated files are current.

### Task 4: Keep Studio generic and activate both components

**Files:**
- Modify only if required: `/root/code/hermes-studio/packages/server/src/modules/hermes/services/plugins/*`
- Modify: `/root/code/hermes-studio/docs/mcp-app-interactions.md`
- Test: `/root/code/hermes-studio/tests/server/mcp-app-interaction*.test.ts`
- Test: `/root/code/hermes-studio/tests/e2e/mcp-app-result.spec.ts`

**Interfaces:**
- Studio continues authorizing App RPC with persisted invocation evidence.
- Activation installs/enables the native companion without adding ticket-specific iframe events or routes.

- [ ] Add a failing activation test only if current plugin activation does not support installing the companion atomically.
- [ ] Implement the smallest generic activation/configuration change needed; otherwise leave production Studio code unchanged.
- [ ] Run focused Studio server and Playwright tests.

### Task 5: Restore and verify upstream Hermes Agent

**Files:**
- Restore: `/root/code/hermes-agent` tracked files and local commit to `origin/main`.

**Interfaces:**
- Consumes only Hermes' existing native `register_tool`, `register_hook`, `pre_tool_call modify`, request-scoped session context, and portable Agent Plugin MCP loader.

- [ ] Confirm the WIP stash hash is present.
- [ ] Restore the working tree and branch to `origin/main` without deleting the stash.
- [ ] Run existing Hermes plugin-hook and MCP tests on unmodified upstream.
- [ ] Verify `git status --short` and `git diff origin/main` are empty.

### Task 6: End-to-end verification and deployment

**Files:**
- Runtime install: `/root/.hermes/plugins/ticket-intake`
- Runtime install: `/root/.hermes/plugins/ticket-intake-runtime`

**Interfaces:**
- Installed versions match source versions.
- Studio starts the unchanged Hermes Agent checkout and resolves the Ticket Intake App resource.

- [ ] Run `npm run check` and TicketTool Python tests in `hose-skills`.
- [ ] Run Studio `harness:check`, focused Vitest, Playwright MCP App tests, and production build.
- [ ] Install both plugin components while preserving live config and data; restart Studio-related services only.
- [ ] Verify service health, App resource resolution, ordinary-user card rendering, draft edit/reload, and cross-session denial without submitting Jira.
