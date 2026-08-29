import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { detectHermesRootHome } from '../runtime/path'
import { logger } from '../../../studio/public/logging'

const execFileAsync = promisify(execFile)

/**
 * Git-based marketplace source cache. Each configured source gets a shallow
 * clone under <hermes home>/marketplace-cache/<sourceId>. Only git-over-SSH
 * URLs are accepted: no HTTP(S) credentials to leak, no SSRF surface, and the
 * server process already holds the SSH key that can reach internal forges.
 */

const GIT_TIMEOUT_MS = 120_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

export class MarketplaceGitError extends Error {}

export class MarketplaceUrlError extends Error {}

/**
 * Accept only git SSH URLs, in either form:
 *   - SCP-like:  git@git.example.com:group/repo.git  (also without .git)
 *   - ssh://     ssh://git@git.example.com/group/repo.git
 */
export function validateGitSshUrl(url: string): string {
  const trimmed = String(url || '').trim()
  if (!trimmed) throw new MarketplaceUrlError('Git URL is required')

  const scpLike = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:(?!\/?\/)[A-Za-z0-9._/~-]+(?:\/[A-Za-z0-9._~+-]+)*$/
  const sshForm = /^ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?::\d+)?\/[A-Za-z0-9._/~+-]+(?:\/[A-Za-z0-9._~+-]+)*$/
  if (!scpLike.test(trimmed) && !sshForm.test(trimmed)) {
    throw new MarketplaceUrlError(
      'Only git SSH URLs are supported (git@host:group/repo.git or ssh://git@host/group/repo.git)',
    )
  }
  if (trimmed.length > 2048) throw new MarketplaceUrlError('Git URL is too long')
  // Hygiene: no '..' path segments (scp-like paths are remote-relative and
  // harmless, but a traversal-shaped URL is never something we meant to allow).
  const pathPart = trimmed.replace(/^ssh:\/\/[^\/]+\//, '').replace(/^[^@]+@[^:]+:/, '')
  if (/(^|\/)\.\.(\/|$)/.test(pathPart)) {
    throw new MarketplaceUrlError('Git URL must not contain ".." path segments')
  }
  return trimmed
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // Never touch the user's global git config; the cache is fully managed.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
  }
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: gitEnv(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    })
    return stdout
  } catch (err: any) {
    const detail = String(err?.stderr || err?.message || err).trim().slice(0, 500)
    throw new MarketplaceGitError(detail || 'git command failed')
  }
}

/** Root directory holding one shallow clone per marketplace source. */
export function marketplaceCacheRoot(hermesRoot = detectHermesRootHome()): string {
  const override = process.env.HERMES_WEB_UI_MARKETPLACE_CACHE_DIR?.trim()
  return override ? resolve(override) : join(resolve(hermesRoot), 'marketplace-cache')
}

export function marketplaceCacheDir(sourceId: number, hermesRoot = detectHermesRootHome()): string {
  return join(marketplaceCacheRoot(hermesRoot), `source-${sourceId}`)
}

function isGitDir(dir: string): boolean {
  return existsSync(join(dir, '.git')) || existsSync(join(dir, 'HEAD'))
}

function hasWorkingTree(dir: string): boolean {
  return existsSync(join(dir, 'plugins'))
}

export interface GitSyncResult {
  commit: string
  /** true when a fresh clone was performed, false for fetch+reset */
  cloned: boolean
}

/** Clone the source (shallow) if the cache is absent or unreadable. */
export async function ensureCloned(sourceId: number, url: string, hermesRoot?: string): Promise<GitSyncResult> {
  const dir = marketplaceCacheDir(sourceId, hermesRoot)
  if (isGitDir(dir) && hasWorkingTree(dir)) {
    return { commit: (await git(['rev-parse', 'HEAD'], dir)).trim(), cloned: false }
  }
  rmSync(dir, { recursive: true, force: true })
  await git(['clone', '--depth', '1', '--single-branch', url, dir])
  return { commit: (await git(['rev-parse', 'HEAD'], dir)).trim(), cloned: true }
}

/** Refresh an existing clone: fetch + hard reset, falling back to re-clone. */
export async function refreshClone(sourceId: number, url: string, hermesRoot?: string): Promise<GitSyncResult> {
  const dir = marketplaceCacheDir(sourceId, hermesRoot)
  if (!isGitDir(dir)) return ensureCloned(sourceId, url, hermesRoot)
  try {
    // `git fetch --depth 1 origin` updates the single remote-tracking branch
    // the shallow clone was created with; FETCH_HEAD always points at what
    // the remote HEAD resolved to.
    await git(['fetch', '--depth', '1', 'origin'], dir)
    await git(['reset', '--hard', 'FETCH_HEAD'], dir)
    await git(['clean', '-fdx'], dir)
    return { commit: (await git(['rev-parse', 'HEAD'], dir)).trim(), cloned: false }
  } catch (err) {
    logger.warn(`[marketplace] fetch+reset failed for source ${sourceId}, re-cloning: ${(err as Error).message}`)
    return ensureCloned(sourceId, url, hermesRoot)
  }
}

/** Current cached commit, or null when no usable clone exists. */
export async function cachedCommit(sourceId: number, hermesRoot?: string): Promise<string | null> {
  const dir = marketplaceCacheDir(sourceId, hermesRoot)
  if (!isGitDir(dir) || !hasWorkingTree(dir)) return null
  try {
    return (await git(['rev-parse', 'HEAD'], dir)).trim()
  } catch {
    return null
  }
}

/** Remove the cache directory for a source (used when the source is deleted). */
export function removeCache(sourceId: number, hermesRoot?: string): void {
  rmSync(marketplaceCacheDir(sourceId, hermesRoot), { recursive: true, force: true })
}

/** In-flight sync guard: one sync at a time per source id. */
const pendingSyncs = new Map<number, Promise<GitSyncResult>>()

export function syncSource(
  sourceId: number,
  url: string,
  mode: 'ensure' | 'refresh',
  hermesRoot?: string,
): Promise<GitSyncResult> {
  const existing = pendingSyncs.get(sourceId)
  if (existing) return existing
  const task = (mode === 'refresh' ? refreshClone(sourceId, url, hermesRoot) : ensureCloned(sourceId, url, hermesRoot))
    .finally(() => pendingSyncs.delete(sourceId))
  pendingSyncs.set(sourceId, task)
  return task
}
