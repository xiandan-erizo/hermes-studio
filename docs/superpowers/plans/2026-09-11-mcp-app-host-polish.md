# MCP Apps Host Compliance and Presentation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded implementation tasks, with independent review. Preserve the existing working changes; do not commit or publish them automatically.

**Goal:** Correct the identified MCP Apps protocol gaps and deliver a compact, polished ticket card with real expanded presentation.

**Architecture:** Keep the existing MCP resources, AppBridge, Hermes runtime, and ticket business workflow. Use a distinct-origin sandbox proxy, explicit lifecycle and capabilities, and host-provided presentation context. No new ticket write tools are included in this change.

**Tech Stack:** Vue 3, TypeScript, Koa, Python Hermes bridge, MCP Apps 2.0.0 / protocol 2026-01-26, Vitest, Playwright.

**Spec:** /root/.codex/visualizations/2026/09/11/01a08f56-e392-7750-ba14-0fc7febeb7bf/chatgpt-plugin-ui-research.md (protocol corrections and display stages).

## Global Constraints

- Preserve current uncommitted changes in Studio and hose-skills.
- Keep the ticket workflow read-only from the UI; do not introduce Jira submissions or UI-to-model messages.
- Use standard resource metadata and JSON-RPC; declare only supported capabilities.
- A web sandbox proxy must have a different origin from Studio and use allow-scripts and allow-same-origin. Inner content remains restricted by sandbox and resource CSP.
- Complete initialized before delivering input/result; send resource-teardown before replacing or closing an initialized resource, with a bounded wait.
- Keep profile isolation and existing runtime trust gates. Do not edit the upstream Hermes checkout or installed Python SDK.
- Use Studio theme variables, localized host strings, a real inline/fullscreen transition, and a responsive neutral visual design.
- Keep original tool records unchanged. Loading, expanding, reconnecting, or retrying UI must not rerun ticket business actions.

## Task 1: Hermes MCP Apps protocol adapter

**Files:** Python bridge runtime/server, a focused bridge_mcp_apps.py helper if needed; tests/server/agent-bridge-mcp-tools-filter.test.ts and a new focused protocol adapter test.

**Interfaces:** Produces standard MCP Apps client extension negotiation for Studio-owned MCP sessions. Resolve may add app: { id: string, name: string, version?: string } and tool.title?: string; existing response fields remain compatible. Resource text may be decoded from valid UTF-8 base64 blob.

- [x] Write failing behavior checks for UI extension capability merging, idempotent installation, model-only filtering of app-only tools, and resource decoding/identity.

```python
assert initialize_payload["params"]["capabilities"]["extensions"]["io.modelcontextprotocol/ui"] == {
    "mimeTypes": ["text/html;profile=mcp-app"]
}
assert initialize_payload["params"]["capabilities"]["sampling"] == original_sampling
```

- [x] Implement a Studio-local adapter at the existing runtime import/discovery seam. Patch only the Studio worker's MCP client behavior, retain normal initialized handling and unrelated capabilities, and keep app-only tools out of model tool registration without dropping them from the raw server resource/call registry.
- [x] Resolve friendly application identity from the installed/discovered plugin manifest/interface, with a safe server-name fallback. Never return raw config, credentials, or paths as identity.
- [x] Run targeted Python-through-Vitest tests; record red/green evidence and inspect changes.

## Task 2: Cross-origin sandbox and host lifecycle

**Files:** Studio public sandbox route/controller/service, bootstrap/routes.ts; client utils/hermes/mcp-app-sandbox.ts; McpAppResultCard.vue; client API type; tests/client/mcp-app-result.test.ts; tests/server/mcp-app-sandbox.test.ts; tests/e2e/mcp-app-result.spec.ts.

**Interfaces:** Public /api/studio/mcp-apps/sandbox serves only a static proxy with CSP derived from validated resource-domain parameters. Resolve response may include sandboxOrigin from HERMES_MCP_APP_SANDBOX_ORIGIN. Loopback development can use the alternate localhost/127.0.0.1 hostname at the same browser-facing port. Hosted deployment configures a dedicated origin; never fall back to a same-origin proxy.

- [x] Add failing tests for origin rejection, CSP source validation, content-only MCP results, and nested iframe lifecycle.

```ts
expect(includeMcpAppResults([contentOnlyTool])).toHaveLength(2)
expect(() => buildSandboxUrl('https://studio.example', 'https://studio.example', {})).toThrow()
await expect(card.frameLocator('iframe').frameLocator('iframe').getByRole('heading')).toBeVisible()
```

- [x] Implement public proxy: accept messages only from the expected parent or the one current view; forward JSON-RPC without changing IDs; reserve sandbox notifications; enforce resource CSP through response headers and the child document; prevent duplicate resource loads.
- [x] Connect AppBridge to proxy before navigation, wait for sandboxready, send resource, and deliver input/result after initialized. Use bounded graceful teardown on replacement/unmount. Preserve generation guards and reconnect recovery.
- [x] Accept completed content-only results as candidates; resolve decides whether a registered UI exists. Non-App tools remain hidden with their ordinary tool traces.
- [x] Verify isolated browser contexts, blocked network access, unchanged business call count on retry, and graceful teardown.

## Task 3: Studio visual surface and display modes

**Files:** McpAppResultCard.vue; a scoped host-context utility if helpful; all client locale files; e2e test.

**Interfaces:** Standard hostContext styles/theme/locale/actual dimensions, availableDisplayModes inline/fullscreen. App capability declarations govern whether expansion is offered. Standard ui/request-display-mode replies with actual mode and setHostContext notifies changes.

- [x] Add behavior checks for fullscreen mode delivery, unchanged inner document identity, content preservation on close, focus restoration, and mobile width.

```ts
await expand.click()
await expect(widget).toHaveAttribute('data-display-mode', 'fullscreen')
await close.click()
await expect(widget).toHaveAttribute('data-display-mode', 'inline')
expect(await widget.evaluate(node => node.dataset.instance)).toBe(originalInstance)
```

- [x] Implement compact application identity outside the card; neutral colors, rounded border, restrained spacing, readable title, subtle load/error state, and a meaningful expand control. Prefer a persistent dialog/DOM node for modal presentation so the iframe is not moved.
- [x] Send current container dimensions and standard theme tokens; do not use arbitrary fixed maximum sizes as viewport information. Preserve reachable content when an older widget exceeds inline space.
- [x] Verify desktop/mobile and light/dark screenshots, keyboard close/focus, and no iframe remount while toggling modes.

## Task 4: Ticket UI alignment

**Files:** /root/code/hose-skills/plugins/ticket-intake/mcp/src/widget.html, widget.mjs, ticket-view.mjs if needed; manifests; skill presentation instruction; existing plugin tests and generated assets.

**Interfaces:** Keep schemaVersion 1 and existing read-only tool inputs compatible. App declares inline/fullscreen support, applies host styles and context updates, and requests display modes using MCP Apps methods. Normal text fallback remains usable.

- [x] Preserve runtime data, but make inline display compact: title, status/type/priority, short facts and missing-field summary. Put the full description and detailed facts in expanded view without redundant repeated sections.
- [x] Use host theme variables with neutral light/dark fallback, consistent typography, accessible controls, and mobile layout. Provide local disclosure fallback for inline-only hosts.
- [x] Refine skill output to discuss the next business step after rendering, without claiming browser rendering succeeded or narrating the render tool. Keep non-UI fallback and existing business confirmations.
- [x] Bump matching plugin manifests; rebuild bundled server and widget; run npm run gen and npm run check.

## Task 5: Integration review and local activation

- [x] Run focused server/client/e2e checks and npm run build. Run harness:check and distinguish existing violations from new failures.
- [x] Independently review protocol boundaries and the final UI changes, and address actionable findings.
- [x] Configure the local dedicated sandbox origin only after the route and policy are verified. Validate reverse-proxy configuration before reload, preserving existing sites and independent Hermes bridge services.
- [x] Back up and update only the changed installed ticket plugin artifacts, restart the Studio-owned runtime using its existing source workflow, and verify readiness/resource resolution/sandbox response headers.
- [x] Capture the actual bundled ticket card in the browser, provide desktop/mobile images, and report scoped validation and remaining limitations. Do not claim complete certification of all optional MCP Apps capabilities.
