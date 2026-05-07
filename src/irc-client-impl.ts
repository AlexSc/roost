// @ts-expect-error — irc-framework lacks first-class type defs
import IRC from 'irc-framework'
import { MULTILINE_LINE_BYTES } from './constants.js'
import {
  splitLineForMultiline,
  newBatchId,
  reassembleMultilineBatch,
} from './irc-lib.js'
import type {
  RoostIrcClient,
  ClientConfig,
  ConnectOpts,
  IrcMessage,
  MessageMeta,
  MembershipExtras,
  UnreadInfo,
} from './irc-client.js'

const CAP_CHATHISTORY = 'chathistory'

export class RoostIrcClientImpl implements RoostIrcClient {
  private readonly nick: string
  private readonly historySize: number
  private readonly joinHistoryLines: number
  private readonly joinHistoryMinutes: number
  private readonly autoJoin: string[]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly irc: any

  private irc_ready = false
  private hasRegistered = false
  private readonly joinResolvers = new Map<string, Array<(ok: boolean) => void>>()
  private readonly partResolvers = new Map<string, Array<(ok: boolean) => void>>()
  private multilineMaxLines = 100
  private readonly history = new Map<string, IrcMessage[]>()
  private readonly unread = new Map<string, UnreadInfo>()
  private readonly seenFingerprints = new Map<string, Set<string>>()
  private readonly channelUsers = new Map<string, Set<string>>()

  private readonly messageHandlers: Array<(msg: IrcMessage, meta: MessageMeta) => void> = []
  private readonly membershipHandlers: Array<(kind: 'join' | 'leave' | 'nick', nick: string, channel: string, extras: MembershipExtras) => void> = []
  private readonly systemHandlers: Array<(kind: 'disconnected' | 'reconnected', content: string) => void> = []

  constructor(config: ClientConfig) {
    this.nick = config.nick
    this.historySize = config.historySize
    this.joinHistoryLines = config.joinHistoryLines
    this.joinHistoryMinutes = config.joinHistoryMinutes
    this.autoJoin = config.autoJoin
    this.irc = new IRC.Client()
    this.registerHandlers()
  }

  // ---- Public interface --------------------------------------------------

  connect(opts: ConnectOpts): void {
    this.irc.requestCap(['draft/multiline', 'labeled-response', CAP_CHATHISTORY, 'server-time'])
    this.irc.connect({
      host: opts.host,
      port: opts.port,
      nick: opts.nick,
      username: opts.username ?? opts.nick,
      gecos: opts.gecos ?? opts.nick,
      auto_reconnect: opts.autoReconnect ?? false,
      auto_reconnect_max_retries: opts.autoReconnectMaxRetries,
    })
  }

  isReady(): boolean { return this.irc_ready }
  isJoined(channel: string): boolean { return this.channelUsers.has(channel) }

  async join(channel: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const list = this.joinResolvers.get(channel) ?? []
      list.push(resolve)
      this.joinResolvers.set(channel, list)
      this.irc.join(channel)
      setTimeout(() => resolve(false), 5000).unref?.()
    })
  }

  async leave(channel: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const list = this.partResolvers.get(channel) ?? []
      list.push(resolve)
      this.partResolvers.set(channel, list)
      this.irc.part(channel)
      setTimeout(() => resolve(false), 5000).unref?.()
    })
  }

  say(target: string, text: string): { chunks: number; mode: 'single' | 'multiline' } {
    if (text.length <= MULTILINE_LINE_BYTES && !text.includes('\n')) {
      this.irc.say(target, text)
      return { chunks: 1, mode: 'single' }
    }

    const id = newBatchId()
    const logicalLines = text.split('\n')
    const wireLines: Array<{ body: string; concat: boolean }> = []
    for (const line of logicalLines) {
      const chunks = splitLineForMultiline(line)
      chunks.forEach((chunk, idx) => {
        wireLines.push({ body: chunk, concat: idx > 0 })
      })
    }

    if (wireLines.length > this.multilineMaxLines) {
      process.stderr.write(
        `roost-irc[${this.nick}]: multiline target=${target} would emit ${wireLines.length} lines, exceeds server max ${this.multilineMaxLines}; sending anyway\n`,
      )
    }

    this.irc.raw('BATCH', `+${id}`, 'draft/multiline', target)
    for (const { body, concat } of wireLines) {
      const tagStr = concat ? `batch=${id};draft/multiline-concat` : `batch=${id}`
      this.irc.connection.write(`@${tagStr} PRIVMSG ${target} :${body}`)
    }
    this.irc.raw('BATCH', `-${id}`)
    process.stderr.write(
      `roost-irc[${this.nick}]: multiline outbound to ${target} as batch ${id} (${wireLines.length} lines, ${text.length} bytes)\n`,
    )
    return { chunks: wireLines.length, mode: 'multiline' }
  }

  async whoisChannels(): Promise<string[] | false> {
    return new Promise<string[] | false>((resolve) => {
      this.irc.whois(this.nick, (event: { channels?: string }) => {
        if (!event.channels) { resolve([]); return }
        const list = event.channels
          .split(' ')
          .map((ch: string) => ch.replace(/^[@+%&~]+/, ''))
          .filter(Boolean)
          .sort()
        resolve(list)
      })
      setTimeout(() => resolve(false), 5000).unref?.()
    })
  }

  getHistory(key: string, limit = 20): IrcMessage[] {
    const buf = this.history.get(key) ?? []
    return buf.slice(-limit)
  }

  getUsers(channel: string): string[] {
    const set = this.channelUsers.get(channel)
    return set ? [...set].sort() : []
  }

  getUnread(): ReadonlyMap<string, UnreadInfo> { return this.unread }
  ackUnread(key: string): void { this.unread.delete(key) }
  clearDedupeCache(): void { this.seenFingerprints.clear() }

  quit(): void { this.irc.quit() }

  on(event: 'message', handler: (msg: IrcMessage, meta: MessageMeta) => void): void
  on(event: 'membership', handler: (kind: 'join' | 'leave' | 'nick', nick: string, channel: string, extras: MembershipExtras) => void): void
  on(event: 'system', handler: (kind: 'disconnected' | 'reconnected', content: string) => void): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void {
    if (event === 'message') this.messageHandlers.push(handler)
    else if (event === 'membership') this.membershipHandlers.push(handler)
    else if (event === 'system') this.systemHandlers.push(handler)
  }

  // ---- Private helpers ---------------------------------------------------

  private pushHistory(key: string, msg: IrcMessage): void {
    const buf = this.history.get(key) ?? []
    buf.push(msg)
    while (buf.length > this.historySize) buf.shift()
    this.history.set(key, buf)
  }

  private msgFingerprint(msg: IrcMessage): string {
    return `${msg.sender}|${msg.ts}|${msg.text}`
  }

  private addFingerprint(msg: IrcMessage): void {
    let set = this.seenFingerprints.get(msg.channel)
    if (!set) {
      set = new Set()
      this.seenFingerprints.set(msg.channel, set)
    }
    const fp = this.msgFingerprint(msg)
    if (set.has(fp)) return
    set.add(fp)
    while (set.size > this.historySize) set.delete(set.values().next().value!)
  }

  private hasFingerprint(msg: IrcMessage): boolean {
    return this.seenFingerprints.get(msg.channel)?.has(this.msgFingerprint(msg)) ?? false
  }

  private ensureChannelSet(channel: string): Set<string> {
    let set = this.channelUsers.get(channel)
    if (!set) {
      set = new Set()
      this.channelUsers.set(channel, set)
    }
    return set
  }

  private emitMessage(msg: IrcMessage, meta: MessageMeta): void {
    for (const h of this.messageHandlers) h(msg, meta)
  }

  private emitMembership(kind: 'join' | 'leave' | 'nick', nick: string, channel: string, extras: MembershipExtras = {}): void {
    for (const h of this.membershipHandlers) h(kind, nick, channel, extras)
  }

  private emitSystem(kind: 'disconnected' | 'reconnected', content: string): void {
    for (const h of this.systemHandlers) h(kind, content)
  }

  // ---- IRC event handlers ------------------------------------------------

  private registerHandlers(): void {
    this.irc.on('registered', () => {
      this.irc_ready = true
      process.stderr.write(`roost-irc[${this.nick}]: registered with the IRC server\n`)
      const enabled = this.irc.network?.cap?.enabled ?? []
      const available: Map<string, string> = this.irc.network?.cap?.available ?? new Map()
      if (enabled.includes('draft/multiline')) {
        const val = available.get('draft/multiline') || ''
        for (const kv of val.split(',')) {
          const [k, v] = kv.split('=')
          const n = Number(v)
          if (!Number.isFinite(n) || n <= 0) continue
          if (k === 'max-lines') this.multilineMaxLines = n
        }
        process.stderr.write(
          `roost-irc[${this.nick}]: draft/multiline enabled (max-lines=${this.multilineMaxLines})\n`,
        )
      } else {
        process.stderr.write(
          `roost-irc[${this.nick}]: draft/multiline NOT enabled (server caps: ${enabled.join(',') || '(none)'}) — exiting, server must support draft/multiline\n`,
        )
        process.exit(1)
      }
      process.stderr.write(
        enabled.includes(CAP_CHATHISTORY)
          ? `roost-irc[${this.nick}]: chathistory cap active — will replay up to ${this.joinHistoryLines} msgs / ${this.joinHistoryMinutes}min on join\n`
          : `roost-irc[${this.nick}]: chathistory cap NOT active — no history replay on join\n`,
      )

      if (this.hasRegistered) {
        const snapshot = [...this.channelUsers.keys()].sort()
        this.channelUsers.clear()
        const content = snapshot.length > 0
          ? `[roost] reconnected to IRC — rejoining: ${snapshot.join(', ')}`
          : '[roost] reconnected to IRC'
        this.emitSystem('reconnected', content)
        for (const ch of snapshot) {
          this.irc.join(ch)
          process.stderr.write(`roost-irc[${this.nick}]: reconnect-rejoining ${ch}\n`)
        }
        return
      }

      this.hasRegistered = true
      for (const ch of this.autoJoin) {
        this.irc.join(ch)
        process.stderr.write(`roost-irc[${this.nick}]: auto-joining ${ch}\n`)
      }
    })

    this.irc.on('join', (event: { nick: string; channel: string }) => {
      if (event.nick === this.nick) {
        process.stderr.write(`roost-irc[${this.nick}]: joined ${event.channel}\n`)
        this.channelUsers.set(event.channel, new Set([this.nick]))
        const list = this.joinResolvers.get(event.channel)
        if (list?.length) {
          for (const r of list) r(true)
          this.joinResolvers.delete(event.channel)
        }
        return
      }
      this.ensureChannelSet(event.channel).add(event.nick)
      this.emitMembership('join', event.nick, event.channel)
    })

    this.irc.on(
      'userlist',
      (event: { channel: string; users: Array<{ nick: string }> }) => {
        const set = new Set<string>()
        for (const u of event.users ?? []) {
          if (u?.nick) set.add(u.nick)
        }
        set.add(this.nick)
        this.channelUsers.set(event.channel, set)
        process.stderr.write(
          `roost-irc[${this.nick}]: userlist for ${event.channel}: ${set.size} nicks (${[...set].sort().join(', ')})\n`,
        )
      },
    )

    this.irc.on(
      'part',
      (event: { nick: string; channel: string; message?: string }) => {
        if (event.nick === this.nick) {
          const list = this.partResolvers.get(event.channel)
          if (list?.length) {
            for (const r of list) r(true)
            this.partResolvers.delete(event.channel)
          }
          this.channelUsers.delete(event.channel)
          return
        }
        this.channelUsers.get(event.channel)?.delete(event.nick)
        this.emitMembership('leave', event.nick, event.channel, {
          reason: event.message ? `parted: ${event.message}` : 'parted',
        })
      },
    )

    this.irc.on(
      'kick',
      (event: { nick?: string; kicked: string; channel: string; message?: string }) => {
        const victim = event.kicked
        if (victim === this.nick) {
          this.channelUsers.delete(event.channel)
          return
        }
        this.channelUsers.get(event.channel)?.delete(victim)
        this.emitMembership('leave', victim, event.channel, {
          reason: `kicked${event.message ? ': ' + event.message : ''}`,
        })
      },
    )

    this.irc.on('quit', (event: { nick: string; message?: string }) => {
      if (event.nick === this.nick) {
        this.channelUsers.clear()
        return
      }
      for (const [chan, set] of this.channelUsers) {
        if (set.delete(event.nick)) {
          this.emitMembership('leave', event.nick, chan, {
            reason: event.message ? `quit: ${event.message}` : 'quit',
          })
        }
      }
    })

    this.irc.on('nick', (event: { nick: string; new_nick: string }) => {
      if (event.nick === this.nick) return
      let firstChan: string | null = null
      for (const [chan, set] of this.channelUsers) {
        if (set.delete(event.nick)) {
          set.add(event.new_nick)
          if (!firstChan) firstChan = chan
        }
      }
      if (firstChan) {
        this.emitMembership('nick', event.nick, firstChan, { newNick: event.new_nick })
      }
    })

    this.irc.on('message', (event: {
      nick: string
      target: string
      message: string
      type: 'privmsg' | 'notice' | 'action' | string
      batch?: { id: string; type: string; params: string[] }
      tags?: Record<string, string>
    }) => {
      if (event.nick === this.nick) return
      if (event.batch?.type === 'draft/multiline') return
      if (event.batch?.type === CAP_CHATHISTORY) return
      const isDirect = event.target === this.nick
      const channel = isDirect ? event.nick : event.target
      const ts = event.tags?.['time'] ?? new Date().toISOString()
      const msg: IrcMessage = { channel, sender: event.nick, text: event.message, ts, isDirect }
      this.pushHistory(channel, msg)
      this.addFingerprint(msg)
      const prev = this.unread.get(channel)
      this.unread.set(channel, { count: (prev?.count ?? 0) + 1, lastSender: msg.sender, lastPreview: msg.text })
      this.emitMessage(msg, {})
    })

    this.irc.on(
      'batch end draft/multiline',
      (event: {
        id: string
        params: string[]
        commands: Array<{
          command: string
          params: string[]
          nick: string
          tags: Record<string, unknown>
          getServerTime?: () => number | undefined
        }>
      }) => {
        const target = event.params[0]
        if (!target) return
        const cmds = event.commands.filter(c => c.command === 'PRIVMSG')
        if (cmds.length === 0) return
        const sender = cmds[0].nick
        if (sender === this.nick) return

        const text = reassembleMultilineBatch(cmds)
        const isDirect = target === this.nick
        const channel = isDirect ? sender : target
        const serverTimeMs = cmds[0].getServerTime?.()
        const ts = (serverTimeMs ? new Date(serverTimeMs) : new Date()).toISOString()
        const msg: IrcMessage = { channel, sender, text, ts, isDirect }
        this.pushHistory(channel, msg)
        this.addFingerprint(msg)
        const prev = this.unread.get(channel)
        this.unread.set(channel, { count: (prev?.count ?? 0) + 1, lastSender: msg.sender, lastPreview: msg.text })
        this.emitMessage(msg, { buffered: cmds.length > 1, chunkCount: cmds.length })
      },
    )

    this.irc.on(
      'batch end chathistory',
      (event: {
        id: string
        params: string[]
        commands: Array<{
          command: string
          params: string[]
          nick: string
          tags: Record<string, unknown>
          getServerTime?: () => number | undefined
        }>
      }) => {
        const target = event.params[0]
        if (!target) return
        const cutoffMs = this.joinHistoryMinutes > 0 ? Date.now() - this.joinHistoryMinutes * 60_000 : 0
        const batch: IrcMessage[] = []
        for (const c of event.commands) {
          if (c.command !== 'PRIVMSG') continue
          const sender = c.nick
          if (!sender || sender === this.nick) continue
          const text = c.params[c.params.length - 1] ?? ''
          const isDirect = target === this.nick
          const channel = isDirect ? sender : target
          const serverTimeMs = c.getServerTime?.()
          if (cutoffMs > 0 && serverTimeMs !== undefined && serverTimeMs < cutoffMs) continue
          const ts = (serverTimeMs ? new Date(serverTimeMs) : new Date()).toISOString()
          batch.push({ channel, sender, text, ts, isDirect })
        }
        const limited = this.joinHistoryLines > 0 ? batch.slice(-this.joinHistoryLines) : batch
        for (const msg of limited) {
          if (this.hasFingerprint(msg)) {
            process.stderr.write(`roost-irc[${this.nick}]: chathistory dedup skip ${msg.sender}@${msg.channel} ${msg.ts}\n`)
            continue
          }
          this.addFingerprint(msg)
          this.pushHistory(msg.channel, msg)
          this.emitMessage(msg, { historical: true })
        }
      },
    )

    this.irc.on('socket close', () => {
      process.stderr.write(`roost-irc[${this.nick}]: socket closed\n`)
      this.irc_ready = false
      this.emitSystem('disconnected', '[roost] disconnected from IRC — channel state may be stale until reconnect')
    })

    this.irc.on('socket error', (err: Error) => {
      process.stderr.write(`roost-irc[${this.nick}]: socket error: ${err.message}\n`)
    })
  }
}
