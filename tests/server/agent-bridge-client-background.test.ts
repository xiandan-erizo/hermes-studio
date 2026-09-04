import { describe, expect, it, vi } from 'vitest'

describe('AgentBridgeClient background delegation requests', () => {
  it('forwards an explicit Agent-session creation setting', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      run_id: 'run-1',
      session_id: 'session-1',
      status: 'running',
    })

    await client.chat('session-1', 'hello', undefined, undefined, 'default', {
      background_delegation_enabled: false,
    })
    await client.chat('session-2', 'hello')
    await client.contextEstimate('session-3', [], undefined, 'default', {
      background_delegation_enabled: false,
    })

    expect(request.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      action: 'chat',
      background_delegation_enabled: false,
    }))
    expect(request.mock.calls[1]?.[0]).not.toHaveProperty('background_delegation_enabled')
    expect(request.mock.calls[2]?.[0]).toEqual(expect.objectContaining({
      action: 'context_estimate',
      background_delegation_enabled: false,
    }))
  })

  it('forwards personal chat identity to chat and context estimates', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        ok: true,
        run_id: 'run-personal-identity',
        session_id: 'session-personal-identity',
        status: 'running',
      })
      .mockResolvedValueOnce({
        ok: true,
        session_id: 'session-personal-identity',
        message_count: 0,
        tool_count: 0,
        system_prompt_chars: 0,
      })
    const personalChatIdentity = {
      version: 1,
      source: 'hermes_studio',
      email: 'bob@example.com',
      username: 'bob',
      displayName: 'Bob Example',
    }

    await client.chat('session-personal-identity', 'hello', undefined, undefined, 'default', {
      personal_chat_identity: personalChatIdentity,
    })
    await client.contextEstimate('session-personal-identity', [], undefined, 'default', {
      personal_chat_identity: personalChatIdentity,
    })

    expect(request.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      action: 'chat',
      personal_chat_identity: personalChatIdentity,
    }))
    expect(request.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      action: 'context_estimate',
      personal_chat_identity: personalChatIdentity,
    }))
  })

  it('omits personal chat identity from chat and context estimates when it is not set', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        ok: true,
        run_id: 'run-without-personal-identity',
        session_id: 'session-without-personal-identity',
        status: 'running',
      })
      .mockResolvedValueOnce({
        ok: true,
        session_id: 'session-without-personal-identity',
        message_count: 0,
        tool_count: 0,
        system_prompt_chars: 0,
      })

    await client.chat('session-without-personal-identity', 'hello')
    await client.contextEstimate('session-without-personal-identity', [])

    expect(request.mock.calls[0]?.[0]).not.toHaveProperty('personal_chat_identity')
    expect(request.mock.calls[1]?.[0]).not.toHaveProperty('personal_chat_identity')
  })

  it('forwards recovery routes and delivery acknowledgements', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true })

    await client.backgroundPoll([
      { profile: 'default', session_ids: ['session-1'] },
    ], { timeoutMs: 500 })
    await client.completeBackgroundNotification('session-1', 'default', 'deleg-1', 'claim-1')
    await client.releaseBackgroundNotification('session-1', 'default', 'deleg-2', 'claim-2')

    expect(request).toHaveBeenNthCalledWith(1, {
      action: 'background_poll',
      routes: [{ profile: 'default', session_ids: ['session-1'] }],
    }, { timeoutMs: 500 })
    expect(request).toHaveBeenNthCalledWith(2, {
      action: 'background_notification_complete',
      session_id: 'session-1',
      profile: 'default',
      delegation_id: 'deleg-1',
      claim_id: 'claim-1',
    })
    expect(request).toHaveBeenNthCalledWith(3, {
      action: 'background_notification_release',
      session_id: 'session-1',
      profile: 'default',
      delegation_id: 'deleg-2',
      claim_id: 'claim-2',
    })
  })
})
