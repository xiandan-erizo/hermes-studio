import { join } from 'path'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import {
  findMarketplaceSource,
  listMarketplaceSources,
  recordSourceSync,
  createMarketplaceSource,
  deleteMarketplaceSource,
  updateMarketplaceSource,
  MarketplaceSourceConflictError,
  MarketplaceSourceValidationError,
  type MarketplaceSourceRecord,
} from '../services/marketplace/sources-store'
import {
  cachedCommit,
  marketplaceCacheDir,
  removeCache,
  syncSource,
  validateGitSshUrl,
  MarketplaceGitError,
  MarketplaceUrlError,
} from '../services/marketplace/git-cache'
import {
  readPluginDetail,
  scanMarketplaceRepo,
  MarketplaceParseError,
  type MarketplacePlugin,
} from '../services/marketplace/repo-scanner'
import {
  installMarketplaceSkill,
  listMarketplaceInstalled,
  uninstallMarketplaceSkill,
  MarketplaceInstallError,
} from '../services/marketplace/install'
import { logger } from '../../studio/public/logging'

/**
 * Plugin marketplace ("插件中心") controllers.
 *
 * Browse + install live in the authenticated user zone: every logged-in user
 * may read the catalog and install into their active profile. Source CRUD and
 * refresh are mounted separately in the management zone (see
 * routes/marketplace.ts and bootstrap/routes.ts).
 */

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function requestSkillsDir(ctx: any): string {
  return join(getProfileDir(requestedProfile(ctx)), 'skills')
}

function sourceIdParam(ctx: any): number | null {
  const raw = String((ctx.params as any)?.id || '')
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

interface SourceDto {
  id: number
  name: string
  url: string
  enabled: boolean
  lastSyncedAt: number | null
  lastCommit: string | null
  lastError: string | null
}

function toSourceDto(record: MarketplaceSourceRecord, pluginCount?: number): SourceDto & { pluginCount?: number } {
  const dto: SourceDto & { pluginCount?: number } = {
    id: record.id,
    name: record.name,
    url: record.url,
    enabled: !!record.enabled,
    lastSyncedAt: record.last_synced_at,
    lastCommit: record.last_commit,
    lastError: record.last_error,
  }
  if (pluginCount !== undefined) dto.pluginCount = pluginCount
  return dto
}

async function pluginsFromCache(source: MarketplaceSourceRecord, ensureClone: boolean): Promise<MarketplacePlugin[]> {
  const dir = marketplaceCacheDir(source.id)
  if (!ensureClone) {
    const commit = await cachedCommit(source.id)
    if (!commit) throw new MarketplaceParseError('Source has not been synced yet')
    return scanMarketplaceRepo(dir)
  }
  try {
    const { commit } = await syncSource(source.id, source.url, 'ensure')
    recordSourceSync(source.id, { commit })
    return scanMarketplaceRepo(dir)
  } catch (err: any) {
    recordSourceSync(source.id, { error: err?.message })
    throw err
  }
}

/** GET /api/hermes/marketplace/sources — list sources with catalog status. */
export async function listSources(ctx: any) {
  const records = listMarketplaceSources()
  if (records === null) {
    ctx.status = 503
    ctx.body = { error: 'Marketplace storage is unavailable' }
    return
  }
  const dtos = []
  for (const record of records) {
    let pluginCount: number | undefined
    try {
      pluginCount = (await pluginsFromCache(record, false)).length
    } catch { /* not synced or unparseable — surfaced via lastError */ }
    dtos.push(toSourceDto(record, pluginCount))
  }
  ctx.body = { sources: dtos }
}

/** GET /api/hermes/marketplace/sources/:id/plugins — browse the catalog. */
export async function listPlugins(ctx: any) {
  const id = sourceIdParam(ctx)
  const source = id ? findMarketplaceSource(id) : null
  if (!source) {
    ctx.status = 404
    ctx.body = { error: 'Marketplace source not found' }
    return
  }
  if (!source.enabled) {
    ctx.status = 409
    ctx.body = { error: `Source "${source.name}" is disabled` }
    return
  }
  try {
    const plugins = await pluginsFromCache(source, true)
    ctx.body = {
      source: toSourceDto(source, plugins.length),
      plugins,
    }
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: `Failed to read marketplace source: ${err?.message || err}` }
  }
}

/** GET /api/hermes/marketplace/sources/:id/plugins/:plugin — plugin detail with SKILL.md bodies. */
export async function pluginDetail(ctx: any) {
  const id = sourceIdParam(ctx)
  const source = id ? findMarketplaceSource(id) : null
  if (!source) {
    ctx.status = 404
    ctx.body = { error: 'Marketplace source not found' }
    return
  }
  const pluginName = String((ctx.params as any)?.plugin || '')
  try {
    await pluginsFromCache(source, true)
    const detail = await readPluginDetail(marketplaceCacheDir(source.id), pluginName)
    if (!detail) {
      ctx.status = 404
      ctx.body = { error: `Plugin "${pluginName}" was not found` }
      return
    }
    ctx.body = { source: toSourceDto(source), plugin: detail }
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: `Failed to read plugin detail: ${err?.message || err}` }
  }
}

/** POST /api/hermes/marketplace/install — { sourceId, plugin, skill }. */
export async function install(ctx: any) {
  const body = (ctx.request.body || {}) as { sourceId?: unknown; plugin?: unknown; skill?: unknown }
  const sourceId = Number(body.sourceId)
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    ctx.status = 400
    ctx.body = { error: 'sourceId is required' }
    return
  }
  const plugin = String(body.plugin || '').trim()
  const skill = String(body.skill || '').trim()
  if (!plugin || !skill) {
    ctx.status = 400
    ctx.body = { error: 'plugin and skill are required' }
    return
  }
  const source = findMarketplaceSource(sourceId)
  if (!source) {
    ctx.status = 404
    ctx.body = { error: 'Marketplace source not found' }
    return
  }
  if (!source.enabled) {
    ctx.status = 409
    ctx.body = { error: `Source "${source.name}" is disabled` }
    return
  }

  try {
    // Make sure the cache exists and records what we install from.
    const { commit } = await syncSource(source.id, source.url, 'ensure')
    recordSourceSync(source.id, { commit })
    let version = ''
    try {
      const detail = await readPluginDetail(marketplaceCacheDir(source.id), plugin)
      version = detail?.version || ''
    } catch { /* version is best-effort provenance */ }

    const result = await installMarketplaceSkill({
      source,
      repoDir: marketplaceCacheDir(source.id),
      skillsDir: requestSkillsDir(ctx),
      plugin,
      skill,
      version,
    })
    logger.info(`[marketplace] installed skill "${skill}" from source "${source.name}" for profile "${requestedProfile(ctx)}"`)
    ctx.body = { success: true, ...result }
  } catch (err: any) {
    if (err instanceof MarketplaceInstallError) {
      ctx.status = err.status
      ctx.body = { error: err.message }
      return
    }
    ctx.status = 502
    ctx.body = { error: `Install failed: ${err?.message || err}` }
  }
}

/** GET /api/hermes/marketplace/installed — marketplace-managed skills of the active profile. */
export async function listInstalled(ctx: any) {
  try {
    ctx.body = {
      profile: requestedProfile(ctx),
      skillsDir: requestSkillsDir(ctx),
      installed: await listMarketplaceInstalled(requestSkillsDir(ctx)),
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

/** DELETE /api/hermes/marketplace/installed/:skill */
export async function uninstall(ctx: any) {
  const skill = String((ctx.params as any)?.skill || '')
  try {
    await uninstallMarketplaceSkill(requestSkillsDir(ctx), skill)
    ctx.body = { success: true }
  } catch (err: any) {
    if (err instanceof MarketplaceInstallError) {
      ctx.status = err.status
      ctx.body = { error: err.message }
      return
    }
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

// ---------------------------------------------------------------------------
// Management-zone controllers (admin / super_admin)
// ---------------------------------------------------------------------------

/** POST /api/hermes/marketplace/sources — { name, url } (git SSH only). */
export async function createSource(ctx: any) {
  const body = (ctx.request.body || {}) as { name?: unknown; url?: unknown }
  try {
    const url = validateGitSshUrl(String(body.url || ''))
    const created = createMarketplaceSource({ name: String(body.name || ''), url })
    if (created === null) {
      ctx.status = 503
      ctx.body = { error: 'Marketplace storage is unavailable' }
      return
    }
    if ('conflict' in created) {
      ctx.status = 409
      ctx.body = { error: 'A source with this URL already exists' }
      return
    }
    // Initial sync: failures are recorded on the source, not fatal.
    let syncError: string | null = null
    try {
      const { commit } = await syncSource(created.id, created.url, 'ensure')
      recordSourceSync(created.id, { commit })
    } catch (err: any) {
      syncError = String(err?.message || err)
      recordSourceSync(created.id, { error: syncError })
      logger.warn(`[marketplace] initial sync failed for source ${created.id}: ${syncError}`)
    }
    ctx.status = 201
    ctx.body = { source: toSourceDto(findMarketplaceSource(created.id)!, syncError ? 0 : undefined), syncError }
  } catch (err: any) {
    if (err instanceof MarketplaceUrlError || err instanceof MarketplaceSourceValidationError) {
      ctx.status = 400
      ctx.body = { error: err.message }
      return
    }
    if (err instanceof MarketplaceSourceConflictError) {
      ctx.status = 409
      ctx.body = { error: err.message }
      return
    }
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

/** PUT /api/hermes/marketplace/sources/:id — { name?, enabled? }. */
export async function updateSource(ctx: any) {
  const id = sourceIdParam(ctx)
  const existing = id ? findMarketplaceSource(id) : null
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Marketplace source not found' }
    return
  }
  const body = (ctx.request.body || {}) as { name?: unknown; enabled?: unknown }
  try {
    const updated = updateMarketplaceSource(existing.id, {
      name: body.name !== undefined ? String(body.name) : undefined,
      enabled: body.enabled !== undefined ? !!body.enabled : undefined,
    })
    ctx.body = { source: toSourceDto(updated!) }
  } catch (err: any) {
    if (err instanceof MarketplaceSourceValidationError) {
      ctx.status = 400
      ctx.body = { error: err.message }
      return
    }
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

/** DELETE /api/hermes/marketplace/sources/:id — removes record + git cache. */
export async function deleteSource(ctx: any) {
  const id = sourceIdParam(ctx)
  const existing = id ? findMarketplaceSource(id) : null
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Marketplace source not found' }
    return
  }
  try {
    removeCache(existing.id)
  } catch { /* cache removal is best-effort */ }
  if (!deleteMarketplaceSource(existing.id)) {
    ctx.status = 500
    ctx.body = { error: 'Failed to delete marketplace source' }
    return
  }
  ctx.body = { success: true }
}

/** POST /api/hermes/marketplace/sources/:id/refresh — git fetch + rescan. */
export async function refreshSource(ctx: any) {
  const id = sourceIdParam(ctx)
  const source = id ? findMarketplaceSource(id) : null
  if (!source) {
    ctx.status = 404
    ctx.body = { error: 'Marketplace source not found' }
    return
  }
  try {
    const { commit, cloned } = await syncSource(source.id, source.url, 'refresh')
    const plugins = await scanMarketplaceRepo(marketplaceCacheDir(source.id))
    recordSourceSync(source.id, { commit })
    ctx.body = { source: toSourceDto(source, plugins.length), cloned, commit }
  } catch (err: any) {
    recordSourceSync(source.id, { error: err?.message })
    ctx.status = 502
    ctx.body = { error: `Refresh failed: ${err instanceof MarketplaceGitError ? err.message : (err?.message || err)}` }
  }
}
