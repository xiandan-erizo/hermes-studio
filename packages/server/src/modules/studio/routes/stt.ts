import Router from '@koa/router'
import * as ctrl from '../controllers/stt'
import * as localModelCtrl from '../controllers/local-stt-model'
import { requireAdmin, requirePathProfileAccess, requireScopedProfile } from '../public/auth'

export const sttProtectedRoutes = new Router()

sttProtectedRoutes.get('/api/studio/stt/settings', requireScopedProfile, ctrl.listSettings)
sttProtectedRoutes.get('/api/studio/stt/local-model', localModelCtrl.status)
sttProtectedRoutes.post('/api/studio/stt/local-model/download', requireAdmin, localModelCtrl.download)
sttProtectedRoutes.post('/api/studio/voice/proxy/:profile/v1/audio/transcriptions', requirePathProfileAccess, ctrl.transcribeVoiceProxy)
sttProtectedRoutes.get('/api/studio/stt/profile-status', requireScopedProfile, ctrl.profileStatus)
sttProtectedRoutes.get('/api/studio/stt/profile-status/missing-audio', requireScopedProfile, ctrl.missingProfileAudio)
sttProtectedRoutes.post('/api/studio/mcu/voice-turn', requireScopedProfile, ctrl.mcuVoiceTurn)
sttProtectedRoutes.put('/api/studio/stt/settings/active', requireAdmin, requireScopedProfile, ctrl.saveActiveProvider)
sttProtectedRoutes.put('/api/studio/stt/settings/:provider', requireAdmin, requireScopedProfile, ctrl.saveSettings)
sttProtectedRoutes.delete('/api/studio/stt/settings/:provider', requireAdmin, requireScopedProfile, ctrl.deleteProvider)
sttProtectedRoutes.delete('/api/studio/stt/settings/:provider/base-url-preset', requireAdmin, requireScopedProfile, ctrl.deleteBaseUrlPreset)
sttProtectedRoutes.delete('/api/studio/stt/settings/:provider/secret/:secretName', requireAdmin, requireScopedProfile, ctrl.deleteSecret)
sttProtectedRoutes.post('/api/studio/stt/local-stream', requireScopedProfile, ctrl.startLocalStream)
sttProtectedRoutes.post('/api/studio/stt/local-stream/:sessionId/chunk', requireScopedProfile, ctrl.pushLocalStreamChunk)
sttProtectedRoutes.post('/api/studio/stt/local-stream/:sessionId/finish', requireScopedProfile, ctrl.finishLocalStream)
sttProtectedRoutes.delete('/api/studio/stt/local-stream/:sessionId', requireScopedProfile, ctrl.cancelLocalStream)
sttProtectedRoutes.post('/api/studio/stt/transcribe', requireScopedProfile, ctrl.transcribe)
