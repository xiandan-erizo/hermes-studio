# MCP App Plugin Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the private HTML result envelope with portable Agent Plugin packaging and standard MCP Apps rendering in Hermes Studio.

**Architecture:** `ticket-intake` supplies a read-only MCP render tool and versioned UI resource. The Studio Hermes bridge resolves only the resource declared by a completed tool descriptor, while the browser hosts it with the official MCP Apps `AppBridge`. Marketplace installation copies and enables complete portable packages while retaining legacy skill-only behavior.

**Tech Stack:** Agent Plugins v1 JSON manifests, MCP TypeScript SDK 2.0, MCP Apps SDK 2.0, Node.js/esbuild, Python Hermes bridge, TypeScript/Koa, Vue 3, Vitest, Playwright, Node test runner.

**Spec:** `docs/design/mcp-app-plugin-results.md`

## Global Constraints

- Do not add a ticket-specific branch to Hermes Agent or Studio.
- Do not emit or accept the private `_ui` envelope.
- Keep ticket submission authorization and state in the existing Python runtime.
- App resource lookup must be authenticated, profile-scoped, descriptor-bound, MIME-limited, and size-limited.
- Advertise no MCP Apps capability that Studio does not implement.
- Preserve existing uncommitted ticket workflow optimizations.

---

### Task 1: Portable ticket plugin and MCP App

**Files:**
- Create: `/root/code/hose-skills/plugins/ticket-intake/plugin.json`
- Create: `/root/code/hose-skills/plugins/ticket-intake/mcp.json`
- Create: `/root/code/hose-skills/plugins/ticket-intake/mcp/src/server.mjs`
- Create: `/root/code/hose-skills/plugins/ticket-intake/mcp/src/ticket-view.mjs`
- Create: `/root/code/hose-skills/plugins/ticket-intake/mcp/src/widget.mjs`
- Create: `/root/code/hose-skills/scripts/build-ticket-intake-mcp.mjs`
- Create: `/root/code/hose-skills/scripts/tests/ticket-intake-mcp-app.test.mjs`
- Modify: `/root/code/hose-skills/package.json`
- Modify: `/root/code/hose-skills/scripts/lib/skill-repository.mjs`
- Modify: `/root/code/hose-skills/scripts/tests/skill-repository.test.mjs`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/.codex-plugin/plugin.json`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/skills/ticket-intake/SKILL.md`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/skills/ticket-intake/create-ticket/INSTRUCTIONS.md`
- Modify: `/root/code/hose-skills/plugins/ticket-intake/skills/ticket-intake/create-ticket/scripts/run.py`
- Delete: `/root/code/hose-skills/plugins/ticket-intake/skills/ticket-intake/create-ticket/scripts/ticket_runtime/html_ui.py`
- Delete: `/root/code/hose-skills/plugins/ticket-intake/skills/ticket-intake/create-ticket/tests/test_html_ui.py`
- Delete: `/root/code/hose-skills/plugins/ticket-intake/skills/ticket-intake/references/html-tool-result.md`

**Interfaces:**
- Produces: MCP tool `render_ticket_card({ action, result })` and resource `ui://ticket-intake/ticket-card-v1.html`.
- Produces: text `content` plus sanitized ticket-card `structuredContent`.

- [x] Write Node tests for draft/receipt sanitization, fallback text, unsafe links, descriptor metadata, resource MIME, and manifest preference.
- [x] Run the focused tests and verify failures identify the missing portable package and render tool.
- [x] Implement the portable manifests, server, view-model sanitizer, widget, and build script.
- [x] Remove `_ui` generation from the Python runner and update skill instructions to call `render_ticket_card` after eligible results.
- [x] Build committed runtime artifacts and run the focused Node and Python ticket tests.

### Task 2: Descriptor-bound MCP App bridge

**Files:**
- Modify: `packages/server/src/modules/hermes/services/bridge/python/bridge_server.py`
- Modify: `packages/server/src/modules/hermes/services/bridge/client.ts`
- Modify: `packages/server/src/modules/hermes/services/mcp/bridge-actions.ts`
- Modify: `packages/server/src/modules/hermes/controllers/mcp.ts`
- Modify: `packages/server/src/modules/hermes/routes/mcp.ts`
- Modify: `packages/server/src/bootstrap/routes.ts`
- Modify: `packages/client/src/api/hermes/mcp.ts`
- Modify: `tests/server/agent-bridge-mcp-tools-filter.test.ts`
- Modify: `tests/server/bridge-mcp-action.test.ts`
- Modify: `tests/server/mcp-controller.test.ts`

**Interfaces:**
- Produces: `POST /api/hermes/mcp/apps/resolve` with `{ toolName }`.
- Returns: declared `resourceUri`, MCP Apps HTML, resource UI metadata, and raw tool descriptor fields needed by the host.

- [x] Write failing bridge and controller tests for metadata forwarding, portable-server visibility, descriptor-bound reads, invalid MIME, oversized HTML, and ordinary authenticated routing.
- [x] Run focused tests and verify the expected missing-action failures.
- [x] Implement the Python resolver, TypeScript bridge method, controller, and protected route.
- [x] Run the focused server tests and bridge Python integration test.

### Task 3: Studio MCP Apps host

**Files:**
- Create: `packages/client/src/utils/hermes/mcp-app-result.ts`
- Create: `packages/client/src/components/hermes/chat/McpAppResultCard.vue`
- Modify: `packages/client/src/stores/hermes/chat.ts`
- Modify: `packages/client/src/components/hermes/chat/MessageList.vue`
- Modify: `packages/client/src/components/hermes/chat/HistoryMessageList.vue`
- Modify: `package.json`
- Modify: `package-lock.json`
- Replace: `tests/client/tool-html-result.test.ts` with `tests/client/mcp-app-result.test.ts`
- Replace: `tests/e2e/plugin-html-result.spec.ts` with `tests/e2e/mcp-app-result.spec.ts`
- Delete: `packages/client/src/utils/hermes/tool-html-result.ts`
- Delete: `packages/client/src/components/hermes/chat/ToolHtmlResultCard.vue`
- Delete: `docs/plugin-html-results.md`
- Delete: `tests/fixtures/ticket-intake-html-result.json`

**Interfaces:**
- Consumes: the descriptor-bound resolve endpoint from Task 2.
- Produces: isolated MCP Apps iframe rows for live and persisted completed tool calls.

- [x] Write failing parser tests for MCP result normalization and candidate projection, plus browser coverage for the SDK handshake, resize, safe links, hidden technical traces, replay, and sandbox isolation.
- [x] Install the pinned MCP Apps SDK and verify tests still fail only for missing host behavior.
- [x] Implement the result normalizer, CSP builder, Vue card, and live/history projection.
- [x] Remove the private `_ui` renderer and its `HtmlFilePreview` coupling.
- [x] Run focused client tests and Playwright coverage.

### Task 4: Whole-plugin Marketplace installation

**Files:**
- Modify: `packages/server/src/modules/hermes/services/marketplace/repo-scanner.ts`
- Modify: `packages/server/src/modules/hermes/services/marketplace/install.ts`
- Modify: `packages/server/src/modules/hermes/controllers/marketplace.ts`
- Modify: `packages/client/src/api/hermes/marketplace.ts`
- Modify: `packages/client/src/views/hermes/MarketplaceView.vue`
- Modify: `tests/server/marketplace.test.ts`

**Interfaces:**
- Produces: catalog field `portable`, lock field `installKind`, whole-package install/update/uninstall, and profile plugin enablement.
- Preserves: legacy skill install API and lock compatibility.

- [x] Write failing tests for canonical manifest preference, complete package copying, source conflicts, legacy migration, profile enable/disable, update hashing, and preserved plugin data.
- [x] Run focused Marketplace tests and verify expected failures.
- [x] Implement scanner overlay behavior and transactional portable package installation.
- [x] Update the Marketplace UI to expose one install action per portable plugin while retaining per-skill actions for legacy packages.
- [x] Run Marketplace server/client tests.

### Task 5: End-to-end validation

**Files:**
- Modify generated marketplace manifests through `npm run gen` only.

**Interfaces:**
- Validates the package from Marketplace source through Hermes MCP discovery to Studio iframe rendering.

- [x] Run `/root/code/hose-skills` generation, structure checks, representative ticket tests, and inspect generated diffs.
- [x] Run focused Studio unit/server tests, `npm run harness:check`, `npm run build`, and MCP Apps Playwright tests.
- [x] Install the local portable plugin into the test Hermes profile, enable it, restart only the Studio development runtime, and call the render tool through the real bridge.
- [x] Verify the browser widget on desktop and mobile, including nonblank pixels, sandbox attributes, hidden tool traces, and text fallback.
- [x] Review all three repository diffs for unrelated changes and report commit state without committing unless requested.

## Validation Notes

- `hose-skills`: `npm run check` passed (44 Node tests, structure validation, Pages build); 140 Python create-ticket tests passed.
- `hermes-studio`: focused Vitest passed (73 tests), MCP Apps Playwright passed (3 tests), and `npm run build` passed.
- Full Studio coverage completed with 4,924 passed, 6 skipped, and 5 pre-existing failures in session summary, Ekko recovery, and `ExternalIdentitiesView` RTL checks.
- Full Studio Playwright completed with 144 passed and 3 pre-existing auth fixture failures caused by an unmocked `/api/auth/sso/status` request.
- `npm run harness:check` remains blocked by four pre-existing module-boundary violations in `sources-store.ts` and `external-identities.ts`; none is modified by this change.
