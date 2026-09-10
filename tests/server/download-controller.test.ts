import { beforeEach, describe, expect, it, vi } from 'vitest'

const readFileMock = vi.hoisted(() => vi.fn())
const isInProfileUploadDirMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/studio/services/files/file-provider', () => ({
  createFileProvider: vi.fn(),
  localProvider: { readFile: readFileMock },
  isInUploadDir: vi.fn((path: string) => path.includes('/upload/')),
  isSensitivePath: vi.fn((path: string) => ['.env', 'auth.json'].includes(path.replace(/\\/g, '/').split('/').pop() || '')),
  validatePath: vi.fn((path: string) => path),
  resolveProfileFilePath: vi.fn((path: string, profile: string) => `/profiles/${profile}/${path}`),
}))

vi.mock('../../packages/server/src/modules/studio/services/files/upload-paths', () => ({
  isInProfileUploadDir: isInProfileUploadDirMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
}))

import { download } from '../../packages/server/src/modules/studio/controllers/download'

function context(path: string, role = 'user') {
  return {
    query: { path },
    state: { user: { id: 7, role }, profile: { name: 'default' } },
    set: vi.fn(),
  } as any
}

describe('download controller path authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readFileMock.mockResolvedValue(Buffer.from('attachment'))
    isInProfileUploadDirMock.mockReturnValue(false)
  })

  it.each(['.env', 'auth.json'])(
    'rejects the relative sensitive path %s for a non-super-admin user',
    async (path) => {
      const ctx = context(path)

      await download(ctx)

      expect(ctx.status).toBe(403)
      expect(ctx.body).toEqual({
        error: 'Sensitive files cannot be downloaded',
        code: 'permission_denied',
      })
      expect(readFileMock).not.toHaveBeenCalled()
    },
  )

  it('rejects an arbitrary absolute path for a non-super-admin user', async () => {
    const ctx = context('/etc/passwd')

    await download(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({
      error: 'Absolute file path is outside the current Profile upload directory',
      code: 'permission_denied',
    })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('rejects arbitrary Profile-relative files for a plain user', async () => {
    const ctx = context('workspace/customer-data.csv')

    await download(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({
      error: 'Profile files are available only to super administrators',
      code: 'permission_denied',
    })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('rejects Profile-relative files for a regular administrator', async () => {
    const ctx = context('workspace/customer-data.csv', 'admin')

    await download(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({
      error: 'Profile files are available only to super administrators',
      code: 'permission_denied',
    })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('allows an absolute attachment in the current Profile upload directory', async () => {
    const path = '/tmp/hermes-web-ui/upload/default/report.txt'
    isInProfileUploadDirMock.mockImplementation((candidate: string, profile: string) => (
      candidate === path && profile === 'default'
    ))
    const ctx = context(path)

    await download(ctx)

    expect(ctx.status).toBeUndefined()
    expect(readFileMock).toHaveBeenCalledWith(path)
    expect(ctx.body).toEqual(Buffer.from('attachment'))
  })

  it('requires an authorized request Profile for non-super-admin attachments', async () => {
    const path = '/tmp/hermes-web-ui/upload/default/report.txt'
    isInProfileUploadDirMock.mockReturnValue(true)
    const ctx: any = {
      query: { path },
      state: { user: { id: 7, role: 'user' } },
      set: vi.fn(),
    }

    await download(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Profile is required', code: 'missing_profile' })
    expect(isInProfileUploadDirMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
  })
})
