import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join, resolve } from 'path'
import { isPathWithin } from '../runtime/path'
import { resolvePluginSkillDir } from './repo-scanner'
import type { MarketplaceSourceRecord } from './sources-store'

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
async function copySkillDir(sourceDir: string, targetDir: string): Promise<void> {
  const sourceRoot = resolve(sourceDir)
  let totalBytes = 0
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.pytest_cache' || entry.name === '__pycache__') continue
      const entryPath = join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const info = await lstat(entryPath)
      if (info.isDirectory()) {
        await mkdir(join(targetDir, rel), { recursive: true })
        await walk(entryPath, rel)
      } else if (info.isFile()) {
        totalBytes += info.size
        if (totalBytes > MAX_INSTALL_BYTES) {
          throw new MarketplaceInstallError(`Skill is too large to install (max ${MAX_INSTALL_BYTES / 1024 / 1024}MB)`, 413)
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
    await copySkillDir(sourceDir, targetDir)
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
  }
  await writeMarketplaceLock(skillsDir, lock)

  return { skill, updated: !!existingEntry, installPath: targetDir, version: input.version || '', contentHash }
}

export async function uninstallMarketplaceSkill(skillsDir: string, skill: string): Promise<void> {
  if (!SKILL_NAME_PATTERN.test(skill)) {
    throw new MarketplaceInstallError('Invalid skill name', 400)
  }
  const lock = await readMarketplaceLock(skillsDir)
  const entry = lock[skill]
  if (!entry) {
    throw new MarketplaceInstallError(`Skill "${skill}" is not marketplace-managed`, 404)
  }
  const targetDir = join(resolve(skillsDir), skill)
  await rm(targetDir, { recursive: true, force: true })
  delete lock[skill]
  await writeMarketplaceLock(skillsDir, lock)
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
}

export async function listMarketplaceInstalled(skillsDir: string): Promise<InstalledSkillInfo[]> {
  const lock = await readMarketplaceLock(skillsDir)
  const out: InstalledSkillInfo[] = []
  for (const [name, entry] of Object.entries(lock)) {
    const installPath = join(resolve(skillsDir), name)
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
    })
  }
  out.sort((a, b) => a.skill.localeCompare(b.skill))
  return out
}
