import { describe, expect, it } from 'vitest'
import {
  canReadSession,
  inheritSessionIdentities,
} from '../../packages/server/src/modules/studio/services/session-access'

describe('inheritSessionIdentities (subagent visibility inheritance)', () => {
  it('subagent child inherits the owner of its parent session', () => {
    const rows = [
      { id: 'parent-1', source: 'cli', user_id: null, owner_user_id: 7 },
      { id: 'sub-1', source: 'subagent', user_id: null, owner_user_id: null, parent_session_id: 'parent-1' },
    ]
    const [parent, child] = inheritSessionIdentities(rows)
    expect(parent.owner_user_id).toBe(7)
    expect(child.owner_user_id).toBe(7)
    expect(canReadSession({ id: 7 }, child)).toBe(true)
    expect(canReadSession({ id: 8 }, child)).toBe(false)
  })

  it('subagent child of a channel session inherits the channel actor (read-only)', () => {
    const rows = [
      { id: 'chan-1', source: 'dingtalk', user_id: '$:LWCP_v1:$abc' },
      { id: 'sub-1', source: 'subagent', user_id: null, parent_session_id: 'chan-1' },
    ]
    const [, child] = inheritSessionIdentities(rows)
    expect(child.external_actor_source).toBe('dingtalk')
    expect(child.external_actor_id).toBe('$:LWCP_v1:$abc')
  })

  it('follows nested subagent chains to the nearest ancestor identity', () => {
    const rows = [
      { id: 'chan-1', source: 'feishu', user_id: 'ou_x' },
      { id: 'sub-1', source: 'subagent', user_id: null, parent_session_id: 'chan-1' },
      { id: 'sub-2', source: 'subagent', user_id: null, parent_session_id: 'sub-1' },
    ]
    const child = inheritSessionIdentities(rows)[2]
    expect(child.external_actor_source).toBe('feishu')
    expect(child.external_actor_id).toBe('ou_x')
  })

  it('parent cycles terminate without hanging', () => {
    const rows = [
      { id: 'a', source: 'subagent', user_id: null, parent_session_id: 'b' },
      { id: 'b', source: 'subagent', user_id: null, parent_session_id: 'a' },
    ]
    const result = inheritSessionIdentities(rows)
    expect(result[0].owner_user_id).toBeUndefined()
    expect(result[1].owner_user_id).toBeUndefined()
  })

  it('missing parent leaves the row without an identity', () => {
    const rows = [{ id: 'sub-1', source: 'subagent', user_id: null, parent_session_id: 'gone' }]
    const [child] = inheritSessionIdentities(rows)
    expect(child.owner_user_id).toBeUndefined()
    expect(child.external_actor_source).toBeUndefined()
  })

  it('rows that already carry an identity are untouched', () => {
    const rows = [
      { id: 'parent-1', source: 'cli', user_id: null, owner_user_id: 3 },
      { id: 'sub-1', source: 'subagent', user_id: null, owner_user_id: 4, parent_session_id: 'parent-1' },
    ]
    const [, child] = inheritSessionIdentities(rows)
    expect(child.owner_user_id).toBe(4)
    expect(canReadSession({ id: 4 }, child)).toBe(true)
    expect(canReadSession({ id: 3 }, child)).toBe(false)
  })

  it('external_actor fields on the parent propagate to the child', () => {
    const rows = [
      { id: 'parent-1', source: 'api_server', user_id: null, owner_user_id: null, external_actor_source: 'feishu', external_actor_id: 'ou_y' },
      { id: 'sub-1', source: 'subagent', user_id: null, parent_session_id: 'parent-1' },
    ]
    const child = inheritSessionIdentities(rows)[1]
    expect(child.external_actor_source).toBe('feishu')
    expect(child.external_actor_id).toBe('ou_y')
  })
})
