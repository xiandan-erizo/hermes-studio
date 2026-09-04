# Personal Chat Email Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the authenticated SSO customer's normalized email and available display fields from Hermes Studio personal chat into the Hermes runtime and LLM context.

**Architecture:** Studio persists allowlisted OIDC profile fields, resolves a narrow `PersonalChatIdentitySnapshot` from the authenticated server-side user, and sends it on both Agent Bridge context-estimate and chat requests. The Python bridge validates and pins that identity before constructing `AIAgent`, binds a dedicated Hermes ContextVar during construction and every turn, and appends a bounded data-only customer block to the existing ephemeral system prompt. Existing Gateway routing identities and OpenViking configuration remain untouched.

**Tech Stack:** Vue 3, TypeScript, Koa, Socket.IO, SQLite, Vitest, Node.js, Python 3, pytest.

**Spec:** `docs/superpowers/specs/2026-09-04-personal-chat-email-identity-design.md`

## Global Constraints

- Scope is WebUI personal chat (`runSource === "cli"`) only.
- Normalize email with trim plus lowercase; preserve dots and `+suffix`.
- Resolve identity from authenticated Studio server state, never browser run payloads.
- Treat `username` and `displayName` as optional attributes, not identity keys.
- Never send role, JWT, OIDC token, raw claims, or SSO subject over the bridge.
- Reject ordinary role `user` without SSO email before Agent creation; allow local `super_admin` without email.
- Do not change Group Chat, Workflow, direct CLI/TUI, OpenViking, or memory partitioning.
- Do not reuse Gateway `user_id`, `user_id_alt`, or `user_name` for this identity.
- Never log raw email or display name.
- Pin the customer snapshot for one `AgentSession` so the prompt is stable between turns.

## File Map

Studio (`/root/code/hermes-studio`): SSO schema/repository/services; a focused personal-chat resolver; TypeScript and Python bridge contracts; auth responses; authorized user-management display; server, client, and Python-harness tests.

Hermes Agent (`/root/code/hermes-agent`): `gateway/session_context.py` and `tests/gateway/test_session_env.py` only. The existing local commit on `main` remains unchanged and ahead of the new commit.

---

### Task 1: Persist Allowlisted SSO Profile Data

**Files:**
- Modify: `packages/server/src/modules/studio/infrastructure/database/schemas.ts`
- Modify: `packages/server/src/modules/studio/repositories/sso-identities-store.ts`
- Modify: `packages/server/src/modules/studio/services/auth/oidc.ts`
- Modify: `packages/server/src/modules/studio/services/auth/sso-accounts.ts`
- Modify: `packages/server/src/modules/studio/controllers/sso.ts`
- Test: `tests/server/profile-invites.test.ts`
- Create: `tests/server/sso-identity.test.ts`

**Interfaces:**
- Produces `OidcIdentityClaims { sub, username, displayName, email }`.
- Produces `resolveOidcIdentityClaims(tokens: { idToken: string | null; accessToken: string | null }, expectedNonce: string): Promise<OidcIdentityClaims>`.
- Produces `findSsoIdentityByUserId(userId): SsoIdentityRecord | null`.
- Produces `SsoIdentityRecord.display_name: string`.

- [ ] **Step 1: Write failing storage and claim tests**

Use literal expectations:

```ts
expect(identity!.display_name).toBe('Bob Example')
expect(findSsoIdentityByUserId(user!.id)?.email).toBe('bob@example.com')
```

Test an ID token with `sub`/`preferred_username` plus matching UserInfo with `name`/`email`, expecting:

```ts
{
  sub: 'subject-1',
  username: 'bob',
  displayName: 'Bob Example',
  email: 'Bob@Example.com',
}
```

Test that UserInfo `sub: 'subject-2'` rejects with `OIDC userinfo subject mismatch`.

- [ ] **Step 2: Verify RED**

```bash
npm test -- --run tests/server/profile-invites.test.ts tests/server/sso-identity.test.ts
```

Expected: failure because the new field, lookup, and resolver are absent.

- [ ] **Step 3: Implement the minimum SSO change**

Add `display_name: "TEXT NOT NULL DEFAULT ''"` to `SSO_IDENTITIES_SCHEMA`; extend create/update SQL; add `findSsoIdentityByUserId`. Extend OIDC claim normalization and add `resolveOidcIdentityClaims`: verified ID-token `sub` is authoritative, matching UserInfo fills missing allowlisted fields, optional UserInfo failure does not invalidate a complete verified ID token, and a successful mismatching UserInfo fails login. Update callback/account persistence to use the result.

- [ ] **Step 4: Verify GREEN and commit**

Run Step 2, then:

```bash
git add packages/server/src/modules/studio/infrastructure/database/schemas.ts packages/server/src/modules/studio/repositories/sso-identities-store.ts packages/server/src/modules/studio/services/auth/oidc.ts packages/server/src/modules/studio/services/auth/sso-accounts.ts packages/server/src/modules/studio/controllers/sso.ts tests/server/profile-invites.test.ts tests/server/sso-identity.test.ts
git commit -m "feat(auth): retain SSO customer profile fields"
```

### Task 2: Resolve Identity At The Personal-Chat Boundary

**Files:**
- Create: `packages/server/src/modules/studio/services/chat-run/personal-chat-identity.ts`
- Modify: `packages/server/src/modules/studio/contracts/runs/session.ts`
- Modify: `packages/server/src/modules/studio/services/chat-run/handle-bridge-run.ts`
- Test: `tests/server/run-chat-bridge-final-context.test.ts`

**Interfaces:**

```ts
export interface PersonalChatIdentitySnapshot {
  version: 1
  source: 'hermes_studio'
  email: string
  username?: string
  displayName?: string
}

export function resolvePersonalChatIdentity(
  user: AuthenticatedUser | undefined,
): PersonalChatIdentitySnapshot | undefined
```

- [ ] **Step 1: Write failing boundary tests**

For an authenticated role `user` with an SSO row, assert both context estimation and chat receive the literal normalized identity above. Also prove browser-supplied identity is ignored; a role `user` without email emits `run.failed` containing `SSO account email is required` before any bridge call; a `super_admin` without SSO starts anonymously; Group Chat and Workflow omit identity; a personal background-delegation continuation reuses the origin snapshot even when it is processed after the initiating Socket turn.

- [ ] **Step 2: Verify RED**

```bash
npm test -- --run tests/server/run-chat-bridge-final-context.test.ts
```

- [ ] **Step 3: Implement server-authoritative resolution**

Normalize email using `trim().toLowerCase()` without provider alias rewriting. Resolve only when `runSource === 'cli'`; convert the typed missing-email error to one `run.failed` event. Define the snapshot in the run contract, add it to `HermesBackgroundContinuationContext`, and persist it in the existing process-local continuation context so background delivery cannot lose or re-resolve the initiating customer. Pass one snapshot to every `ensureBridgeFixedContext` call and final `bridge.chat`. Add a deferred-scope comment where Group Chat and Workflow are excluded.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm test -- --run tests/server/run-chat-bridge-final-context.test.ts
git add packages/server/src/modules/studio/services/chat-run/personal-chat-identity.ts packages/server/src/modules/studio/contracts/runs/session.ts packages/server/src/modules/studio/services/chat-run/handle-bridge-run.ts tests/server/run-chat-bridge-final-context.test.ts
git commit -m "feat(chat): resolve authenticated customer identity"
```

### Task 3: Extend The TypeScript Bridge Wire Contract

**Files:**
- Modify: `packages/server/src/modules/hermes/services/bridge/client.ts`
- Test: `tests/server/agent-bridge-client-background.test.ts`
- Test: `tests/server/agent-bridge-reasoning-effort.test.ts`

**Interfaces:**
- Produces `AgentBridgePersonalChatIdentity` with the same wire fields as Task 2.
- Adds `AgentBridgeChatOptions.personal_chat_identity`.
- Adds the same option to `contextEstimate`.

- [ ] **Step 1: Write failing wire tests**

Assert captured `chat` and `context_estimate` JSON requests include:

```ts
personal_chat_identity: {
  version: 1,
  source: 'hermes_studio',
  email: 'bob@example.com',
  username: 'bob',
  displayName: 'Bob Example',
}
```

Also assert omitted identity produces no key in either request.

- [ ] **Step 2: Verify RED**

```bash
npm test -- --run tests/server/agent-bridge-client-background.test.ts tests/server/agent-bridge-reasoning-effort.test.ts
```

- [ ] **Step 3: Implement narrow types and conditional serialization**

Keep `personal_chat_identity` snake_case because it is the JSON protocol field. Do not import Studio module internals into the Hermes bridge module.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm test -- --run tests/server/agent-bridge-client-background.test.ts tests/server/agent-bridge-reasoning-effort.test.ts
git add packages/server/src/modules/hermes/services/bridge/client.ts tests/server/agent-bridge-client-background.test.ts tests/server/agent-bridge-reasoning-effort.test.ts
git commit -m "feat(bridge): carry personal chat identity"
```

### Task 4: Add A Dedicated Hermes Customer Context

**Files:**
- Modify: `/root/code/hermes-agent/gateway/session_context.py`
- Test: `/root/code/hermes-agent/tests/gateway/test_session_env.py`

**Interfaces:**

```py
def get_current_user_context() -> dict[str, str] | None

def set_session_vars(
    ...,
    authenticated_user_context: dict[str, str] | None = None,
) -> list
```

- [ ] **Step 1: Write failing ContextVar tests**

Bind this literal value:

```py
{
    "email": "bob@example.com",
    "username": "bob",
    "display_name": "Bob Example",
}
```

Assert the getter returns a defensive copy, returns `None` after `clear_session_vars`, and two `copy_context()` executions do not leak values.

- [ ] **Step 2: Verify RED**

```bash
cd /root/code/hermes-agent
venv/bin/python -m pytest tests/gateway/test_session_env.py -q
```

- [ ] **Step 3: Implement a non-environment ContextVar**

Add `_AUTHENTICATED_USER_CONTEXT`, include its token in `set_session_vars`, clear/reset it with the other session context, and return a fresh dictionary from the getter. Do not add it to `_VAR_MAP` or subprocess environment propagation.

- [ ] **Step 4: Verify GREEN and commit**

```bash
venv/bin/python -m pytest tests/gateway/test_session_env.py -q
git add gateway/session_context.py tests/gateway/test_session_env.py
git commit -m "feat(context): expose authenticated customer identity"
```

Do not amend, reset, or reorder the existing local Hermes Agent documentation commit.

### Task 5: Pin And Project Identity In The Python Bridge

**Files:**
- Create: `packages/server/src/modules/hermes/services/bridge/python/bridge_identity.py`
- Modify: `packages/server/src/modules/hermes/services/bridge/python/bridge_server.py`
- Modify: `packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py`
- Modify: `packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py`
- Test: `tests/server/agent-bridge-python-concurrency.test.ts`

**Interfaces:**

```py
def normalize_personal_chat_identity(value: Any) -> dict[str, str] | None
def format_personal_chat_identity_prompt(identity: dict[str, str] | None) -> str
```

- [ ] **Step 1: Write failing bridge lifecycle tests**

Prove valid normalization preserves dots and `+tag`; malformed email and multiline/control values reject; `chat` and `context_estimate` forward identity; first creation pins identity; same email reuses the session; changed or omitted identity rejects an identity-bound session; an anonymous idle session is recreated when identity first arrives; the ContextVar is visible during Agent construction and turn execution then clears; the effective ephemeral prompt contains escaped email/optional fields without allowing a value to create a heading.

- [ ] **Step 2: Verify RED**

```bash
npm test -- --run tests/server/agent-bridge-python-concurrency.test.ts
```

- [ ] **Step 3: Implement bridge identity lifecycle**

Keep validation/rendering in `bridge_identity.py`. Pass identity through `BridgeServer.handle`, `estimate_context`, `start_chat`, and `_run_chat`. Bind it before `AIAgent(...)`, append the bounded customer block to the configured ephemeral prompt, save the normalized snapshot in `AgentSession.config`, then clear the construction scope. Bind the pinned snapshot again during each run. Never populate Gateway `user_id`, `user_id_alt`, or `user_name`.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm test -- --run tests/server/agent-bridge-python-concurrency.test.ts tests/server/agent-bridge-client-background.test.ts tests/server/agent-bridge-reasoning-effort.test.ts tests/server/run-chat-bridge-final-context.test.ts
git add packages/server/src/modules/hermes/services/bridge/python/bridge_identity.py packages/server/src/modules/hermes/services/bridge/python/bridge_server.py packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py tests/server/agent-bridge-python-concurrency.test.ts
git commit -m "feat(bridge): bind personal customer context"
```

### Task 6: Show SSO Identity On Authorized Account Views

**Files:**
- Modify: `packages/server/src/modules/studio/controllers/auth.ts`
- Modify: `packages/client/src/api/studio/auth.ts`
- Modify: `packages/client/src/components/hermes/settings/UserManagementSettings.vue`
- Modify: `tests/server/user-auth.test.ts`
- Create: `tests/client/user-management-sso-identity.test.ts`

**Interfaces:**
- Adds optional `email` and `display_name` to `/api/auth/me` and existing managed-user responses.

- [ ] **Step 1: Write failing API and UI tests**

Assert mapped `/api/auth/me` and managed users contain `email: 'bob@example.com'` and `display_name: 'Bob Example'`. Assert the existing username table cell visibly renders both values. Authorization remains unchanged.

- [ ] **Step 2: Verify RED**

```bash
npm test -- --run tests/server/user-auth.test.ts tests/client/user-management-sso-identity.test.ts
```

- [ ] **Step 3: Implement serializer, types, and compact display**

Use one controller serializer backed by `findSsoIdentityByUserId`. Extend client types and show display name/email as secondary lines in the username column. Add no route, permission, or management action.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm test -- --run tests/server/user-auth.test.ts tests/client/user-management-sso-identity.test.ts
git add packages/server/src/modules/studio/controllers/auth.ts packages/client/src/api/studio/auth.ts packages/client/src/components/hermes/settings/UserManagementSettings.vue tests/server/user-auth.test.ts tests/client/user-management-sso-identity.test.ts
git commit -m "feat(auth): show SSO customer identity"
```

### Task 7: Verify, Build, And Smoke The Runtime

**Files:**
- Verify all modified files in both repositories.
- Keep `docs/openapi.json` only if its diff directly describes the intentional auth response; remove unrelated generator churn.

**Interfaces:**
- Produces rebuilt Studio server/bridge artifacts and a verified personal-chat runtime.

- [ ] **Step 1: Run focused cross-boundary tests**

```bash
cd /root/code/hermes-studio
npm test -- --run tests/server/profile-invites.test.ts tests/server/sso-identity.test.ts tests/server/user-auth.test.ts tests/server/run-chat-bridge-final-context.test.ts tests/server/agent-bridge-client-background.test.ts tests/server/agent-bridge-reasoning-effort.test.ts tests/server/agent-bridge-python-concurrency.test.ts tests/client/user-management-sso-identity.test.ts

cd /root/code/hermes-agent
venv/bin/python -m pytest tests/gateway/test_session_env.py -q
```

- [ ] **Step 2: Run build and repository checks**

```bash
cd /root/code/hermes-studio
npm run build
npm run harness:check
git diff --check

cd /root/code/hermes-agent
venv/bin/python -m pytest tests/gateway/test_session_env.py tests/agent/test_memory_provider.py -q
git diff --check
```

Record any pre-existing unrelated failure exactly; never call a failing suite green.

- [ ] **Step 3: Audit repository history and scope**

```bash
git -C /root/code/hermes-studio status --short --branch
git -C /root/code/hermes-studio diff origin/dev...HEAD --stat
git -C /root/code/hermes-agent status --short --branch
git -C /root/code/hermes-agent log --oneline --decorate -5
```

- [ ] **Step 4: Deploy only participating processes**

Restart the detached Studio backend with its existing `PORT=8647 NODE_ENV=production node dist/server/index.js` shape. Restart `hermes-bridge.service` so the IPC bridge loads the rebuilt Python bridge and current Hermes Agent source. Do not restart `hermes-bridge-tcp.service` or `hermes-gateway.service`.

- [ ] **Step 5: Verify health and the real SSO chat**

```bash
curl -fsS http://127.0.0.1:8647/health
curl -fsS http://127.0.0.1:8647/health/ready
curl -fsS http://127.0.0.1:8649/
systemctl is-active hermes-bridge.service
```

Start a new personal chat as existing SSO account `sunkesi`, ask `我是谁？`, verify the reply uses the authenticated email/name, verify Studio ownership remains local user `3`, and verify `/root/.hermes/state.db` did not gain a routing `user_id` from this feature.

- [ ] **Step 6: Report integration state**

Report exact commits, test/build output, process health, and unrelated failures. Push only after the user confirms target branches for both repositories.
