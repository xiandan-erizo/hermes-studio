import type { Context } from 'koa'
import { issueUserJwt } from '../public/auth'
import { addUserProfileBinding, listUserProfiles, touchUserLogin } from '../public/users'
import { resolveSsoAccount } from '../services/auth/sso-accounts'
import {
  getSsoConfig,
  isSsoConfigured,
  prepareSsoChallenge,
  takeSsoState,
  exchangeAuthorizationCode,
  fetchUserInfoClaims,
  toIdentityClaims,
  verifyIdToken,
} from '../services/auth/oidc'
import { validateInviteForUse, consumeInviteUse } from '../services/auth/profile-invites'

/**
 * GET /api/auth/sso/status (public)
 * Reports whether OIDC single sign-on is configured.
 */
export async function ssoStatus(ctx: Context) {
  ctx.body = { enabled: isSsoConfigured() }
}

function requestBaseUrl(ctx: Context): string {
  const forwardedHost = ctx.get('x-forwarded-host').split(',')[0].trim()
  const host = forwardedHost || ctx.get('host').trim()
  if (!host) return ''
  const forwardedProto = ctx.get('x-forwarded-proto').split(',')[0].trim()
  const proto = forwardedProto || ctx.protocol || 'http'
  return `${proto}://${host}`
}

function callbackUrl(ctx: Context): string {
  return `${requestBaseUrl(ctx)}/api/auth/sso/callback`
}

function frontendErrorRedirect(ctx: Context, reason: string): void {
  const target = `${requestBaseUrl(ctx)}/#/login?sso_error=${encodeURIComponent(reason)}`
  ctx.status = 302
  ctx.redirect(target)
}

function frontendTokenRedirect(ctx: Context, token: string): void {
  const target = `${requestBaseUrl(ctx)}/?token=${encodeURIComponent(token)}`
  ctx.status = 302
  ctx.redirect(target)
}

/**
 * GET /api/auth/sso/redirect?invite=<code> (public)
 * Starts the OIDC authorization code flow. The invite code (optional) is
 * remembered in the state so the resulting account gets the profile bound.
 */
export async function ssoRedirect(ctx: Context) {
  if (!isSsoConfigured()) {
    ctx.status = 404
    ctx.body = { error: 'SSO is not configured' }
    return
  }
  const inviteCode = typeof ctx.query.invite === 'string' ? ctx.query.invite.trim() : ''
  if (inviteCode) {
    const validation = validateInviteForUse(inviteCode)
    if (!validation.ok) {
      frontendErrorRedirect(ctx, 'invite_unavailable')
      return
    }
  }
  try {
    const challenge = await prepareSsoChallenge({
      inviteCode,
      redirectUri: callbackUrl(ctx),
    })
    ctx.status = 302
    ctx.redirect(challenge.authorizeUrl)
  } catch {
    frontendErrorRedirect(ctx, 'sso_unavailable')
  }
}

/**
 * GET /api/auth/sso/callback (public)
 * OIDC redirect endpoint. Exchanges the code, verifies the id_token, maps the
 * external identity to a local account (auto-provisioned as role 'user'),
 * applies the pending invite profile, then redirects the browser to the web
 * UI with a session token in the URL.
 */
export async function ssoCallback(ctx: Context) {
  if (!getSsoConfig()) {
    frontendErrorRedirect(ctx, 'sso_unavailable')
    return
  }

  const error = typeof ctx.query.error === 'string' ? ctx.query.error : ''
  if (error) {
    frontendErrorRedirect(ctx, error === 'access_denied' ? 'access_denied' : 'sso_failed')
    return
  }

  const code = typeof ctx.query.code === 'string' ? ctx.query.code : ''
  const state = typeof ctx.query.state === 'string' ? ctx.query.state : ''
  const stateEntry = takeSsoState(state)
  if (!code || !stateEntry) {
    frontendErrorRedirect(ctx, 'sso_state_invalid')
    return
  }

  let claims
  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier: stateEntry.codeVerifier,
      redirectUri: stateEntry.redirectUri,
    })
    if (tokens.idToken) {
      claims = toIdentityClaims(await verifyIdToken(tokens.idToken, stateEntry.nonce))
    } else if (tokens.accessToken) {
      claims = toIdentityClaims(await fetchUserInfoClaims(tokens.accessToken))
    } else {
      throw new Error('no identity credentials')
    }
  } catch {
    frontendErrorRedirect(ctx, 'sso_failed')
    return
  }

  if (!claims.sub) {
    frontendErrorRedirect(ctx, 'sso_failed')
    return
  }

  const account = resolveSsoAccount(claims)
  if (!account || account.user.status !== 'active') {
    frontendErrorRedirect(ctx, 'account_disabled')
    return
  }
  const user = account.user

  if (stateEntry.inviteCode && user.role !== 'super_admin') {
    const validation = validateInviteForUse(stateEntry.inviteCode)
    if (validation.ok) {
      addUserProfileBinding(user.id, validation.invite.profile_name, listUserProfiles(user.id).length === 0)
      consumeInviteUse(stateEntry.inviteCode)
    }
  }

  touchUserLogin(user.id)
  const token = await issueUserJwt(user)
  frontendTokenRedirect(ctx, token)
}
