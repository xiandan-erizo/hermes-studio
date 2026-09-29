# Ticket Draft Default Editing And Continue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make owned ticket drafts editable by default and trigger one AI turn only from the explicit Continue action.

**Architecture:** Keep draft writes behind existing MCP App invocation and plugin authorization. Add standard `ui/message` handling to Studio, and have the Ticket Intake App save, update context, then send a bounded continuation message.

**Tech Stack:** Vue 3, Pinia, TypeScript, MCP Apps `App`/`AppBridge`, Node test runner, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-ticket-draft-edit-continue-design.md`

## Global Constraints

- Use standard MCP Apps methods only; no custom iframe messages or `window.openai` shim.
- Do not expose edit capabilities in model context or user-visible content.
- Save never starts AI; Continue starts at most one turn after save succeeds.
- No Jira write is performed by the App.
- Preserve existing cross-user/session isolation and stale-version checks.

### Task 1: Studio `ui/message` Host Support

**Files:**
- Create: `/root/code/hermes-studio/packages/client/src/utils/hermes/mcp-app-message.ts`
- Create: `/root/code/hermes-studio/tests/client/mcp-app-message.test.ts`
- Modify: `/root/code/hermes-studio/packages/client/src/components/hermes/chat/McpAppResultCard.vue`

**Interfaces:**
- `mcpAppUserMessage(params: unknown) -> string | null` accepts one non-empty user text block of at most 4096 characters.
- AppBridge advertises `message.text` only for a bound invocation and sends through `chatStore.sendMessage` only when that session remains active.

- [x] Write failing validation tests for valid text and malformed/oversized requests.
- [x] Implement the validator and host handler.
- [x] Run the focused client tests.

### Task 2: Ticket App Save And Continue

**Files:**
- Modify: `/root/code/hose-skills/plugins/ticket-intake/mcp/src/widget.mjs`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/mcp/src/widget.html`
- Modify: `/root/code/hose-skills/scripts/tests/ticket-intake-edit.test.mjs`
- Regenerate: `/root/code/hose-skills/plugins/ticket-intake/mcp/server.cjs`

**Interfaces:**
- `saveDraft() -> Promise<boolean>` returns true only when current state is safely persisted or already clean.
- `continueSubmission()` saves, updates context, and sends one standard user message.

- [x] Add failing widget contract tests for the Continue button and standard protocol calls.
- [x] Implement save return status and Continue behavior.
- [x] Rebuild the MCP App bundle and run Ticket Intake tests.

### Task 3: Documentation And End-to-End Verification

**Files:**
- Modify: `/root/code/hermes-studio/docs/mcp-app-interactions.md`
- Test: `/root/code/hermes-studio/tests/e2e/mcp-app-result.spec.ts`

**Interfaces:**
- Browser fixture verifies default draft editing, save without a chat run, and Continue producing one user turn.

- [x] Update protocol documentation for `ui/message` and save/continue semantics.
- [x] Add/extend the Playwright fixture and assertions.
- [x] Run focused Vitest, Playwright, Studio build/harness, hose-skills check, and visual desktop/mobile smoke.
