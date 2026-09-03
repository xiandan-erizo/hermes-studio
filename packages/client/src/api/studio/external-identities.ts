import { request } from '../client'

export interface ExternalIdentityMapping {
  id: number
  source: string
  external_id: string
  user_id: number
  note: string
  created_at: number
  updated_at: number
  username: string | null
}

export interface ExternalIdentityCandidate {
  source: string
  external_id: string
  session_count: number
}

export interface ExternalIdentityUser {
  id: number
  username: string
}

export async function fetchExternalIdentities(): Promise<{ mappings: ExternalIdentityMapping[] }> {
  return request<{ mappings: ExternalIdentityMapping[] }>('/api/auth/external-identities')
}

export async function fetchExternalIdentityCandidates(): Promise<{ candidates: ExternalIdentityCandidate[] }> {
  return request<{ candidates: ExternalIdentityCandidate[] }>('/api/auth/external-identities/candidates')
}

export async function fetchExternalIdentityUsers(): Promise<{ users: ExternalIdentityUser[] }> {
  return request<{ users: ExternalIdentityUser[] }>('/api/auth/external-identities/users')
}

export async function createExternalIdentity(input: {
  source: string
  external_id: string
  user_id: number
  note?: string
}): Promise<{ mapping: ExternalIdentityMapping }> {
  return request<{ mapping: ExternalIdentityMapping }>('/api/auth/external-identities', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function deleteExternalIdentity(id: number): Promise<void> {
  await request<{ success: boolean }>(`/api/auth/external-identities/${id}`, { method: 'DELETE' })
}
