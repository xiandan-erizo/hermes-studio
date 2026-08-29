import { readFile, readdir, stat } from 'fs/promises'
import { join, resolve } from 'path'
import YAML from 'js-yaml'
import { isPathWithin } from '../runtime/path'

/**
 * Parser for hose-skills style plugin marketplace repositories.
 *
 * Layout (single repo, multiple plugins — validated by the repo's own CI):
 *   plugins/<plugin>/.codex-plugin/plugin.json   — name/version/description/author/interface
 *   plugins/<plugin>/skills/<skill>/SKILL.md     — Claude skill format with frontmatter
 *
 * We deliberately re-derive the catalog from the primary artifacts instead of
 * trusting the generated marketplace.json files: generation can lag behind a
 * merge, while plugin.json/SKILL.md are always authoritative.
 */

export interface PluginInterfaceInfo {
  displayName?: string
  shortDescription?: string
  longDescription?: string
  developerName?: string
  category?: string
  capabilities?: string[]
  defaultPrompt?: string[]
}

export interface MarketplaceSkillSummary {
  name: string
  description: string
  allowedTools?: string[]
}

export interface MarketplacePlugin {
  name: string
  version: string
  description: string
  author?: string
  interface?: PluginInterfaceInfo
  skills: MarketplaceSkillSummary[]
}

export interface MarketplaceSkillDetail extends MarketplaceSkillSummary {
  /** SKILL.md body (content below the frontmatter block) */
  content: string
  /** Relative file paths inside the skill directory */
  files: string[]
}

export interface MarketplacePluginDetail extends MarketplacePlugin {
  skills: MarketplaceSkillDetail[]
}

const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_MD_BYTES = 1024 * 1024
const MAX_FILES_LISTED = 2000

export class MarketplaceParseError extends Error {}

/** Minimal frontmatter parser: `---\n<yaml>\n---\n<body>`. */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  if (!text.startsWith('---')) return { data: {}, content: text }
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd === -1) return { data: {}, content: text }
  const rest = text.slice(firstLineEnd + 1)
  // Closing delimiter: the first line that is exactly '---' (or '...')
  const closeMatch = rest.match(/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m)
  if (!closeMatch || closeMatch.index === undefined) return { data: {}, content: text }
  const yamlBlock = rest.slice(0, closeMatch.index)
  const body = rest.slice(closeMatch.index + closeMatch[0].length)
  let data: unknown
  try {
    data = YAML.load(yamlBlock, { json: true }) ?? {}
  } catch {
    return { data: {}, content: text }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { data: {}, content: text }
  return { data: data as Record<string, unknown>, content: body.replace(/^\r?\n/, '') }
}

interface SkillScanResult {
  name: string
  description: string
  allowedTools?: string[]
  skillDir: string
}

async function readPluginManifest(pluginDir: string): Promise<Record<string, unknown> | null> {
  const manifestPath = join(pluginDir, '.codex-plugin', 'plugin.json')
  try {
    const info = await stat(manifestPath)
    if (!info.isFile()) return null
    const parsed = JSON.parse(await readFile(manifestPath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* missing or invalid JSON → treated as absent */ }
  return null
}

async function scanSkillsDir(pluginDir: string, pluginName: string): Promise<SkillScanResult[]> {
  const skillsRoot = join(pluginDir, 'skills')
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    throw new MarketplaceParseError(`plugins/${pluginName}/skills/ is required`)
  }
  const results: SkillScanResult[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillMdPath = join(skillDir, 'SKILL.md')
    let raw: string
    try {
      const info = await stat(skillMdPath)
      if (!info.isFile() || info.size > MAX_SKILL_MD_BYTES) continue
      raw = await readFile(skillMdPath, 'utf-8')
    } catch { /* no SKILL.md → not a skill */ continue }
    const { data } = parseFrontmatter(raw)
    const description = typeof data.description === 'string' ? data.description.trim() : ''
    if (!description) continue
    const allowedTools = Array.isArray(data['allowed-tools'])
      ? data['allowed-tools'].filter((tool): tool is string => typeof tool === 'string')
      : undefined
    results.push({ name: entry.name, description, allowedTools, skillDir })
  }
  if (results.length === 0) {
    throw new MarketplaceParseError(`plugins/${pluginName}/skills/ must contain at least one skill with SKILL.md`)
  }
  return results
}

function pluginFromManifest(
  pluginName: string,
  manifest: Record<string, unknown>,
  skills: SkillScanResult[],
): MarketplacePlugin {
  const iface = (manifest.interface && typeof manifest.interface === 'object'
    ? manifest.interface
    : {}) as Record<string, unknown>
  const author = (manifest.author && typeof manifest.author === 'object'
    ? (manifest.author as Record<string, unknown>).name
    : manifest.author) as string | undefined

  return {
    name: pluginName,
    version: typeof manifest.version === 'string' ? manifest.version : '',
    description: typeof manifest.description === 'string' ? manifest.description : '',
    author: typeof author === 'string' ? author : undefined,
    interface: {
      displayName: typeof iface.displayName === 'string' ? iface.displayName : undefined,
      shortDescription: typeof iface.shortDescription === 'string' ? iface.shortDescription : undefined,
      longDescription: typeof iface.longDescription === 'string' ? iface.longDescription : undefined,
      developerName: typeof iface.developerName === 'string' ? iface.developerName : undefined,
      category: typeof iface.category === 'string' ? iface.category : undefined,
      capabilities: Array.isArray(iface.capabilities)
        ? iface.capabilities.filter((c): c is string => typeof c === 'string')
        : undefined,
      defaultPrompt: Array.isArray(iface.defaultPrompt)
        ? iface.defaultPrompt.filter((p): p is string => typeof p === 'string')
        : undefined,
    },
    skills: skills.map(({ name, description, allowedTools }) => ({ name, description, allowedTools })),
  }
}

/** Scan a checked-out marketplace repository into a plugin catalog. */
export async function scanMarketplaceRepo(repoDir: string): Promise<MarketplacePlugin[]> {
  const pluginsRoot = join(resolve(repoDir), 'plugins')
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(pluginsRoot, { withFileTypes: true })
  } catch {
    throw new MarketplaceParseError(`Repository has no plugins/ directory: ${repoDir}`)
  }

  const plugins: MarketplacePlugin[] = []
  const seenSkills = new Set<string>()
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (!PLUGIN_NAME_PATTERN.test(entry.name)) continue
    const pluginDir = join(pluginsRoot, entry.name)
    const manifest = await readPluginManifest(pluginDir)
    if (!manifest) continue

    const skills = await scanSkillsDir(pluginDir, entry.name)
    for (const skill of skills) {
      if (seenSkills.has(skill.name)) {
        throw new MarketplaceParseError(`Skill ${skill.name} is defined more than once`)
      }
      seenSkills.add(skill.name)
    }
    plugins.push(pluginFromManifest(entry.name, manifest, skills))
  }
  return plugins
}

/** Resolve a plugin's skill directory with path-safety checks, or null. */
export async function resolvePluginSkillDir(
  repoDir: string,
  pluginName: string,
  skillName: string,
): Promise<string | null> {
  if (!PLUGIN_NAME_PATTERN.test(pluginName) || !PLUGIN_NAME_PATTERN.test(skillName)) return null
  const repoRoot = resolve(repoDir)
  const skillDir = resolve(repoRoot, 'plugins', pluginName, 'skills', skillName)
  if (!isPathWithin(skillDir, repoRoot)) return null
  try {
    const info = await stat(join(skillDir, 'SKILL.md'))
    if (!info.isFile()) return null
  } catch { return null }
  return skillDir
}

async function listSkillFiles(skillDir: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_FILES_LISTED) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES_LISTED) return
      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (entry.isFile()) files.push(entryPath.slice(skillDir.length + 1))
    }
  }
  await walk(skillDir)
  return files
}

/** Load full detail for one plugin (all skills with SKILL.md bodies). */
export async function readPluginDetail(repoDir: string, pluginName: string): Promise<MarketplacePluginDetail | null> {
  if (!PLUGIN_NAME_PATTERN.test(pluginName)) return null
  const pluginDir = join(resolve(repoDir), 'plugins', pluginName)
  const manifest = await readPluginManifest(pluginDir)
  if (!manifest) return null
  const scanned = await scanSkillsDir(pluginDir, pluginName).catch(() => [] as SkillScanResult[])
  if (scanned.length === 0) return null

  const summary = pluginFromManifest(pluginName, manifest, scanned)
  const skills: MarketplaceSkillDetail[] = []
  for (const skill of scanned) {
    const raw = await readFile(join(skill.skillDir, 'SKILL.md'), 'utf-8')
    const { content } = parseFrontmatter(raw)
    skills.push({
      name: skill.name,
      description: skill.description,
      allowedTools: skill.allowedTools,
      content,
      files: await listSkillFiles(skill.skillDir),
    })
  }

  return { ...summary, skills }
}
