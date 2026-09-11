import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('Plugin marketplace', () => {
  let workDir = ''

  beforeEach(async () => {
    workDir = join(tmpdir(), `marketplace-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(workDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  async function writeFixtureRepo(): Promise<string> {
    const repo = join(workDir, 'repo')
    const pluginDir = join(repo, 'plugins', 'demo-tool')
    await mkdir(join(pluginDir, '.codex-plugin'), { recursive: true })
    await mkdir(join(pluginDir, 'skills', 'demo-tool'), { recursive: true })
    await mkdir(join(pluginDir, 'skills', 'demo-tool', 'scripts'), { recursive: true })
    await writeFile(
      join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'demo-tool',
        version: '1.2.3',
        description: 'A demo plugin.',
        author: { name: 'OpenResources' },
        interface: {
          displayName: 'Demo Tool',
          category: 'Developer Tools',
          defaultPrompt: ['Use demo-tool.'],
        },
      }),
      'utf-8',
    )
    await writeFile(
      join(pluginDir, 'skills', 'demo-tool', 'SKILL.md'),
      `---
name: demo-tool
description: Does demo things. Use when user says "demo".
allowed-tools:
  - Bash(demo:*)
---

# Demo Tool

Body text here.
`,
      'utf-8',
    )
    await writeFile(join(pluginDir, 'skills', 'demo-tool', 'scripts', 'run.py'), 'print("hi")\n', 'utf-8')
    return repo
  }

  async function writePortableFixtureRepo(): Promise<string> {
    const repo = await writeFixtureRepo()
    const pluginDir = join(repo, 'plugins', 'demo-tool')
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'demo-tool',
        version: '1.2.3',
        description: 'Portable demo plugin.',
        author: { name: 'OpenResources' },
      }),
      'utf-8',
    )
    await writeFile(
      join(pluginDir, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          view: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/mcp/server.cjs'] },
        },
      }),
      'utf-8',
    )
    await mkdir(join(pluginDir, 'mcp'), { recursive: true })
    await mkdir(join(pluginDir, 'assets'), { recursive: true })
    await writeFile(join(pluginDir, 'mcp', 'server.cjs'), 'process.stdin.resume()\n', 'utf-8')
    await writeFile(join(pluginDir, 'assets', 'view.html'), '<html>portable</html>\n', 'utf-8')
    return repo
  }

  describe('frontmatter parsing', () => {
    it('parses yaml frontmatter and splits the body', async () => {
      const { parseFrontmatter } = await import('../../packages/server/src/modules/hermes/services/marketplace/repo-scanner')
      const parsed = parseFrontmatter('---\nname: x\ndescription: y\n---\n\n# Hello\n')
      expect(parsed.data).toEqual({ name: 'x', description: 'y' })
      expect(parsed.content.trim()).toBe('# Hello')
    })

    it('returns the raw text when there is no frontmatter', async () => {
      const { parseFrontmatter } = await import('../../packages/server/src/modules/hermes/services/marketplace/repo-scanner')
      const parsed = parseFrontmatter('# Just markdown\n')
      expect(parsed.data).toEqual({})
      expect(parsed.content).toBe('# Just markdown\n')
    })
  })

  describe('repo scanning', () => {
    it('derives the catalog from plugin.json + SKILL.md', async () => {
      const repo = await writeFixtureRepo()
      const { scanMarketplaceRepo } = await import('../../packages/server/src/modules/hermes/services/marketplace/repo-scanner')
      const plugins = await scanMarketplaceRepo(repo)
      expect(plugins).toHaveLength(1)
      expect(plugins[0]).toMatchObject({
        name: 'demo-tool',
        version: '1.2.3',
        description: 'A demo plugin.',
        author: 'OpenResources',
      })
      expect(plugins[0].interface?.displayName).toBe('Demo Tool')
      expect(plugins[0].portable).toBe(false)
      expect(plugins[0].skills).toEqual([
        {
          name: 'demo-tool',
          description: 'Does demo things. Use when user says "demo".',
          allowedTools: ['Bash(demo:*)'],
        },
      ])
    })

    it('uses a portable root manifest as identity and the Codex manifest as its interface overlay', async () => {
      const repo = await writePortableFixtureRepo()
      const { scanMarketplaceRepo } = await import('../../packages/server/src/modules/hermes/services/marketplace/repo-scanner')
      const [plugin] = await scanMarketplaceRepo(repo)
      expect(plugin).toMatchObject({
        name: 'demo-tool',
        version: '1.2.3',
        description: 'Portable demo plugin.',
        portable: true,
        interface: { displayName: 'Demo Tool' },
      })
    })

    it('loads plugin detail with SKILL.md bodies and file lists', async () => {
      const repo = await writeFixtureRepo()
      const { readPluginDetail } = await import('../../packages/server/src/modules/hermes/services/marketplace/repo-scanner')
      const detail = await readPluginDetail(repo, 'demo-tool')
      expect(detail).not.toBeNull()
      expect(detail!.skills[0].content).toContain('# Demo Tool')
      expect([...detail!.skills[0].files].sort()).toEqual(['SKILL.md', 'scripts/run.py'])
    })

    it('rejects duplicate skill names across plugins', async () => {
      const repo = await writeFixtureRepo()
      const other = join(repo, 'plugins', 'other-tool')
      await mkdir(join(other, '.codex-plugin'), { recursive: true })
      await mkdir(join(other, 'skills', 'demo-tool'), { recursive: true })
      await writeFile(join(other, '.codex-plugin', 'plugin.json'), '{"name":"other-tool","version":"0.1.0"}', 'utf-8')
      await writeFile(join(other, 'skills', 'demo-tool', 'SKILL.md'), '---\nname: demo-tool\ndescription: dup\n---\nbody', 'utf-8')
      const { scanMarketplaceRepo } = await import('../../packages/server/src/modules/hermes/services/marketplace/repo-scanner')
      await expect(scanMarketplaceRepo(repo)).rejects.toThrow(/defined more than once/)
    })

    it('refuses traversal-style plugin/skill names', async () => {
      const repo = await writeFixtureRepo()
      const { readPluginDetail } = await import('../../packages/server/src/modules/hermes/services/marketplace/repo-scanner')
      await expect(readPluginDetail(repo, '../demo-tool')).resolves.toBeNull()
    })
  })

  describe('git URL validation', () => {
    it('accepts only SSH git URLs', async () => {
      const { validateGitSshUrl, MarketplaceUrlError } = await import('../../packages/server/src/modules/hermes/services/marketplace/git-cache')
      expect(validateGitSshUrl('git@git.ekuaibao.com:ai-learning/hose-skills.git')).toBe('git@git.ekuaibao.com:ai-learning/hose-skills.git')
      expect(validateGitSshUrl('ssh://git@git.ekuaibao.com/ai-learning/hose-skills.git')).toContain('ssh://')
      for (const bad of ['https://git.ekuaibao.com/x.git', 'http://x/y', 'file:///etc/passwd', '/local/path', '', 'git@host:../../escape']) {
        expect(() => validateGitSshUrl(bad)).toThrow(MarketplaceUrlError)
      }
    })
  })

  describe('install / uninstall', () => {
    async function loadInstall() {
      return await import('../../packages/server/src/modules/hermes/services/marketplace/install')
    }

    it('installs a skill with lock provenance, updates and uninstalls', async () => {
      const repo = await writeFixtureRepo()
      const skillsDir = join(workDir, 'profile', 'skills')
      const { installMarketplaceSkill, listMarketplaceInstalled, uninstallMarketplaceSkill, MARKETPLACE_LOCK_FILENAME } = await loadInstall()
      const source = { id: 7, name: 'src', url: 'git@host:grp/repo.git', enabled: 1 } as any

      const result = await installMarketplaceSkill({ source, repoDir: repo, skillsDir, plugin: 'demo-tool', skill: 'demo-tool', version: '1.2.3' })
      expect(result.updated).toBe(false)
      expect(await readFile(join(skillsDir, 'demo-tool', 'scripts', 'run.py'), 'utf-8')).toContain('hi')

      const lockRaw = JSON.parse(await readFile(join(skillsDir, MARKETPLACE_LOCK_FILENAME), 'utf-8'))
      expect(lockRaw['demo-tool']).toMatchObject({ sourceId: 7, plugin: 'demo-tool', version: '1.2.3' })

      // Re-install from the same source is an update, not a conflict.
      const again = await installMarketplaceSkill({ source, repoDir: repo, skillsDir, plugin: 'demo-tool', skill: 'demo-tool', version: '1.3.0' })
      expect(again.updated).toBe(true)

      const installed = await listMarketplaceInstalled(skillsDir)
      expect(installed).toHaveLength(1)
      expect(installed[0]).toMatchObject({ skill: 'demo-tool', sourceId: 7, plugin: 'demo-tool', version: '1.3.0', modified: false })

      // Local edit flips the modified flag.
      await writeFile(join(skillsDir, 'demo-tool', 'SKILL.md'), '---\nname: demo-tool\ndescription: changed\n---\nbody', 'utf-8')
      const installedModified = await listMarketplaceInstalled(skillsDir)
      expect(installedModified[0].modified).toBe(true)

      await uninstallMarketplaceSkill(skillsDir, 'demo-tool')
      const afterUninstall = await listMarketplaceInstalled(skillsDir)
      expect(afterUninstall).toHaveLength(0)
    })

    it('refuses to clobber a non-marketplace skill', async () => {
      const repo = await writeFixtureRepo()
      const skillsDir = join(workDir, 'profile2', 'skills')
      await mkdir(join(skillsDir, 'demo-tool'), { recursive: true })
      await writeFile(join(skillsDir, 'demo-tool', 'SKILL.md'), '---\nname: demo-tool\ndescription: mine\n---\n', 'utf-8')
      const { installMarketplaceSkill, MarketplaceInstallError } = await loadInstall()
      const source = { id: 7, name: 'src', url: 'git@host:grp/repo.git', enabled: 1 } as any
      await expect(
        installMarketplaceSkill({ source, repoDir: repo, skillsDir, plugin: 'demo-tool', skill: 'demo-tool' }),
      ).rejects.toThrow(MarketplaceInstallError)
    })

    it('refuses reinstall from a different source', async () => {
      const repo = await writeFixtureRepo()
      const skillsDir = join(workDir, 'profile3', 'skills')
      const { installMarketplaceSkill, MarketplaceInstallError } = await loadInstall()
      const sourceA = { id: 1, name: 'a', url: 'git@host:a.git', enabled: 1 } as any
      const sourceB = { id: 2, name: 'b', url: 'git@host:b.git', enabled: 1 } as any
      await installMarketplaceSkill({ source: sourceA, repoDir: repo, skillsDir, plugin: 'demo-tool', skill: 'demo-tool' })
      await expect(
        installMarketplaceSkill({ source: sourceB, repoDir: repo, skillsDir, plugin: 'demo-tool', skill: 'demo-tool' }),
      ).rejects.toThrow(/installed from source "a"/)
    })

    it('installs, updates, and uninstalls a complete portable plugin while preserving plugin data', async () => {
      const repo = await writePortableFixtureRepo()
      const profileDir = join(workDir, 'portable-profile')
      const skillsDir = join(profileDir, 'skills')
      const pluginsDir = join(profileDir, 'plugins')
      const dataSentinel = join(profileDir, 'plugin-data', 'demo-tool', 'state.json')
      await mkdir(join(profileDir, 'plugin-data', 'demo-tool'), { recursive: true })
      await writeFile(dataSentinel, '{"kept":true}\n', 'utf-8')
      await writeFile(join(profileDir, 'config.yaml'), 'plugins:\n  enabled: []\n  disabled:\n    - demo-tool\n', 'utf-8')
      const {
        installMarketplacePlugin,
        listMarketplaceInstalled,
        uninstallMarketplaceSkill,
        readMarketplaceLock,
      } = await loadInstall()
      const source = { id: 7, name: 'src', url: 'git@host:grp/repo.git', enabled: 1 } as any

      const installed = await installMarketplacePlugin({
        source,
        repoDir: repo,
        profileDir,
        plugin: 'demo-tool',
        version: '1.2.3',
      })
      expect(installed).toMatchObject({ plugin: 'demo-tool', skill: 'demo-tool', installKind: 'plugin', updated: false })
      expect(await readFile(join(pluginsDir, 'demo-tool', 'plugin.json'), 'utf-8')).toContain('agent-plugins.org')
      expect(await readFile(join(pluginsDir, 'demo-tool', 'mcp', 'server.cjs'), 'utf-8')).toContain('stdin')
      expect(await readFile(join(pluginsDir, 'demo-tool', 'assets', 'view.html'), 'utf-8')).toContain('portable')
      const enabledConfig = await readFile(join(profileDir, 'config.yaml'), 'utf-8')
      expect(enabledConfig).toMatch(/enabled:[\s\S]*demo-tool/)
      expect(enabledConfig).not.toMatch(/disabled:[\s\S]*demo-tool/)
      expect((await readMarketplaceLock(skillsDir))['demo-tool']).toMatchObject({ installKind: 'plugin' })

      await writeFile(join(pluginsDir, 'demo-tool', 'assets', 'view.html'), '<html>local edit</html>\n', 'utf-8')
      expect((await listMarketplaceInstalled(skillsDir))[0]).toMatchObject({
        plugin: 'demo-tool', installKind: 'plugin', modified: true,
      })
      const updated = await installMarketplacePlugin({ source, repoDir: repo, profileDir, plugin: 'demo-tool', version: '1.3.0' })
      expect(updated.updated).toBe(true)
      expect(await readFile(join(pluginsDir, 'demo-tool', 'assets', 'view.html'), 'utf-8')).toContain('portable')

      await uninstallMarketplaceSkill(skillsDir, 'demo-tool')
      await expect(stat(join(pluginsDir, 'demo-tool'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(dataSentinel, 'utf-8')).toContain('kept')
      const disabledConfig = await readFile(join(profileDir, 'config.yaml'), 'utf-8')
      expect(disabledConfig).not.toMatch(/enabled:[\s\S]*demo-tool/)
      expect(disabledConfig).not.toMatch(/disabled:[\s\S]*demo-tool/)
    })

    it('migrates a same-source marketplace skill into its portable plugin package', async () => {
      const repo = await writePortableFixtureRepo()
      const profileDir = join(workDir, 'migration-profile')
      const skillsDir = join(profileDir, 'skills')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.yaml'), '{}\n', 'utf-8')
      const { installMarketplaceSkill, installMarketplacePlugin, listMarketplaceInstalled } = await loadInstall()
      const source = { id: 7, name: 'src', url: 'git@host:grp/repo.git', enabled: 1 } as any

      await installMarketplaceSkill({ source, repoDir: repo, skillsDir, plugin: 'demo-tool', skill: 'demo-tool' })
      await installMarketplacePlugin({ source, repoDir: repo, profileDir, plugin: 'demo-tool', version: '1.2.3' })

      await expect(stat(join(skillsDir, 'demo-tool'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(profileDir, 'plugins', 'demo-tool', 'mcp.json'), 'utf-8')).toContain('mcpServers')
      expect(await listMarketplaceInstalled(skillsDir)).toMatchObject([
        { plugin: 'demo-tool', installKind: 'plugin' },
      ])
    })

    it('refuses to overwrite an unmanaged portable plugin directory', async () => {
      const repo = await writePortableFixtureRepo()
      const profileDir = join(workDir, 'conflict-profile')
      await mkdir(join(profileDir, 'plugins', 'demo-tool'), { recursive: true })
      await writeFile(join(profileDir, 'plugins', 'demo-tool', 'plugin.json'), '{"mine":true}\n', 'utf-8')
      await writeFile(join(profileDir, 'config.yaml'), '{}\n', 'utf-8')
      const { installMarketplacePlugin, MarketplaceInstallError } = await loadInstall()
      const source = { id: 7, name: 'src', url: 'git@host:grp/repo.git', enabled: 1 } as any

      await expect(installMarketplacePlugin({ source, repoDir: repo, profileDir, plugin: 'demo-tool' }))
        .rejects.toThrow(MarketplaceInstallError)
      expect(await readFile(join(profileDir, 'plugins', 'demo-tool', 'plugin.json'), 'utf-8')).toContain('mine')
    })
  })

  describe('sources store', () => {
    let db: any = null

    beforeEach(async () => {
      vi.resetModules()
      const { DatabaseSync } = await import('node:sqlite')
      db = new DatabaseSync(':memory:')
      vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
        getDb: () => db,
        isSqliteAvailable: () => true,
      }))
      const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      initAllHermesTables()
    })

    afterEach(() => {
      db?.close()
      db = null
      vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
      vi.resetModules()
    })

    it('crud + sync bookkeeping', async () => {
      const store = await import('../../packages/server/src/modules/hermes/services/marketplace/sources-store')
      const created = store.createMarketplaceSource({ name: 'hose-skills', url: 'git@git.ekuaibao.com:ai-learning/hose-skills.git' })
      expect(created).toMatchObject({ name: 'hose-skills', enabled: 1 })
      expect(store.createMarketplaceSource({ name: 'dup', url: 'git@git.ekuaibao.com:ai-learning/hose-skills.git' })).toEqual({ conflict: true })

      store.recordSourceSync((created as any).id, { commit: 'abc123' })
      const synced = store.findMarketplaceSource((created as any).id)
      expect(synced!.last_commit).toBe('abc123')
      expect(synced!.last_error).toBeNull()
      expect(synced!.last_synced_at).not.toBeNull()

      const updated = store.updateMarketplaceSource((created as any).id, { name: 'renamed', enabled: false })
      expect(updated).toMatchObject({ name: 'renamed', enabled: 0 })

      expect(store.deleteMarketplaceSource((created as any).id)).toBe(true)
      expect(store.findMarketplaceSource((created as any).id)).toBeNull()
    })
  })
})
