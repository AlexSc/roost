#!/usr/bin/env bun
/**
 * roost IRC channel MCP — v0
 *
 * Wraps an IRC client (irc-framework). Incoming IRC traffic — channel
 * messages and DMs — is emitted into the host Claude session as
 * `notifications/claude/channel` events. Outbound actions are exposed
 * as MCP tools: channel_join, channel_leave, channel_message,
 * direct_message, channel_history, channel_who.
 *
 * Identity is per-MCP-instance: the agent's nick is configured at
 * spawn time via env vars. Multiple Claude sessions on one machine
 * each get their own MCP subprocess and therefore their own nick.
 *
 * Configuration (env vars):
 *   ROOST_IRC_SERVER     IRC server (default: 127.0.0.1)
 *   ROOST_IRC_PORT       IRC port   (default: 6667)
 *   ROOST_IRC_NICK       Nick       (REQUIRED, no default)
 *   ROOST_IRC_REALNAME   Realname   (default: same as nick)
 *   ROOST_IRC_CHANNELS   Comma-separated auto-join list (default: none)
 *   ROOST_IRC_HISTORY    Per-channel history buffer size (default: 50)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
// @ts-expect-error — irc-framework lacks first-class type defs
import IRC from 'irc-framework'

const SOURCE_NAME = 'roost-irc'

const env = (k: string, def?: string) => process.env[k] ?? def
const required = (k: string): string => {
  const v = process.env[k]
  if (!v) {
    process.stderr.write(`roost-irc: FATAL: ${k} is required\n`)
    process.exit(2)
  }
  return v
}

const SERVER = env('ROOST_IRC_SERVER', '127.0.0.1')!
const PORT = Number(env('ROOST_IRC_PORT', '6667'))
const NICK = required('ROOST_IRC_NICK')
const REALNAME = env('ROOST_IRC_REALNAME', NICK)!
const AUTO_JOIN = (env('ROOST_IRC_CHANNELS', '') || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const HISTORY_SIZE = Number(env('ROOST_IRC_HISTORY', '50'))

// ---- IRC client wiring -------------------------------------------------

interface IrcMessage {
  channel: string // "#room" for channel messages, sender's nick for DMs
  sender: string
  text: string
  ts: string
  isDirect: boolean
}

const client = new IRC.Client()
let irc_ready = false
const join_resolvers = new Map<string, Array<(ok: boolean) => void>>()

// Per-channel ring buffer of recent messages — gives us
// channel_history without needing a bouncer.
const history: Map<string, IrcMessage[]> = new Map()
const pushHistory = (key: string, msg: IrcMessage) => {
  const buf = history.get(key) ?? []
  buf.push(msg)
  while (buf.length > HISTORY_SIZE) buf.shift()
  history.set(key, buf)
}

// ---- Send-side splitting + receive-side buffering ----------------------
//
// IRC's per-line limit is 512 bytes including the server-added prefix.
// irc-framework's `message_max_length` defaults to 350 bytes. We pre-
// split outbound text into chunks of ≤300 bytes so each PRIVMSG passes
// through unsplit. Receivers reassemble heuristically: PRIVMSGs from the
// same sender to the same target arriving within BUFFER_WINDOW_MS are
// concatenated and emitted as one channel event.
//
// Why not markers in the body? Visible noise to non-MCP observers
// (irssi, weechat) — even one-line markers fragment human readability.
// Why not IRCv3 message-tags? ngircd-27 advertises only `multi-prefix`
// in CAP LS; tagged PRIVMSGs are silently dropped (probed 2026-04-27).
// A different IRC server (solanum, inspircd) would unblock tags; we
// chose to stay on ngircd and reassemble heuristically.
//
// Backward compat: if an inbound PRIVMSG carries the legacy
// [roost-split:<id>:<i>/<n>] body-prefix marker (from a not-yet-cycled
// sender on the older code), we strip it before buffering. The
// chunks still arrive in fast succession, so the time-window heuristic
// reassembles them correctly.

const MAX_CHUNK_BODY = 300
// Adaptive buffer window — first chunk gets the short window so single
// PRIVMSGs flush fast (and two genuine quick sends from same sender
// stay separate). Once we see a second chunk arrive, we know it's a
// multi-chunk logical message and extend the window so server-side
// rate-limit pauses (ngircd appears to drip-feed at ~1s intervals
// after a 3-burst, observed 2026-04-27) don't cause premature flush.
const INITIAL_BUFFER_MS = 250
const EXTENDED_BUFFER_MS = 2000
const LEGACY_MARKER_RE = /^\[roost-split:[0-9a-f]{8}:\d+\/\d+\] /

// Per-MCP monotonic receive counter — gives downstream consumers a
// strictly-monotonic ordering even when two events resolve to the same
// millisecond timestamp (the original bug behind reassembly).
let receiveSeq = 0

// ---- Per-channel user tracking -----------------------------------------
//
// irc-framework's client.channel(name).users is populated lazily and was
// observed empty at runtime (probed 2026-04-28). We track our own
// per-channel user set keyed by channel name, populated from the
// userlist event (RPL_NAMREPLY after we JOIN) and kept current via
// JOIN / PART / KICK / QUIT / NICK events. channel_who reads from this
// directly; membership-change events also push channel notifications
// so agents on the channel see comings and goings in real time.
const channelUsers: Map<string, Set<string>> = new Map()
const ensureChannelSet = (channel: string): Set<string> => {
  let set = channelUsers.get(channel)
  if (!set) {
    set = new Set()
    channelUsers.set(channel, set)
  }
  return set
}

interface RecvBuf {
  text: string
  chunkCount: number
  channel: string
  sender: string
  isDirect: boolean
  firstSeen: number
  firstTs: string
  flushTimer: ReturnType<typeof setTimeout>
}
const recvBuffers = new Map<string, RecvBuf>()

// Split at natural boundaries when possible — prefer sentence end, then
// any whitespace. Search backward within the last 1/3 of the chunk so we
// don't produce tiny chunks chasing a boundary. Falls back to mid-
// character split only if no boundary is in range (e.g., a long URL or
// token-stream with no spaces).
//
// Important: ngircd strips trailing whitespace from PRIVMSG bodies but
// preserves leading whitespace. We therefore put boundary whitespace at
// the START of chunk-N+1 (chunk-N ends with non-whitespace; chunk-N+1
// starts with the boundary character). When the receiver concatenates,
// the original byte content is preserved.
//
// We also avoid Pass-1-style newline splits — irc-framework's say()
// pre-splits its input on \r\n|\n|\r, which would shred a chunk whose
// boundary character is a newline. Sentence and whitespace boundaries
// are sufficient for the v0 case.
const findNaturalBoundary = (text: string, start: number, end: number): number => {
  const minViable = start + Math.floor((end - start) * 2 / 3)
  // Pass 1: sentence end (period/!/? followed by space or end-of-string).
  // Split AFTER the punctuation so chunk-N ends with `.` (no trailing
  // whitespace), chunk-N+1 starts with the space.
  for (let j = end; j > minViable; j--) {
    const c = text[j - 1]
    const next = text[j]
    if ((c === '.' || c === '!' || c === '?') && (next === ' ' || next === undefined)) {
      return j
    }
  }
  // Pass 2: any whitespace. Split at the space — chunk-N ends with last
  // non-whitespace char, chunk-N+1 starts with the whitespace.
  for (let j = end; j > minViable; j--) {
    const c = text[j]
    if (c === ' ' || c === '\t') return j
  }
  // Pass 3: hard cut (no boundary in range — long URL etc.)
  return end
}

const splitText = (text: string): string[] | null => {
  if (text.length <= MAX_CHUNK_BODY) return null
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const remaining = text.length - i
    if (remaining <= MAX_CHUNK_BODY) {
      out.push(text.slice(i))
      break
    }
    const split = findNaturalBoundary(text, i, i + MAX_CHUNK_BODY)
    out.push(text.slice(i, split))
    i = split
  }
  return out
}

const sendWithSplit = (target: string, text: string): { chunks: number } => {
  const chunks = splitText(text)
  if (!chunks) {
    client.say(target, text)
    return { chunks: 1 }
  }
  for (const c of chunks) {
    client.say(target, c)
  }
  process.stderr.write(
    `roost-irc[${NICK}]: split outbound to ${target} into ${chunks.length} naked chunks (receiver buffers)\n`,
  )
  return { chunks: chunks.length }
}

const flushBuffer = (key: string) => {
  const buf = recvBuffers.get(key)
  if (!buf) return
  recvBuffers.delete(key)
  const msg: IrcMessage = {
    channel: buf.channel,
    sender: buf.sender,
    text: buf.text,
    ts: buf.firstTs,
    isDirect: buf.isDirect,
  }
  pushHistory(buf.channel, msg)
  emitChannelEvent(msg, { buffered: buf.chunkCount > 1, chunkCount: buf.chunkCount })
}

// ---- MCP server --------------------------------------------------------

const mcp = new Server(
  { name: SOURCE_NAME, version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: `roost IRC MCP. You are connected to IRC as nick "${NICK}". Outbound: use channel_message, direct_message, channel_join, channel_leave, channel_who, channel_history. Inbound: IRC traffic arrives as <channel source="roost-irc"> events with sender, channel, and isDirect attributes. Auto-joined: ${AUTO_JOIN.join(', ') || '(none)'}.`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'channel_message',
      description:
        'Post a message to a channel (e.g., "#roost"). The channel must already be joined.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel name including the leading "#".' },
          text: { type: 'string', description: 'Message text.' },
        },
        required: ['channel', 'text'],
      },
    },
    {
      name: 'direct_message',
      description: 'Send a private message (DM) to another nick.',
      inputSchema: {
        type: 'object',
        properties: {
          nick: { type: 'string', description: 'Recipient nick.' },
          text: { type: 'string', description: 'Message text.' },
        },
        required: ['nick', 'text'],
      },
    },
    {
      name: 'channel_join',
      description: 'Join a channel. Returns when the JOIN is acknowledged.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel name including "#".' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'channel_leave',
      description: 'Leave (PART) a channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel name including "#".' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'channel_who',
      description: 'List nicks currently present in a channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel name including "#".' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'channel_history',
      description:
        'Return up to N recent messages observed by this MCP for a channel or DM peer (since startup, capped at ROOST_IRC_HISTORY).',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description:
              'Channel name (e.g., "#roost") or peer nick for DM history.',
          },
          limit: {
            type: 'number',
            description: 'Max messages to return (default: 20).',
          },
        },
        required: ['channel'],
      },
    },
  ],
}))

// Helper: format an inbound IRC message as a channel-event payload.
const emitChannelEvent = (
  msg: IrcMessage,
  extras: { buffered?: boolean; chunkCount?: number } = {},
) => {
  const seq = ++receiveSeq
  const meta: Record<string, string> = {
    sender: msg.sender,
    channel: msg.channel,
    isDirect: String(msg.isDirect),
    ts: msg.ts,
    seq: String(seq),
    source: SOURCE_NAME,
  }
  if (extras.buffered) {
    meta.buffered = 'true'
    if (extras.chunkCount && extras.chunkCount > 1) {
      meta.chunkCount = String(extras.chunkCount)
    }
  }
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: msg.text, meta },
  })
  process.stderr.write(
    `roost-irc[${NICK}]: <- ${msg.isDirect ? 'DM from' : `${msg.channel} <`}${msg.sender}> ${msg.text.length > 120 ? msg.text.slice(0, 117) + '...' : msg.text}${extras.buffered ? ` [BUFFERED x${extras.chunkCount}]` : ''}\n`,
  )
}

// Emit a JOIN/LEAVE/NICK membership event into the host session as a
// channel notification. event="join" / event="leave" / event="nick"
// distinguishes from regular messages. Content is a short
// human-readable summary; meta carries structured fields.
const emitMembershipEvent = (
  kind: 'join' | 'leave' | 'nick',
  nick: string,
  channel: string,
  extras: { reason?: string; newNick?: string } = {},
) => {
  const ts = new Date().toISOString()
  const seq = ++receiveSeq
  const meta: Record<string, string> = {
    sender: nick,
    channel,
    isDirect: 'false',
    ts,
    seq: String(seq),
    source: SOURCE_NAME,
    event: kind,
  }
  if (extras.reason) meta.reason = extras.reason
  if (extras.newNick) meta.newNick = extras.newNick
  const summary =
    kind === 'join' ? `${nick} joined ${channel}`
    : kind === 'nick' ? `${nick} is now known as ${extras.newNick}`
    : `${nick} left ${channel}${extras.reason ? ` (${extras.reason})` : ''}`
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: summary, meta },
  })
  process.stderr.write(`roost-irc[${NICK}]: <- [${kind}] ${summary}\n`)
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params

  if (!irc_ready) {
    return {
      content: [{ type: 'text', text: 'IRC client not ready (still connecting).' }],
      isError: true,
    }
  }

  switch (name) {
    case 'channel_message': {
      const channel = String(args.channel ?? '')
      const text = String(args.text ?? '')
      const { chunks } = sendWithSplit(channel, text)
      const note = chunks > 1 ? ` (split into ${chunks} chunks for IRC line cap)` : ''
      const preview = text.length > 120 ? text.slice(0, 117) + '...' : text
      return { content: [{ type: 'text', text: `sent to ${channel}: ${preview}${note}` }] }
    }
    case 'direct_message': {
      const nick = String(args.nick ?? '')
      const text = String(args.text ?? '')
      const { chunks } = sendWithSplit(nick, text)
      const note = chunks > 1 ? ` (split into ${chunks} chunks for IRC line cap)` : ''
      const preview = text.length > 120 ? text.slice(0, 117) + '...' : text
      return { content: [{ type: 'text', text: `DM to ${nick}: ${preview}${note}` }] }
    }
    case 'channel_join': {
      const channel = String(args.channel ?? '')
      const ok = await new Promise<boolean>((resolve) => {
        const list = join_resolvers.get(channel) ?? []
        list.push(resolve)
        join_resolvers.set(channel, list)
        client.join(channel)
        // Time out after 5s.
        setTimeout(() => resolve(false), 5000).unref?.()
      })
      return {
        content: [
          { type: 'text', text: ok ? `joined ${channel}` : `join ${channel} timed out` },
        ],
        isError: !ok,
      }
    }
    case 'channel_leave': {
      const channel = String(args.channel ?? '')
      client.part(channel)
      return { content: [{ type: 'text', text: `parted ${channel}` }] }
    }
    case 'channel_who': {
      const channel = String(args.channel ?? '')
      const set = channelUsers.get(channel)
      const users = set ? [...set].sort() : []
      return {
        content: [
          {
            type: 'text',
            text: users.length
              ? `${channel} (${users.length}): ${users.join(', ')}`
              : `${channel}: (no users tracked — not joined yet, or NAMES not received)`,
          },
        ],
      }
    }
    case 'channel_history': {
      const key = String(args.channel ?? '')
      const limit = Number(args.limit ?? 20)
      const buf = history.get(key) ?? []
      const slice = buf.slice(-limit)
      if (slice.length === 0) {
        return {
          content: [
            { type: 'text', text: `no history for ${key} (since this MCP started)` },
          ],
        }
      }
      const lines = slice.map(
        m =>
          `[${m.ts}] ${m.isDirect ? `(DM from ${m.sender})` : `${m.channel} <${m.sender}>`} ${m.text}`,
      )
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }
    default:
      return {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      }
  }
})

// ---- Connect MCP and IRC -----------------------------------------------

await mcp.connect(new StdioServerTransport())
process.stderr.write(`roost-irc[${NICK}]: MCP transport up at ${new Date().toISOString()}\n`)

client.on('registered', () => {
  irc_ready = true
  process.stderr.write(`roost-irc[${NICK}]: registered with ${SERVER}:${PORT}\n`)
  for (const ch of AUTO_JOIN) {
    client.join(ch)
    process.stderr.write(`roost-irc[${NICK}]: auto-joining ${ch}\n`)
  }
})

client.on('join', (event: { nick: string; channel: string }) => {
  if (event.nick === NICK) {
    process.stderr.write(`roost-irc[${NICK}]: joined ${event.channel}\n`)
    // Reset our user set for this channel — userlist (NAMES) will populate it.
    channelUsers.set(event.channel, new Set([NICK]))
    const list = join_resolvers.get(event.channel)
    if (list?.length) {
      for (const r of list) r(true)
      join_resolvers.delete(event.channel)
    }
    return
  }
  ensureChannelSet(event.channel).add(event.nick)
  emitMembershipEvent('join', event.nick, event.channel)
})

// userlist fires after RPL_NAMREPLY/ENDOFNAMES (post-JOIN). Replace the
// channel's user set with the authoritative server-side membership.
client.on(
  'userlist',
  (event: { channel: string; users: Array<{ nick: string }> }) => {
    const set = new Set<string>()
    for (const u of event.users ?? []) {
      if (u?.nick) set.add(u.nick)
    }
    set.add(NICK) // we're definitely there
    channelUsers.set(event.channel, set)
    process.stderr.write(
      `roost-irc[${NICK}]: userlist for ${event.channel}: ${set.size} nicks (${[...set].sort().join(', ')})\n`,
    )
  },
)

client.on(
  'part',
  (event: { nick: string; channel: string; message?: string }) => {
    if (event.nick === NICK) {
      channelUsers.delete(event.channel)
      return
    }
    channelUsers.get(event.channel)?.delete(event.nick)
    emitMembershipEvent('leave', event.nick, event.channel, {
      reason: event.message ? `parted: ${event.message}` : 'parted',
    })
  },
)

// irc-framework KICK shape: event.nick = kicker, event.kicked = victim,
// event.channel, event.message (kick reason). We emit a leave for the
// kicked user.
client.on(
  'kick',
  (event: {
    nick?: string
    kicked: string
    channel: string
    message?: string
  }) => {
    const victim = event.kicked
    if (victim === NICK) {
      channelUsers.delete(event.channel)
      return
    }
    channelUsers.get(event.channel)?.delete(victim)
    emitMembershipEvent('leave', victim, event.channel, {
      reason: `kicked${event.message ? ': ' + event.message : ''}`,
    })
  },
)

// QUIT has no channel scope — remove the nick from every channel we
// track and emit a leave for each one.
client.on('quit', (event: { nick: string; message?: string }) => {
  if (event.nick === NICK) {
    channelUsers.clear()
    return
  }
  for (const [chan, set] of channelUsers) {
    if (set.delete(event.nick)) {
      emitMembershipEvent('leave', event.nick, chan, {
        reason: event.message ? `quit: ${event.message}` : 'quit',
      })
    }
  }
})

// NICK change — rename in every channel set, then emit a single
// nick-change event scoped to the first shared channel (one event is
// enough; the change is global to that user).
client.on('nick', (event: { nick: string; new_nick: string }) => {
  if (event.nick === NICK) return // our own nick change — uninteresting to us
  let firstChan: string | null = null
  for (const [chan, set] of channelUsers) {
    if (set.delete(event.nick)) {
      set.add(event.new_nick)
      if (!firstChan) firstChan = chan
    }
  }
  if (firstChan) {
    emitMembershipEvent('nick', event.nick, firstChan, { newNick: event.new_nick })
  }
})

client.on('message', (event: {
  nick: string
  target: string
  message: string
  type: 'privmsg' | 'notice' | 'action' | string
}) => {
  if (event.nick === NICK) return // don't loop our own messages back
  const isDirect = event.target === NICK
  const channel = isDirect ? event.nick : event.target
  const ts = new Date().toISOString()

  // Strip legacy [roost-split:...] marker if present (backward compat
  // with senders not yet on the buffering build).
  let body = event.message
  const legacy = LEGACY_MARKER_RE.exec(body)
  if (legacy) body = body.slice(legacy[0].length)

  const key = `${event.nick}|${event.target}`
  const existing = recvBuffers.get(key)
  if (existing) {
    clearTimeout(existing.flushTimer)
    existing.text += body
    existing.chunkCount += 1
    // Once we know it's multi-chunk, extend the window to absorb
    // server-side rate-limit pauses between chunks.
    const t = setTimeout(() => flushBuffer(key), EXTENDED_BUFFER_MS)
    t.unref?.()
    existing.flushTimer = t
    return
  }
  const t = setTimeout(() => flushBuffer(key), INITIAL_BUFFER_MS)
  t.unref?.()
  recvBuffers.set(key, {
    text: body,
    chunkCount: 1,
    channel,
    sender: event.nick,
    isDirect,
    firstSeen: Date.now(),
    firstTs: ts,
    flushTimer: t,
  })
})

client.on('socket close', () => {
  process.stderr.write(`roost-irc[${NICK}]: socket closed\n`)
  irc_ready = false
})

client.on('socket error', (err: Error) => {
  process.stderr.write(`roost-irc[${NICK}]: socket error: ${err.message}\n`)
})

client.connect({
  host: SERVER,
  port: PORT,
  nick: NICK,
  username: NICK,
  gecos: REALNAME,
  auto_reconnect: true,
  auto_reconnect_max_retries: 10,
})

process.stderr.write(`roost-irc[${NICK}]: connecting to ${SERVER}:${PORT}...\n`)
