import Router from '@koa/router'
import * as ctrl from '../controllers/media'
import { requireScopedProfile } from '../public/auth'

export const mediaRoutes = new Router()

mediaRoutes.post('/api/studio/media/grok-image-to-video', requireScopedProfile, ctrl.grokImageToVideo)
mediaRoutes.post('/api/studio/media/apikey-image-generate', requireScopedProfile, ctrl.apiKeyImageGenerate)
mediaRoutes.post('/api/studio/media/minimax-image-to-video', requireScopedProfile, ctrl.miniMaxImageToVideo)
