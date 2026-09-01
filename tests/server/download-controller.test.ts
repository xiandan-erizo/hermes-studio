import { describe, expect, it } from 'vitest'
import { download } from '../../packages/server/src/modules/studio/controllers/download'

describe('download controller path authorization', () => {
  it('rejects an absolute .env path for a non-super-admin user', async () => {
    const ctx = {
      query: { path: '/root/.hermes/.env' },
      state: { user: { id: 7, role: 'user' }, profile: { name: 'default' } },
      set: () => undefined,
    } as any

    await download(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({
      error: 'Absolute file paths require super administrator privileges',
      code: 'permission_denied',
    })
  })
})
