import { request } from '../client'

/** Plugin marketplace ("插件中心") — browse configured git sources and install skills. */

export interface MarketplacePluginInterface {
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
  interface?: MarketplacePluginInterface
  skills: MarketplaceSkillSummary[]
}

export interface MarketplaceSkillDetail extends MarketplaceSkillSummary {
  content: string
  files: string[]
}

export interface MarketplacePluginDetail extends Omit<MarketplacePlugin, 'skills'> {
  skills: MarketplaceSkillDetail[]
}

export interface MarketplaceSource {
  id: number
  name: string
  url: string
  enabled: boolean
  lastSyncedAt: number | null
  lastCommit: string | null
  lastError: string | null
  pluginCount?: number
}

export interface MarketplaceInstalledSkill {
  skill: string
  sourceId: number
  sourceName: string
  plugin: string
  version: string
  installedAt: string
  updatedAt: string
  modified: boolean
  installPath: string
}

export interface MarketplaceInstallResult {
  success: boolean
  skill: string
  updated: boolean
  installPath: string
  version: string
  contentHash: string
}

export async function fetchMarketplaceSources(): Promise<MarketplaceSource[]> {
  const data = await request<{ sources: MarketplaceSource[] }>('/api/hermes/marketplace/sources')
  return data.sources || []
}

export async function fetchMarketplacePlugins(sourceId: number): Promise<MarketplacePlugin[]> {
  const data = await request<{ plugins: MarketplacePlugin[] }>(
    `/api/hermes/marketplace/sources/${sourceId}/plugins`,
  )
  return data.plugins || []
}

export async function fetchMarketplacePluginDetail(
  sourceId: number,
  plugin: string,
): Promise<MarketplacePluginDetail | null> {
  const data = await request<{ plugin: MarketplacePluginDetail | null }>(
    `/api/hermes/marketplace/sources/${sourceId}/plugins/${encodeURIComponent(plugin)}`,
  )
  return data.plugin || null
}

export async function fetchMarketplaceInstalled(): Promise<MarketplaceInstalledSkill[]> {
  const data = await request<{ installed: MarketplaceInstalledSkill[] }>('/api/hermes/marketplace/installed')
  return data.installed || []
}

export async function installMarketplaceSkill(sourceId: number, plugin: string, skill: string): Promise<MarketplaceInstallResult> {
  return request<MarketplaceInstallResult>('/api/hermes/marketplace/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, plugin, skill }),
  })
}

export async function uninstallMarketplaceSkill(skill: string): Promise<void> {
  await request<{ success: boolean }>(`/api/hermes/marketplace/installed/${encodeURIComponent(skill)}`, {
    method: 'DELETE',
  })
}

// --- Management (admin / super_admin zone) ---

export async function createMarketplaceSource(name: string, url: string): Promise<{ source: MarketplaceSource; syncError: string | null }> {
  return request<{ source: MarketplaceSource; syncError: string | null }>('/api/hermes/marketplace/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url }),
  })
}

export async function updateMarketplaceSource(id: number, patch: { name?: string; enabled?: boolean }): Promise<MarketplaceSource> {
  const data = await request<{ source: MarketplaceSource }>(`/api/hermes/marketplace/sources/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return data.source
}

export async function deleteMarketplaceSource(id: number): Promise<void> {
  await request<{ success: boolean }>(`/api/hermes/marketplace/sources/${id}`, { method: 'DELETE' })
}

export async function refreshMarketplaceSource(id: number): Promise<MarketplaceSource> {
  const data = await request<{ source: MarketplaceSource }>(`/api/hermes/marketplace/sources/${id}/refresh`, {
    method: 'POST',
  })
  return data.source
}
