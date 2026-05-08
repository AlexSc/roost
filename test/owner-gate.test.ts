import { describe, it, expect, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { claimOwnership, checkOwnership } from '../src/owner-gate.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  dirs.length = 0
})

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-gate-test-'))
  dirs.push(d)
  return d
}

describe('claimOwnership', () => {
  it('first claimer wins and writes the session file', () => {
    const d = tmpDir()
    expect(claimOwnership(d, 'sess-1')).toBe('owner')
    expect(fs.readFileSync(path.join(d, 'owner.session'), 'utf8').trim()).toBe('sess-1')
  })

  it('same session re-claiming returns owner (idempotent restart)', () => {
    const d = tmpDir()
    expect(claimOwnership(d, 'sess-1')).toBe('owner')
    expect(claimOwnership(d, 'sess-1')).toBe('owner')
  })

  it('second claimer with a different session goes passive', () => {
    const d = tmpDir()
    expect(claimOwnership(d, 'sess-A')).toBe('owner')
    expect(claimOwnership(d, 'sess-B')).toBe('passive')
    // owner.session is unchanged
    expect(fs.readFileSync(path.join(d, 'owner.session'), 'utf8').trim()).toBe('sess-A')
  })
})

describe('checkOwnership', () => {
  it('returns no-gate when env-derived inputs are blank', () => {
    expect(checkOwnership('', 'sess-1')).toBe('no-gate')
    expect(checkOwnership(tmpDir(), '')).toBe('no-gate')
  })

  it('returns no-gate when owner.session does not exist', () => {
    expect(checkOwnership(tmpDir(), 'sess-1')).toBe('no-gate')
  })

  it('returns owner when session matches owner.session', () => {
    const d = tmpDir()
    claimOwnership(d, 'sess-1')
    expect(checkOwnership(d, 'sess-1')).toBe('owner')
  })

  it('returns passive when session differs from owner.session', () => {
    const d = tmpDir()
    claimOwnership(d, 'sess-A')
    expect(checkOwnership(d, 'sess-B')).toBe('passive')
  })

  it('does not write owner.session as a side effect', () => {
    const d = tmpDir()
    expect(checkOwnership(d, 'sess-1')).toBe('no-gate')
    expect(fs.existsSync(path.join(d, 'owner.session'))).toBe(false)
  })
})
