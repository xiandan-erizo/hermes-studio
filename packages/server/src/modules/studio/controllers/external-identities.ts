import type { Context } from 'koa'
import * as identities from '../services/external-identities'

function mappingError(ctx: Context, error: unknown): void {
  if (!(error instanceof identities.ExternalIdentityError)) throw error
  ctx.status = { invalid: 400, conflict: 409, not_found: 404 }[error.code]
  ctx.body = { error: error.message }
}

/** GET /api/auth/external-identities (admin) */
export async function listMappings(ctx: Context) {
  ctx.body = { mappings: identities.listMappings() }
}

/** GET /api/auth/external-identities/candidates (admin) */
export async function listCandidates(ctx: Context) {
  ctx.body = { candidates: await identities.listCandidates() }
}

/** POST /api/auth/external-identities (admin) */
export async function createMapping(ctx: Context) {
  // Keep the transport shape inline for the OpenAPI source scanner.
  // Runtime validation, including absent bodies/fields, belongs to the service.
  const body = ctx.request.body as {
    source?: unknown
    external_id: unknown
    user_id?: unknown
    note?: unknown
  } | undefined
  try {
    const mapping = identities.createMapping(body)
    ctx.status = 201
    ctx.body = { mapping }
  } catch (error) {
    mappingError(ctx, error)
  }
}

/** GET /api/auth/external-identities/users (admin) */
export async function listMappingUsers(ctx: Context) {
  ctx.body = { users: identities.listMappingUsers() }
}

/** DELETE /api/auth/external-identities/:id (admin) */
export async function removeMapping(ctx: Context) {
  try {
    identities.removeMapping(Number(ctx.params.id))
    ctx.body = { success: true }
  } catch (error) {
    mappingError(ctx, error)
  }
}
