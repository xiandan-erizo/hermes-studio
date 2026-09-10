import Router from '@koa/router'
import * as ctrl from '../controllers/app-upload'
import { requireScopedProfile } from '../public/auth'

export const appUploadRoutes = new Router()

appUploadRoutes.post('/api/studio/app-uploads', requireScopedProfile, ctrl.open)
appUploadRoutes.put('/api/studio/app-uploads/:id/chunks', requireScopedProfile, ctrl.appendChunk)
appUploadRoutes.post('/api/studio/app-uploads/:id/complete', requireScopedProfile, ctrl.complete)
appUploadRoutes.delete('/api/studio/app-uploads/:id', requireScopedProfile, ctrl.abort)
