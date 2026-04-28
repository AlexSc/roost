#!/usr/bin/env bun
/**
 * Standalone IRC listener — joins a channel and writes every message
 * to a log file. Used as ground truth in tests that need to confirm
 * what the IRC-MCP is actually publishing without going through another
 * Claude session.
 *
 * Env:
 *   ROOST_IRC_SERVER  (default 127.0.0.1)
 *   ROOST_IRC_PORT    (default 6667)
 *   ROOST_LISTEN_NICK (default roost-listener)
 *   ROOST_LISTEN_CHAN (default #test)
 *   ROOST_LISTEN_LOG  (required — output file)
 */
// @ts-expect-error
import IRC from 'irc-framework'
import { appendFileSync } from 'node:fs'

const SERVER = process.env.ROOST_IRC_SERVER ?? '127.0.0.1'
const PORT = Number(process.env.ROOST_IRC_PORT ?? '6667')
const NICK = process.env.ROOST_LISTEN_NICK ?? 'roost-listener'
const CHAN = process.env.ROOST_LISTEN_CHAN ?? '#test'
const LOG = process.env.ROOST_LISTEN_LOG
if (!LOG) {
  console.error('ROOST_LISTEN_LOG is required')
  process.exit(2)
}

const c = new IRC.Client()
c.on('registered', () => {
  process.stderr.write(`listener[${NICK}]: registered, joining ${CHAN}\n`)
  c.join(CHAN)
})
c.on('join', (e: { nick: string; channel: string }) => {
  if (e.nick === NICK) {
    appendFileSync(LOG!, `${new Date().toISOString()}\tjoined\t${e.channel}\n`)
  }
})
c.on('message', (e: { nick: string; target: string; message: string }) => {
  if (e.nick === NICK) return
  appendFileSync(
    LOG!,
    `${new Date().toISOString()}\t${e.target}\t<${e.nick}>\t${e.message}\n`,
  )
  process.stderr.write(`listener[${NICK}]: ${e.target} <${e.nick}> ${e.message}\n`)
})
c.connect({ host: SERVER, port: PORT, nick: NICK, username: NICK, gecos: NICK })
