import Router from '@koa/router'
import * as ctrl from '../controllers/auth'
import * as inviteCtrl from '../controllers/invites'
import * as externalIdentityCtrl from '../controllers/external-identities'
import * as ssoCtrl from '../controllers/sso'
import { requireSuperAdmin, requireAdmin } from '../middleware/auth'

// Public routes (no auth required)
export const authPublicRoutes = new Router()
authPublicRoutes.get('/api/auth/status', ctrl.authStatus)
authPublicRoutes.post('/api/auth/login', ctrl.login)
authPublicRoutes.post('/api/auth/app-login', ctrl.appLogin)
authPublicRoutes.post('/api/auth/mcu-login', ctrl.microcontrollerLogin)
authPublicRoutes.get('/api/auth/sso/status', ssoCtrl.ssoStatus)
authPublicRoutes.get('/api/auth/sso/redirect', ssoCtrl.ssoRedirect)
authPublicRoutes.get('/api/auth/sso/callback', ssoCtrl.ssoCallback)
authPublicRoutes.get('/api/auth/invites/:code', inviteCtrl.getInviteInfo)
authPublicRoutes.post('/api/auth/invites/:code/accept', inviteCtrl.acceptInvite)

// Protected routes (auth required)
export const authProtectedRoutes = new Router()
authProtectedRoutes.post('/api/auth/setup', ctrl.setupPassword)
authProtectedRoutes.get('/api/auth/me', ctrl.currentUser)
authProtectedRoutes.post('/api/auth/change-password', ctrl.changePassword)
authProtectedRoutes.post('/api/auth/change-username', ctrl.changeUsername)
authProtectedRoutes.get('/api/auth/avatar', ctrl.getMyAvatar)
authProtectedRoutes.put('/api/auth/avatar', ctrl.updateMyAvatar)
authProtectedRoutes.delete('/api/auth/password', ctrl.removePassword)
authProtectedRoutes.get('/api/auth/users', requireSuperAdmin, ctrl.listManagedUsers)
authProtectedRoutes.post('/api/auth/users', requireSuperAdmin, ctrl.createManagedUser)
authProtectedRoutes.put('/api/auth/users/:id', requireSuperAdmin, ctrl.updateManagedUser)
authProtectedRoutes.delete('/api/auth/users/:id', requireSuperAdmin, ctrl.deleteManagedUser)
authProtectedRoutes.get('/api/auth/external-identities', requireAdmin, externalIdentityCtrl.listMappings)
authProtectedRoutes.get('/api/auth/external-identities/candidates', requireAdmin, externalIdentityCtrl.listCandidates)
authProtectedRoutes.post('/api/auth/external-identities', requireAdmin, externalIdentityCtrl.createMapping)
authProtectedRoutes.delete('/api/auth/external-identities/:id', requireAdmin, externalIdentityCtrl.removeMapping)
authProtectedRoutes.get('/api/auth/invites', requireAdmin, inviteCtrl.listInviteRecords)
authProtectedRoutes.post('/api/auth/invites', requireAdmin, inviteCtrl.createInviteRecord)
authProtectedRoutes.delete('/api/auth/invites/:code', requireAdmin, inviteCtrl.revokeInviteRecord)
authProtectedRoutes.get('/api/auth/locked-ips', ctrl.listLockedIps)
authProtectedRoutes.delete('/api/auth/locked-ips', ctrl.unlockIpHandler)
