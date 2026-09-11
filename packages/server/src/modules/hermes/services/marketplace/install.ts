import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { join, resolve } from 'path'
import { isPathWithin } from '../runtime/path'
import { resolvePluginSkillDir, resolvePortablePluginDir } from './repo-scanner'
import type { MarketplaceSourceRecord } from './sources-store'
import { safeFileStore } from '../../../studio/public/safe-file-store'

/**
 * Marketplace skill installation into the requesting profile's skills dir.
 *
 * Provenance lock: <skillsDir>/.webui-marketplace-lock.json
 *   { [skillName]: { sourceId, plugin, version, contentHash, ... } }
 * This mirrors the agent's .hub/lock.json discipline: one owner per installed
 * skill, updates pinned to the source they came from, local edits detectable
 * via content hash.
 */

export const MARKETPLACE_LOCK_FILENAME = '.webui-marketplace-lock.json'

const MAX_INSTALL_BYTES = 100 * 1024 * 1024 // 100MB per skill
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export class MarketplaceInstallError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export type MarketplaceInstallKind = 'skill' | 'plugin'

export interface MarketplaceLockEntry {
  sourceId: number
  sourceName: string
  url: string
  plugin: string
  skill: string
  version: string
  contentHash: string
  installedAt: string
  updatedAt: string
  installKind: MarketplaceInstallKind
}

export type MarketplaceLock = Record<string, MarketplaceLockEntry>

export async function readMarketplaceLock(skillsDir: string): Promise<MarketplaceLock> {
  try {
    const raw = await readFile(join(skillsDir, MARKETPLACE_LOCK_FILENAME), 'utf-8')
    const data = JSON.parse(raw)
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const out: MarketplaceLock = {}
      for (const [name, entry] of Object.entries(data as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as Record<string, unknown>
        if (typeof e.sourceId !== 'number' || typeof e.skill !== 'string') continue
        out[name] = {
          sourceId: e.sourceId,
          sourceName: String(e.sourceName || ''),
          url: String(e.url || ''),
          plugin: String(e.plugin || ''),
          skill: String(e.skill || name),
          version: String(e.version || ''),
          contentHash: String(e.contentHash || ''),
          installedAt: String(e.installedAt || ''),
          updatedAt: String(e.updatedAt || ''),
          installKind: e.installKind === 'plugin' ? 'plugin' : 'skill',
        }
      }
      return out
    }
  } catch { /* absent or invalid → empty lock */ }
  return {}
}

async function writeMarketplaceLock(skillsDir: string, lock: MarketplaceLock): Promise<void> {
  const payload = Object.keys(lock).length === 0
    ? '{}'
    : JSON.stringify(lock, null, 2)
  await writeFile(join(skillsDir, MARKETPLACE_LOCK_FILENAME), `${payload}\n`, 'utf-8')
}

/** md5 over sorted (path, content) pairs — same discipline as the skills dirHash. */
async function directoryHash(dir: string): Promise<string> {
  const hasher = createHash('md5')
  const files: string[] = []
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === MARKETPLACE_LOCK_FILENAME) continue
      const entryPath = join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(entryPath, rel)
      else if (entry.isFile()) files.push(rel)
    }
  }
  await walk(dir, '')
  files.sort()
  for (const rel of files) {
    hasher.update(rel)
    hasher.update(await readFile(join(dir, rel)))
  }
  return hasher.digest('hex')
}

/**
 * Copy a skill directory. Symlinks are only materialised when they resolve
 * inside the source skill dir — everything else (and FIFOs etc.) is skipped,
 * so a hostile repo cannot smuggle absolute-path links into the skills tree.
 */
async function copyPackageDir(sourceDir: string, targetDir: string): Promise<void> {
  const sourceRoot = resolve(sourceDir)
  let totalBytes = 0
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (['.git', '.pytest_cache', '__pycache__', 'node_modules'].includes(entry.name)) continue
      const entryPath = join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const info = await lstat(entryPath)
      if (info.isDirectory()) {
        await mkdir(join(targetDir, rel), { recursive: true })
        await walk(entryPath, rel)
      } else if (info.isFile()) {
        totalBytes += info.size
        if (totalBytes > MAX_INSTALL_BYTES) {
          throw new MarketplaceInstallError(`Package is too large to install (max ${MAX_INSTALL_BYTES / 1024 / 1024}MB)`, 413)
        }
        const dest = join(targetDir, rel)
        await mkdir(resolve(dest, '..'), { recursive: true })
        await copyFile(entryPath, dest)
      } else if (info.isSymbolicLink()) {
        const resolvedTarget = await realpath(entryPath).catch(() => null)
        if (!resolvedTarget || !isPathWithin(resolvedTarget, sourceRoot)) continue
        const statResult = await stat(resolvedTarget)
        if (statResult.isDirectory()) {
          await mkdir(join(targetDir, rel), { recursive: true })
          await walk(resolvedTarget, rel)
        } else if (statResult.isFile()) {
          totalBytes += statResult.size
          const dest = join(targetDir, rel)
          await mkdir(resolve(dest, '..'), { recursive: true })
          await copyFile(resolvedTarget, dest)
        }
      }
    }
  }
  await mkdir(targetDir, { recursive: true })
  await walk(sourceRoot, '')
}

export interface InstallSkillInput {
  source: MarketplaceSourceRecord
  repoDir: string
  skillsDir: string
  plugin: string
  skill: string
  /** version recorded in the lock */
  version?: string
}

export interface InstallSkillResult {
  skill: string
  plugin: string
  installKind: MarketplaceInstallKind
  updated: boolean
  installPath: string
  version: string
  contentHash: string
}

export async function installMarketplaceSkill(input: InstallSkillInput): Promise<InstallSkillResult> {
  const { source, repoDir, skillsDir, plugin, skill } = input
  if (!SKILL_NAME_PATTERN.test(plugin) || !SKILL_NAME_PATTERN.test(skill)) {
    throw new MarketplaceInstallError('Invalid plugin or skill name', 400)
  }
  const sourceDir = await resolvePluginSkillDir(repoDir, plugin, skill)
  if (!sourceDir) {
    throw new MarketplaceInstallError(`Skill "${skill}" was not found in plugin "${plugin}"`, 404)
  }

  const targetDir = join(resolve(skillsDir), skill)
  if (!isPathWithin(targetDir, resolve(skillsDir))) {
    throw new MarketplaceInstallError('Invalid install path', 400)
  }

  const lock = await readMarketplaceLock(skillsDir)
  const existingEntry = lock[skill]
  let targetExists = false
  try {
    targetExists = (await stat(targetDir)).isDirectory()
  } catch { /* absent */ }

  if (targetExists && !existingEntry) {
    throw new MarketplaceInstallError(
      `A skill named "${skill}" already exists in this profile and is not marketplace-managed. Remove it first if you want to replace it.`,
      409,
    )
  }
  if (existingEntry && existingEntry.sourceId !== source.id) {
    throw new MarketplaceInstallError(
      `"${skill}" is installed from source "${existingEntry.sourceName}". Uninstall it before installing from "${source.name}".`,
      409,
    )
  }

  await mkdir(skillsDir, { recursive: true })
  await rm(targetDir, { recursive: true, force: true })
  try {
    await copyPackageDir(sourceDir, targetDir)
  } catch (err) {
    // Roll back to the previous state on a failed copy.
    await rm(targetDir, { recursive: true, force: true })
    if (existingEntry) {
      // The old tree is already gone; the lock entry is removed with it.
      delete lock[skill]
      await writeMarketplaceLock(skillsDir, lock)
    }
    throw err
  }

  const contentHash = await directoryHash(targetDir)
  const now = new Date().toISOString()
  lock[skill] = {
    sourceId: source.id,
    sourceName: source.name,
    url: source.url,
    plugin,
    skill,
    version: input.version || '',
    contentHash,
    installedAt: existingEntry?.installedAt || now,
    updatedAt: now,
    installKind: 'skill',
  }
  await writeMarketplaceLock(skillsDir, lock)

  return {
    skill,
    plugin,
    installKind: 'skill',
    updated: !!existingEntry,
    installPath: targetDir,
    version: input.version || '',
    contentHash,
  }
}

export interface InstallPluginInput {
  source: MarketplaceSourceRecord
  repoDir: string
  profileDir: string
  plugin: string
  version?: string
}

async function updateProfilePluginConfig(profileDir: string, pluginName: string, enabled: boolean): Promise<void> {
  await safeFileStore.updateYaml(join(profileDir, 'config.yaml'), (config) => {
    const plugins = config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? config.plugins
      : {}
    const currentEnabled: string[] = Array.isArray(plugins.enabled) ? plugins.enabled.map(String) : []
    const currentDisabled: string[] = Array.isArray(plugins.disabled) ? plugins.disabled.map(String) : []
    plugins.enabled = enabled
      ? Array.from(new Set([...currentEnabled, pluginName])).sort()
      : currentEnabled.filter(name => name !== pluginName)
    plugins.disabled = currentDisabled.filter(name => name !== pluginName)
    config.plugins = plugins
    return config
  }, { backup: true, dumpOptions: { forceQuotes: true } })
}

async function restoreFile(path: string, previous: string | null): Promise<void> {
  if (previous === null) {
    await rm(path, { force: true })
  } else {
    await writeFile(path, previous, 'utf-8')
  }
}

export async function installMarketplacePlugin(input: InstallPluginInput): Promise<InstallSkillResult> {
  const { source, repoDir, profileDir, plugin } = input
  if (!SKILL_NAME_PATTERN.test(plugin)) {
    throw new MarketplaceInstallError('Invalid plugin name', 400)
  }
  const sourceDir = await resolvePortablePluginDir(repoDir, plugin)
  if (!sourceDir) {
    throw new MarketplaceInstallError(`Portable plugin "${plugin}" was not found`, 404)
  }

  const resolvedProfileDir = resolve(profileDir)
  const skillsDir = join(resolvedProfileDir, 'skills')
  const pluginsDir = join(resolvedProfileDir, 'plugins')
  const targetDir = join(pluginsDir, plugin)
  if (!isPathWithin(targetDir, pluginsDir)) {
    throw new MarketplaceInstallError('Invalid install path', 400)
  }

  const lock = await readMarketplaceLock(skillsDir)
  const existingEntry = lock[plugin]
  if (existingEntry && existingEntry.sourceId !== source.id) {
    throw new MarketplaceInstallError(
      `"${plugin}" is installed from source "${existingEntry.sourceName}". Uninstall it before installing from "${source.name}".`,
      409,
    )
  }
  let targetExists = false
  try { targetExists = (await stat(targetDir)).isDirectory() } catch { /* absent */ }
  if (targetExists && existingEntry?.installKind !== 'plugin') {
    throw new MarketplaceInstallError(
      `A plugin named "${plugin}" already exists in this profile and is not marketplace-managed. Remove it first if you want to replace it.`,
      409,
    )
  }

  await mkdir(skillsDir, { recursive: true })
  await mkdir(pluginsDir, { recursive: true })
  const transactionId = randomUUID()
  const stagingDir = join(pluginsDir, `.marketplace-${plugin}-${transactionId}`)
  const backupDir = join(pluginsDir, `.marketplace-backup-${plugin}-${transactionId}`)
  const configPath = join(resolvedProfileDir, 'config.yaml')
  const previousConfig = await readFile(configPath, 'utf-8').catch(() => null)
  let backedUp = false
  let installed = false

  try {
    await copyPackageDir(sourceDir, stagingDir)
    const contentHash = await directoryHash(stagingDir)
    if (targetExists) {
      await rename(targetDir, backupDir)
      backedUp = true
    }
    await rename(stagingDir, targetDir)
    installed = true
    await updateProfilePluginConfig(resolvedProfileDir, plugin, true)

    const now = new Date().toISOString()
    lock[plugin] = {
      sourceId: source.id,
      sourceName: source.name,
      url: source.url,
      plugin,
      skill: plugin,
      version: input.version || '',
      contentHash,
      installedAt: existingEntry?.installedAt || now,
      updatedAt: now,
      installKind: 'plugin',
    }
    await writeMarketplaceLock(skillsDir, lock)

    if (existingEntry?.installKind === 'skill') {
      await rm(join(skillsDir, existingEntry.skill), { recursive: true, force: true })
    }
    if (backedUp) await rm(backupDir, { recursive: true, force: true })
    return {
      skill: plugin,
      plugin,
      installKind: 'plugin',
      updated: !!existingEntry || targetExists,
      installPath: targetDir,
      version: input.version || '',
      contentHash,
    }
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true })
    if (installed) await rm(targetDir, { recursive: true, force: true })
    if (backedUp) await rename(backupDir, targetDir).catch(() => undefined)
    await restoreFile(configPath, previousConfig).catch(() => undefined)
    throw err
  }
}

export async function uninstallMarketplaceSkill(skillsDir: string, skill: string): Promise<MarketplaceLockEntry> {
  if (!SKILL_NAME_PATTERN.test(skill)) {
    throw new MarketplaceInstallError('Invalid skill name', 400)
  }
  const lock = await readMarketplaceLock(skillsDir)
  const entry = lock[skill]
  if (!entry) {
    throw new MarketplaceInstallError(`Skill "${skill}" is not marketplace-managed`, 404)
  }
  const resolvedSkillsDir = resolve(skillsDir)
  const profileDir = resolve(resolvedSkillsDir, '..')
  const targetDir = entry.installKind === 'plugin'
    ? join(profileDir, 'plugins', entry.plugin)
    : join(resolvedSkillsDir, skill)
  if (entry.installKind === 'plugin') {
    await updateProfilePluginConfig(profileDir, entry.plugin, false)
  }
  await rm(targetDir, { recursive: true, force: true })
  delete lock[skill]
  await writeMarketplaceLock(skillsDir, lock)
  return entry
}

export interface InstalledSkillInfo {
  skill: string
  sourceId: number
  sourceName: string
  plugin: string
  version: string
  installedAt: string
  updatedAt: string
  /** true when the on-disk tree no longer matches the recorded hash */
  modified: boolean
  installPath: string
  installKind: MarketplaceInstallKind
}

export async function listMarketplaceInstalled(skillsDir: string): Promise<InstalledSkillInfo[]> {
  const lock = await readMarketplaceLock(skillsDir)
  const out: InstalledSkillInfo[] = []
  for (const [name, entry] of Object.entries(lock)) {
    const resolvedSkillsDir = resolve(skillsDir)
    const installPath = entry.installKind === 'plugin'
      ? join(resolve(resolvedSkillsDir, '..'), 'plugins', entry.plugin)
      : join(resolvedSkillsDir, name)
    let exists = false
    try {
      exists = (await stat(installPath)).isDirectory()
    } catch { /* gone */ }
    const modified = exists && entry.contentHash
      ? (await directoryHash(installPath).catch(() => '')) !== entry.contentHash
      : false
    if (!exists) continue
    out.push({
      skill: name,
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      plugin: entry.plugin,
      version: entry.version,
      installedAt: entry.installedAt,
      updatedAt: entry.updatedAt,
      modified,
      installPath,
      installKind: entry.installKind,
    })
  }
  out.sort((a, b) => a.skill.localeCompare(b.skill))
  return out
}
