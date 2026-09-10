import Router from '@koa/router'
import * as ctrl from '../controllers/chat-run'
import { requireScopedProfile } from '../public/auth'
export { getChatRunServer, setChatRunServer } from '../public/chat-run'

export const chatRunRoutes = new Router()

chatRunRoutes.post('/api/studio/chat-run/runs', requireScopedProfile, ctrl.runOnce)
