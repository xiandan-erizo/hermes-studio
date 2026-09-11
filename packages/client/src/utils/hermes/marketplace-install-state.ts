import type { MarketplaceInstalledSkill } from '@/api/hermes/marketplace'

export function findMarketplacePluginInstall(
  pluginName: string,
  installed: MarketplaceInstalledSkill[],
): MarketplaceInstalledSkill | null {
  return installed.find(entry => entry.installKind === 'plugin' && entry.plugin === pluginName) || null
}

export function findMarketplaceSkillInstall(
  pluginName: string,
  skillName: string,
  portable: boolean,
  installed: MarketplaceInstalledSkill[],
): MarketplaceInstalledSkill | null {
  if (portable) return findMarketplacePluginInstall(pluginName, installed)
  return installed.find(entry => entry.installKind !== 'plugin' && entry.skill === skillName) || null
}
