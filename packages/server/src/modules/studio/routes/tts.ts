import Router from '@koa/router'
import * as ctrl from '../controllers/tts'
import { requireAdmin, requirePathProfileAccess, requireScopedProfile } from '../public/auth'

export const ttsRoutes = new Router()
export const ttsProtectedRoutes = new Router()

ttsRoutes.post('/api/studio/tts', ctrl.generate)
ttsRoutes.post('/api/tts/proxy/audio/speech', ctrl.openaiProxy)
ttsRoutes.get('/api/studio/mcu/audio/:file', ctrl.mcuAudio)

ttsProtectedRoutes.get('/api/studio/tts/settings', requireScopedProfile, ctrl.listSettings)
ttsProtectedRoutes.post('/api/studio/voice/proxy/:profile/v1/tts', requirePathProfileAccess, ctrl.synthesizeVoiceProxy)
ttsProtectedRoutes.post('/api/studio/voice/proxy/:profile/v1/audio/speech', requirePathProfileAccess, ctrl.synthesizeVoiceProxyOpenAi)
ttsProtectedRoutes.put('/api/studio/tts/settings/active', requireAdmin, requireScopedProfile, ctrl.saveActiveProvider)
ttsProtectedRoutes.put('/api/studio/tts/settings/:provider', requireAdmin, requireScopedProfile, ctrl.saveSettings)
ttsProtectedRoutes.delete('/api/studio/tts/settings/:provider', requireAdmin, requireScopedProfile, ctrl.deleteProvider)
ttsProtectedRoutes.delete('/api/studio/tts/settings/:provider/base-url-preset', requireAdmin, requireScopedProfile, ctrl.deleteBaseUrlPreset)
ttsProtectedRoutes.delete('/api/studio/tts/settings/:provider/secret/:secretName', requireAdmin, requireScopedProfile, ctrl.deleteSecret)
ttsProtectedRoutes.post('/api/voice/providers/probe', requireAdmin, requireScopedProfile, ctrl.probeProvider)
ttsProtectedRoutes.post('/api/studio/tts/synthesize', requireScopedProfile, ctrl.synthesize)
