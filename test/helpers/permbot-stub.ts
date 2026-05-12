import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

/** Minimal permbot socket stub: reads one JSON line, responds immediately. */
export function startPermbotStub(sockPath: string, reply: object): { ready: Promise<void>; done: Promise<void> } {
  let onReady!: () => void
  const ready = new Promise<void>(r => { onReady = r })
  let onDone!: () => void
  const done = new Promise<void>(r => { onDone = r })
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      if (!buf.includes('\n')) return
      sock.write(JSON.stringify(reply) + '\n')
      sock.end()
      server.close()
      onDone()
    })
  })
  server.listen(sockPath, () => { onReady() })
  return { ready, done }
}

export function makeSock(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
}

/**
 * Minimal IRC stub handling CAP negotiation (RoostIrcClientImpl sends CAP LS
 * before NICK/USER). Sends 001 after CAP END, closes on QUIT.
 */
export function captureIRC(): Promise<{ port: number; lines: () => Promise<string[]> }> {
  return new Promise((resolve) => {
    const collected: string[] = []
    let closed!: () => void
    const done = new Promise<string[]>(res => { closed = () => res(collected) })
    const server = net.createServer((sock) => {
      let buf = '', nick = 'unknown', sentWelcome = false
      sock.on('data', (d) => {
        buf += d.toString()
        const lines = buf.split('\r\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue  // skip blank framing lines from split('\r\n')
          if (line.startsWith('CAP LS')) {
            sock.write(':s CAP * LS :\r\n')
          } else if (line.startsWith('CAP END') && !sentWelcome) {
            sentWelcome = true
            sock.write(`:s 001 ${nick} :Welcome\r\n`)
          } else if (line.startsWith('NICK ')) {
            nick = line.slice(5).trim()
          } else if (line.startsWith('QUIT')) {
            sock.end()
          }
          collected.push(line)
        }
      })
      sock.on('close', () => { server.close(); closed() })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({ port, lines: () => done })
    })
  })
}
