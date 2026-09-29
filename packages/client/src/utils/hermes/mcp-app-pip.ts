type RevokePip = () => void

let activeRevoke: RevokePip | null = null

/** Keep the host's PiP surface singular when several historical App cards exist. */
export function claimMcpAppPip(revoke: RevokePip): () => void {
  const previousRevoke = activeRevoke
  activeRevoke = revoke
  previousRevoke?.()
  let released = false
  return () => {
    if (released) return
    released = true
    if (activeRevoke === revoke) activeRevoke = null
  }
}
