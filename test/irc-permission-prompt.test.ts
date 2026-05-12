import { describe, it, expect } from 'bun:test'
import * as net from 'node:net'
import { join } from 'node:path'
import { startPermbotStub, makeSock, captureIRC } from './helpers/permbot-stub.js'

const HOOK = join(import.meta.dirname, '../src/permission-prompt.ts')
const PAYLOAD = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm /tmp/x', description: 'test' }, transcript_path: '' })

async function runHook(env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdin: new TextEncoder().encode(PAYLOAD),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr }
}

describe('irc-permission-prompt fallback DM', () => {
  it('sends PRIVMSG to target when daemon unreachable', async () => {
    const { port, lines } = await captureIRC()
    const [received] = await Promise.all([
      lines(),
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_TARGET: 'operator',
        ROOST_PERM_HOST: '127.0.0.1',
        ROOST_PERM_PORT: String(port),
        // no ROOST_PERM_SOCK → daemon unreachable path
      }),
    ])
    const privmsgs = received.filter(l => l.startsWith('PRIVMSG operator :'))
    expect(privmsgs.length).toBeGreaterThan(0)
    expect(privmsgs.some(m => m.includes('fallback'))).toBe(true)
    expect(privmsgs.some(m => m.includes('Bash'))).toBe(true)
  }, 15_000)

  it('sends fallback DM when operator reply is unrecognized', async () => {
    const sockPath = makeSock()
    const stub = startPermbotStub(sockPath, { reply: 'maybe' })
    await stub.ready

    const { port, lines } = await captureIRC()
    const [received] = await Promise.all([
      lines(),
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_TARGET: 'operator',
        ROOST_PERM_HOST: '127.0.0.1',
        ROOST_PERM_PORT: String(port),
        ROOST_PERM_SOCK: sockPath,
      }),
      stub.done,
    ])

    const privmsgs = received.filter(l => l.startsWith('PRIVMSG operator :'))
    expect(privmsgs.length).toBeGreaterThan(0)
    expect(privmsgs.some(m => m.includes('unrecognized'))).toBe(true)
  }, 15_000)

  it('skips DM when ROOST_PERM_TARGET not set', async () => {
    let connected = false
    const server = net.createServer(() => { connected = true })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port

    await runHook({
      ROOST_IRC_NICK: 'worker-test',
      ROOST_PERM_HOST: '127.0.0.1',
      ROOST_PERM_PORT: String(port),
      // no ROOST_PERM_TARGET
    })
    await Bun.sleep(100)
    server.close()
    expect(connected).toBe(false)
  })
})
