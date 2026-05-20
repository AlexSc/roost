import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { exclusiveCreate, exclusiveCreateSync } from '../src/fs-lock.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fs-lock-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('exclusiveCreate', () => {
  it('creates the file and returns created:true when absent', async () => {
    const p = join(dir, 'test.lock')
    const result = await exclusiveCreate(p, 'hello')
    expect(result.created).toBe(true)
  })

  it('returns created:false with existing content on EEXIST', async () => {
    const p = join(dir, 'test.lock')
    await exclusiveCreate(p, 'first')
    const result = await exclusiveCreate(p, 'second')
    expect(result.created).toBe(false)
    if (!result.created) expect(result.existing).toBe('first')
  })

  it('does not overwrite the file on EEXIST', async () => {
    const p = join(dir, 'test.lock')
    await exclusiveCreate(p, 'original')
    await exclusiveCreate(p, 'intruder')
    const second = await exclusiveCreate(p, 'check')
    expect(second.created).toBe(false)
    if (!second.created) expect(second.existing).toBe('original')
  })

  it('applies the mode option', async () => {
    const p = join(dir, 'test.lock')
    await exclusiveCreate(p, 'x', { mode: 0o600 })
    const mode = statSync(p).mode & 0o777
    // Mask with 0o600 — umask may restrict further but won't add bits.
    expect(mode & ~0o600).toBe(0)
  })

  it('throws on non-EEXIST errors (parent dir absent)', async () => {
    const p = join(dir, 'nonexistent', 'test.lock')
    await expect(exclusiveCreate(p, 'x')).rejects.toThrow()
  })
})

describe('exclusiveCreateSync', () => {
  it('creates the file and returns created:true when absent', () => {
    const p = join(dir, 'test.lock')
    const result = exclusiveCreateSync(p, 'hello')
    expect(result.created).toBe(true)
  })

  it('returns created:false with existing content on EEXIST', () => {
    const p = join(dir, 'test.lock')
    exclusiveCreateSync(p, 'first')
    const result = exclusiveCreateSync(p, 'second')
    expect(result.created).toBe(false)
    if (!result.created) expect(result.existing).toBe('first')
  })

  it('does not overwrite the file on EEXIST', () => {
    const p = join(dir, 'test.lock')
    exclusiveCreateSync(p, 'original')
    exclusiveCreateSync(p, 'intruder')
    const second = exclusiveCreateSync(p, 'check')
    expect(second.created).toBe(false)
    if (!second.created) expect(second.existing).toBe('original')
  })

  it('applies the mode option', () => {
    const p = join(dir, 'test.lock')
    exclusiveCreateSync(p, 'x', { mode: 0o600 })
    const mode = statSync(p).mode & 0o777
    expect(mode & ~0o600).toBe(0)
  })

  it('throws on non-EEXIST errors (parent dir absent)', () => {
    const p = join(dir, 'nonexistent', 'test.lock')
    expect(() => exclusiveCreateSync(p, 'x')).toThrow()
  })
})
