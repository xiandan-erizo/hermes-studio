# Ticket Intake Standard PiP And Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the current Studio MCP App host complete the standard display-mode lifecycle and verify the standard polling, conflict, and mobile behavior without Agent-specific Skill code.

**Architecture:** Keep MCP Apps protocol handling generic in `McpAppResultCard.vue`. The host will preserve one AppBridge/iframe across display-mode transitions, expose the standard display modes, and use the actual host reply for mobile degradation. App-side polling remains a standard `tools/call` concern; Studio will only provide the bridge and visibility-safe lifecycle needed by the App.

**Tech Stack:** Vue 3 Composition API, `@modelcontextprotocol/ext-apps` `AppBridge`, Vitest, Playwright, SCSS.

**Spec:** `docs/superpowers/specs/2026-09-23-ticket-intake-standard-pip-mobile-design.md`

## Global Constraints

- Do not modify `/root/code/hose-skills`, Agent Skills, or Agent-specific workflow instructions.
- Do not add private MCP JSON-RPC methods or parse Ticket Intake business identifiers in Studio.
- Preserve unrelated dirty work already present in the checkout.
- Keep iframe and AppBridge identity stable while changing display modes.
- Use standard `tools/call`, `ui/request-display-mode`, `ui/update-model-context`, `ui/message`, and `ui/open-link` only.
- Add user-facing strings to every locale file if new visible copy is introduced.

### Task 1: Make display mode state reversible and mobile-safe

**Files:**
- Modify: `packages/client/src/components/hermes/chat/McpAppResultCard.vue`
- Test: `tests/e2e/mcp-app-result.spec.ts`

**Interfaces:**
- `setDisplayMode(mode: McpUiDisplayMode)` continues to return the actual accepted mode.
- Add `compactDisplayMode: Ref<McpUiDisplayMode>` and `viewKind: Ref<'summary' | 'details' | 'receipt'>` only if needed to preserve the mode before fullscreen.
- `hostContext()` must report the actual host mode and measured dimensions on desktop and narrow viewports.

- [ ] **Step 1: Add a failing Playwright assertion for returning from fullscreen to PiP.**

Extend the existing App result flow: enter PiP, enter fullscreen, press Escape, and assert the App returns to `pip` and the same inner document instance remains.

- [ ] **Step 2: Run the focused E2E test and verify it fails.**

Run: `npm run test:e2e -- tests/e2e/mcp-app-result.spec.ts -g "returns to PiP"`

Expected: FAIL because the current cancel handler always returns to `inline`.

- [ ] **Step 3: Implement reversible display mode handling.**

Record the current compact mode before entering fullscreen. On cancel or collapse, restore that mode when the host still accepts it; otherwise use `inline`. Keep the native dialog and existing iframe instead of remounting it. Keep the current capability checks as the final authority.

- [ ] **Step 4: Add narrow viewport assertions.**

Use the existing 390x844 fixture to assert the PiP frame stays within the viewport, the frame has no horizontal overflow, and fullscreen can be opened without changing the inner document identity.

- [ ] **Step 5: Run focused E2E and client checks.**

Run: `npm run test:e2e -- tests/e2e/mcp-app-result.spec.ts`

Run: `npm run test -- tests/client/mcp-app-message.test.ts tests/client/mcp-app-result.test.ts`

Expected: PASS.

### Task 2: Document and verify the standard App update lifecycle

**Files:**
- Modify: `docs/mcp-app-interactions.md`
- Modify: `tests/e2e/mcp-app-result.spec.ts`

**Interfaces:**
- Documentation must state that Studio does not merge `draft_id` or provide cross-tool-call broadcasting.
- The bundled test App uses standard `tools/call` polling and updates from the returned `structuredContent` without remounting.

- [ ] **Step 1: Add a failing fixture assertion for an App tool result updating in place.**

Extend the App fixture with a standard `tools/call` request and respond through the existing mocked call endpoint. Assert the rendered heading changes, the inner `data-instance` stays unchanged, and no second `.mcp-app-result` appears.

- [ ] **Step 2: Run the focused test to verify the missing assertion exposes the gap.**

Run: `npm run test:e2e -- tests/e2e/mcp-app-result.spec.ts -g "updates in place"`

Expected: FAIL until the fixture and host assertions are wired.

- [ ] **Step 3: Update the MCP Apps documentation.**

Describe the initial render, App-owned standard polling through `tools/call`, visibility pause/resume, and the fact that `draft_id` reconciliation is intentionally outside Studio's standard host contract.

- [ ] **Step 4: Implement the minimal fixture behavior and assertions.**

Use the existing `callMcpAppTool` route and `toolresult` event. Do not add a Studio-private message or Ticket Intake-specific branch.

- [ ] **Step 5: Run focused E2E and docs harness checks.**

Run: `npm run test:e2e -- tests/e2e/mcp-app-result.spec.ts`

Run: `npm run harness:check`

Expected: PASS.

### Task 3: Validate failure and mobile state guarantees

**Files:**
- Modify: `tests/e2e/mcp-app-result.spec.ts`
- Modify: `tests/client/mcp-app-message.test.ts` only if source contract assertions need updating

**Interfaces:**
- Conflict, authorization expiry, unknown submission result, text fallback, and unsupported PiP remain observable through the existing App result contract.

- [ ] **Step 1: Add focused browser assertions.**

Cover unsupported PiP returning inline, hidden-document polling pause followed by one visibility-triggered read, preservation of an unsaved field during a newer result, and receipt rendering without a duplicate App card.

- [ ] **Step 2: Run the focused browser tests.**

Run: `npm run test:e2e -- tests/e2e/mcp-app-result.spec.ts`

Expected: PASS.

- [ ] **Step 3: Run build validation.**

Run: `npm run build`

Expected: PASS with no TypeScript or bundle errors.

- [ ] **Step 4: Review the final diff.**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; unrelated pre-existing WIP remains visible and untouched.
