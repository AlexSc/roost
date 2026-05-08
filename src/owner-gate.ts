// Owner-gate: ensures only one MCP per ROOST_DATA_DIR claims the IRC nick
// and binds the permbot socket. Nested claudes (e.g. `claude -p ...` from
// inside a Bash tool call) inherit the same DATA_DIR via tmux env and would
// otherwise spawn a duplicate MCP that collides with the owner's IRC nick.
//
// First MCP to start atomic-creates `${dataDir}/owner.session` with its
// CLAUDE_CODE_SESSION_ID. Later starters compare; mismatch → passive.

import * as fs from 'node:fs'
import * as path from 'node:path'

export type Ownership = 'owner' | 'passive'

const FILE = 'owner.session'

// Atomic claim — used by the MCP at startup. Writes our session id if the
// file is absent; on EEXIST, compares and returns 'passive' on mismatch.
// Same session re-running (e.g. after a transient crash) re-acquires owner.
export function claimOwnership(dataDir: string, sessionId: string): Ownership {
  const p = path.join(dataDir, FILE)
  try {
    const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    try { fs.writeSync(fd, sessionId) } finally { fs.closeSync(fd) }
    return 'owner'
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const existing = fs.readFileSync(p, 'utf8').trim()
    return existing === sessionId ? 'owner' : 'passive'
  }
}

// Read-only check — used by the permission-prompt hook. Returns 'no-gate'
// when the file is absent or env vars are missing, so callers can fall back
// to legacy behavior. Returns 'passive' iff the file exists with a session
// id different from ours.
export function checkOwnership(dataDir: string, sessionId: string): Ownership | 'no-gate' {
  if (!dataDir || !sessionId) return 'no-gate'
  const p = path.join(dataDir, FILE)
  let existing: string
  try {
    existing = fs.readFileSync(p, 'utf8').trim()
  } catch {
    return 'no-gate'
  }
  return existing === sessionId ? 'owner' : 'passive'
}
