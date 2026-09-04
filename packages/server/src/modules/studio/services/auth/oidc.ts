import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type JsonWebKey as CryptoJsonWebKey } from 'crypto'

/**
 * Minimal standards-compliant OIDC client (authorization code flow + PKCE).
 *
 * Configuration comes from environment variables:
 *   HERMES_SSO_ISSUER       - OIDC issuer URL, e.g. https://sso.example.com
 *   HERMES_SSO_CLIENT_ID    - client id registered at the provider
 *   HERMES_SSO_CLIENT_SECRET- client secret
 *   HERMES_SSO_SCOPES       - optional, defaults to "openid profile email"
 *
 * No third-party dependency: discovery, JWKS rotation and id_token signature
 * verification (RS256/ES256/HS256) are implemented with node:crypto.
 */

export interface SsoConfig {
  issuer: string
  clientId: string
  clientSecret: string
  scopes: string
}

export interface OidcDiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri?: string
}

export interface OidcIdentityClaims {
  sub: string
  username: string
  displayName: string
  email: string
}

interface SsoStateEntry {
  codeVerifier: string
  nonce: string
  inviteCode: string
  redirectUri: string
  expiresAt: number
}

const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000
const STATE_TTL_MS = 10 * 60 * 1000
const DEFAULT_SCOPES = 'openid profile email'

const stateStore = new Map<string, SsoStateEntry>()

let discoveryCache: { doc: OidcDiscoveryDocument | null; fetchedAt: number } | null = null
let jwksCache: { keys: CryptoJsonWebKey[]; fetchedAt: number } | null = null

export function getSsoConfig(env: Record<string, string | undefined> = process.env): SsoConfig | null {
  const issuer = env.HERMES_SSO_ISSUER?.trim().replace(/\/+$/, '')
  const clientId = env.HERMES_SSO_CLIENT_ID?.trim()
  const clientSecret = env.HERMES_SSO_CLIENT_SECRET?.trim()
  if (!issuer || !clientId || !clientSecret) return null
  if (!/^https:\/\//i.test(issuer) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(issuer)) return null
  return {
    issuer,
    clientId,
    clientSecret,
    scopes: env.HERMES_SSO_SCOPES?.trim() || DEFAULT_SCOPES,
  }
}

export function isSsoConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return getSsoConfig(env) !== null
}

function isAllowedEndpoint(url: string, issuer: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    // Plain HTTP is only tolerated for local issuers (dev setups).
    if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(issuer)) {
      return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
    }
    return false
  } catch {
    return false
  }
}

async function fetchDiscovery(config: SsoConfig): Promise<OidcDiscoveryDocument> {
  const now = Date.now()
  if (discoveryCache && discoveryCache.doc && now - discoveryCache.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return discoveryCache.doc
  }
  const url = `${config.issuer}/.well-known/openid-configuration`
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`OIDC discovery request failed (${response.status})`)
  const doc = await response.json() as Partial<OidcDiscoveryDocument>
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('OIDC discovery document is missing required endpoints')
  }
  if (doc.issuer.replace(/\/+$/, '') !== config.issuer) {
    throw new Error('OIDC discovery issuer does not match configured issuer')
  }
  if (!isAllowedEndpoint(doc.authorization_endpoint, config.issuer) || !isAllowedEndpoint(doc.token_endpoint, config.issuer)) {
    throw new Error('OIDC discovery endpoints must use HTTPS')
  }
  const normalized: OidcDiscoveryDocument = {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    userinfo_endpoint: doc.userinfo_endpoint,
    jwks_uri: doc.jwks_uri,
  }
  discoveryCache = { doc: normalized, fetchedAt: now }
  return normalized
}

export async function prepareSsoChallenge(input: { inviteCode?: string; redirectUri: string }): Promise<{
  state: string
  authorizeUrl: string
}> {
  const config = getSsoConfig()
  if (!config) throw new Error('SSO is not configured')
  const doc = await fetchDiscovery(config)

  const state = randomBytes(24).toString('base64url')
  const nonce = randomBytes(24).toString('base64url')
  const codeVerifier = randomBytes(48).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

  stateStore.set(state, {
    codeVerifier,
    nonce,
    inviteCode: input.inviteCode || '',
    redirectUri: input.redirectUri,
    expiresAt: Date.now() + STATE_TTL_MS,
  })

  const authorizeUrl = new URL(doc.authorization_endpoint)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', config.clientId)
  authorizeUrl.searchParams.set('scope', config.scopes)
  authorizeUrl.searchParams.set('redirect_uri', input.redirectUri)
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('nonce', nonce)
  authorizeUrl.searchParams.set('code_challenge', codeChallenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')

  return { state, authorizeUrl: authorizeUrl.toString() }
}

export function takeSsoState(state: string): SsoStateEntry | null {
  const entry = stateStore.get(state)
  stateStore.delete(state)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) return null
  return entry
}

export function clearSsoState(): void {
  stateStore.clear()
}

interface TokenEndpointResponse {
  access_token?: string
  id_token?: string
  token_type?: string
}

export async function exchangeAuthorizationCode(input: {
  code: string
  codeVerifier: string
  redirectUri: string
}): Promise<{ idToken: string | null; accessToken: string | null }> {
  const config = getSsoConfig()
  if (!config) throw new Error('SSO is not configured')
  const doc = await fetchDiscovery(config)
  const response = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }).toString(),
  })
  if (!response.ok) throw new Error(`OIDC token exchange failed (${response.status})`)
  const data = await response.json() as TokenEndpointResponse
  if (!data.id_token && !data.access_token) throw new Error('OIDC token response contains no identity credentials')
  return { idToken: data.id_token || null, accessToken: data.access_token || null }
}

interface IdTokenClaims {
  iss?: string
  aud?: string | string[]
  exp?: number
  nonce?: string
  sub?: string
  preferred_username?: string
  name?: string
  email?: string
}

function decodeJwtSegment(token: string): { header: { alg?: string; kid?: string }; claims: IdTokenClaims; signature: Buffer; signedContent: string } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'))
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    const signature = Buffer.from(parts[2], 'base64url')
    return { header, claims, signature, signedContent: `${parts[0]}.${parts[1]}` }
  } catch {
    return null
  }
}

async function fetchJwks(config: SsoConfig, doc: OidcDiscoveryDocument): Promise<CryptoJsonWebKey[]> {
  const now = Date.now()
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) return jwksCache.keys
  if (!doc.jwks_uri) return []
  const response = await fetch(doc.jwks_uri, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`OIDC JWKS request failed (${response.status})`)
  const body = await response.json() as { keys?: CryptoJsonWebKey[] }
  const keys = Array.isArray(body.keys) ? body.keys : []
  jwksCache = { keys, fetchedAt: now }
  return keys
}

function verifyJwtSignature(jwt: { header: { alg?: string; kid?: string }; signature: Buffer; signedContent: string }, keys: CryptoJsonWebKey[], config: SsoConfig): boolean {
  const alg = jwt.header.alg || ''
  if (alg === 'HS256') {
    const expected = createHash('sha256').update(config.clientSecret).update(jwt.signedContent).digest()
    return jwt.signature.length === expected.length && timingSafeEqual(jwt.signature, expected)
  }
  if (alg !== 'RS256' && alg !== 'ES256') return false

  const kid = jwt.header.kid
  const candidates = keys.filter(key => (
    (!kid || key.kid === kid) &&
    (alg === 'RS256' ? key.kty === 'RSA' : key.kty === 'EC')
  ))
  for (const key of candidates) {
    try {
      const publicKey = createPublicKey({ key, format: 'jwk' })
      if (cryptoVerify('sha256', Buffer.from(jwt.signedContent), publicKey, jwt.signature)) return true
    } catch {
      continue
    }
  }
  return false
}

export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
  const config = getSsoConfig()
  if (!config) throw new Error('SSO is not configured')
  const doc = await fetchDiscovery(config)
  const jwt = decodeJwtSegment(idToken)
  if (!jwt) throw new Error('OIDC id_token is malformed')
  claimSubject(jwt.claims.sub)

  const now = Math.floor(Date.now() / 1000)
  if (jwt.claims.exp && now >= jwt.claims.exp) throw new Error('OIDC id_token is expired')
  if (jwt.claims.iss && jwt.claims.iss.replace(/\/+$/, '') !== config.issuer) {
    throw new Error('OIDC id_token issuer mismatch')
  }
  const audiences = Array.isArray(jwt.claims.aud) ? jwt.claims.aud : [jwt.claims.aud]
  if (!audiences.includes(config.clientId)) throw new Error('OIDC id_token audience mismatch')
  if (expectedNonce && jwt.claims.nonce !== expectedNonce) throw new Error('OIDC id_token nonce mismatch')

  if (jwt.header.alg === 'HS256') {
    if (!verifyJwtSignature(jwt, [], config)) throw new Error('OIDC id_token signature verification failed')
  } else {
    const keys = await fetchJwks(config, doc)
    if (!keys.length || !verifyJwtSignature(jwt, keys, config)) throw new Error('OIDC id_token signature verification failed')
  }
  return jwt.claims
}

export async function fetchUserInfoClaims(accessToken: string): Promise<IdTokenClaims> {
  const config = getSsoConfig()
  if (!config) throw new Error('SSO is not configured')
  const doc = await fetchDiscovery(config)
  if (!doc.userinfo_endpoint) throw new Error('OIDC provider has no userinfo endpoint')
  const response = await fetch(doc.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`OIDC userinfo request failed (${response.status})`)
  return await response.json() as IdTokenClaims
}

function claimText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function claimSubject(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new Error('OIDC identity subject is invalid')
  }
  return value
}

export function toIdentityClaims(claims: IdTokenClaims): OidcIdentityClaims {
  const sub = claimSubject(claims.sub)
  const displayName = claimText(claims.name, 255)
  const email = claimText(claims.email, 255)
  const username = claimText(claims.preferred_username, 80) || displayName.slice(0, 80) || email.slice(0, 80) || sub
  return {
    sub,
    username: username || sub,
    displayName,
    email,
  }
}

function mergeOidcIdentityClaims(idTokenClaims: IdTokenClaims, userInfoClaims: IdTokenClaims): OidcIdentityClaims {
  return toIdentityClaims({
    sub: idTokenClaims.sub,
    preferred_username: claimText(idTokenClaims.preferred_username, 80) || userInfoClaims.preferred_username,
    name: claimText(idTokenClaims.name, 255) || userInfoClaims.name,
    email: claimText(idTokenClaims.email, 255) || userInfoClaims.email,
  })
}

export async function resolveOidcIdentityClaims(
  tokens: { idToken: string | null; accessToken: string | null },
  expectedNonce: string,
): Promise<OidcIdentityClaims> {
  if (!tokens.idToken) {
    if (!tokens.accessToken) throw new Error('no identity credentials')
    return toIdentityClaims(await fetchUserInfoClaims(tokens.accessToken))
  }

  const idTokenClaims = await verifyIdToken(tokens.idToken, expectedNonce)
  const identity = toIdentityClaims(idTokenClaims)
  if (!tokens.accessToken) return identity

  let userInfoClaims: IdTokenClaims
  try {
    userInfoClaims = await fetchUserInfoClaims(tokens.accessToken)
  } catch {
    return identity
  }

  if (claimSubject(userInfoClaims.sub) !== identity.sub) {
    throw new Error('OIDC userinfo subject mismatch')
  }
  return mergeOidcIdentityClaims(idTokenClaims, userInfoClaims)
}

// Exported for tests.
export const __internals = { fetchDiscovery, stateStore }
