import Router from '@koa/router'
import * as ctrl from '../controllers/marketplace'

/**
 * Plugin marketplace routes, split by zone:
 *  - marketplaceRoutes       — user zone (browse + install into own profile)
 *  - marketplaceAdminRoutes  — management zone (source CRUD + refresh)
 * Both are mounted in bootstrap/routes.ts.
 */

export const marketplaceRoutes = new Router()

marketplaceRoutes.get('/api/hermes/marketplace/sources', ctrl.listSources)
marketplaceRoutes.get('/api/hermes/marketplace/sources/:id/plugins', ctrl.listPlugins)
marketplaceRoutes.get('/api/hermes/marketplace/sources/:id/plugins/:plugin', ctrl.pluginDetail)
marketplaceRoutes.get('/api/hermes/marketplace/installed', ctrl.listInstalled)
marketplaceRoutes.post('/api/hermes/marketplace/install', ctrl.install)
marketplaceRoutes.delete('/api/hermes/marketplace/installed/:skill', ctrl.uninstall)

export const marketplaceAdminRoutes = new Router()

marketplaceAdminRoutes.post('/api/hermes/marketplace/sources', ctrl.createSource)
marketplaceAdminRoutes.put('/api/hermes/marketplace/sources/:id', ctrl.updateSource)
marketplaceAdminRoutes.delete('/api/hermes/marketplace/sources/:id', ctrl.deleteSource)
marketplaceAdminRoutes.post('/api/hermes/marketplace/sources/:id/refresh', ctrl.refreshSource)
