import Router from '@koa/router'
import * as ctrl from '../controllers/upload'
import { requireScopedProfile } from '../public/auth'

export const uploadRoutes = new Router()

uploadRoutes.post('/api/studio/uploads', requireScopedProfile, ctrl.handleUpload)
