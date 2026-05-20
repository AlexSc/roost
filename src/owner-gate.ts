// Owner-gate: ensures only one MCP per ROOST_DATA_DIR claims the IRC nick
// and binds the permbot socket. Nested claudes (e.g. `claude -p ...` from
// inside a Bash tool call) inherit the same DATA_DIR via tmux env and would
// otherwise spawn a duplicate MCP that collides with the owner's IRC nick.
//
// First MCP to start atomic-creates `${dataDir}/owner.session` with its
// CLAUDE_CODE_SESSION_ID. Later starters compare; mismatch → passive.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { exclusiveCreateSync } from './fs-lock.js'

export type Ownership = 'owner' | 'passive'

const FILE = 'owner.session'

// Atomic claim — used by the MCP at startup. Writes our session id if the
// file is absent; on EEXIST, compares and returns 'passive' on mismatch.
// Same session re-running (e.g. after a transient crash) re-acquires owner.
//
// Stale-file note: nothing deletes owner.session by itself; `roost shutdown`
// rms the whole data dir. If the data dir survives an abnormal exit (manual
// tmux kill, crash mid-session) and a *different* CLAUDE_CODE_SESSION_ID
// boots later in the same dir, that starter goes passive against the stale
// file. Same-session re-acquires fine. In practice we always start fresh
// dirs via `roost spawn`, so this is a known edge, not a recurring bug.
export function claimOwnership(dataDir: string, sessionId: string): Ownership {
  const p = path.join(dataDir, FILE)
  const result = exclusiveCreateSync(p, sessionId, { mode: 0o600 })
  if (result.created) return 'owner'
  return result.existing.trim() === sessionId ? 'owner' : 'passive'
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
