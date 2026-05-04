import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'

const BIN_DIR = join(import.meta.dir, '../bin')

function isShellScript(file: string): boolean {
  try {
    const first = readFileSync(join(BIN_DIR, file), { encoding: 'utf8' }).split('\n')[0]
    return /^#!\s*(\/usr\/bin\/env\s+)?(ba)?sh\b/.test(first)
  } catch {
    return false
  }
}

function shellcheckAvailable(): boolean {
  return spawnSync('shellcheck', ['--version']).status === 0
}

const shellScripts = readdirSync(BIN_DIR).filter(isShellScript)

describe.if(shellcheckAvailable())('shellcheck bin/', () => {
  for (const script of shellScripts) {
    it(script, () => {
      const result = spawnSync('shellcheck', [join(BIN_DIR, script)], { encoding: 'utf8' })
      expect(result.stdout + result.stderr).toBe('')
      expect(result.status).toBe(0)
    })
  }
})
