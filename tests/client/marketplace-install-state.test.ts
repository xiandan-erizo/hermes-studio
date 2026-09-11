import { describe, expect, it } from 'vitest'

import {
  findMarketplacePluginInstall,
  findMarketplaceSkillInstall,
} from '@/utils/hermes/marketplace-install-state'

const installed = [
  {
    skill: 'ticket-intake',
    plugin: 'ticket-intake',
    installKind: 'plugin' as const,
    sourceId: 1,
    sourceName: 'source',
    version: '4.0.0',
    installedAt: 'now',
    updatedAt: 'now',
    modified: false,
    installPath: '/profile/plugins/ticket-intake',
  },
  {
    skill: 'legacy-child',
    plugin: 'legacy-tools',
    installKind: 'skill' as const,
    sourceId: 1,
    sourceName: 'source',
    version: '1.0.0',
    installedAt: 'now',
    updatedAt: 'now',
    modified: false,
    installPath: '/profile/skills/legacy-child',
  },
]

describe('Marketplace install state', () => {
  it('uses one plugin-level install for a portable package', () => {
    expect(findMarketplacePluginInstall('ticket-intake', installed)?.installKind).toBe('plugin')
    expect(findMarketplaceSkillInstall('ticket-intake', 'any-child', true, installed)?.skill).toBe('ticket-intake')
  })

  it('keeps legacy installation scoped to the selected skill', () => {
    expect(findMarketplacePluginInstall('legacy-tools', installed)).toBeNull()
    expect(findMarketplaceSkillInstall('legacy-tools', 'legacy-child', false, installed)?.skill).toBe('legacy-child')
    expect(findMarketplaceSkillInstall('legacy-tools', 'other-child', false, installed)).toBeNull()
  })

  it('does not match a same-named legacy skill from another plugin', () => {
    const duplicate = [{ ...installed[1], plugin: 'other-tools' }, ...installed]
    expect(findMarketplaceSkillInstall('legacy-tools', 'legacy-child', false, duplicate)?.plugin).toBe('legacy-tools')
  })
})
