#!/usr/bin/env bun
/**
 * Probe: does ngircd forward IRCv3 client message-tags between IRCv3-capable
 * clients? Two clients connect, both negotiate message-tags. Sender sends a
 * PRIVMSG with a +roost-probe tag; receiver checks event.tags.
 */
// @ts-expect-error
import IRC from 'irc-framework'

const SERVER = '127.0.0.1'
const PORT = 6667
const CHAN = '#tag-probe'

const sender = new IRC.Client()
const receiver = new IRC.Client()
let receiverReady = false
let senderReady = false
let receiverJoined = false

const log = (who: string, msg: string) =>
  console.log(`[${who}] ${msg}`)

const trySend = () => {
  if (senderReady && receiverJoined) {
    log('sender', 'sending UNTAGGED control PRIVMSG via raw()')
    sender.raw('PRIVMSG ' + CHAN + ' :control message no tags')
    setTimeout(() => {
      log('sender', 'sending TAGGED PRIVMSG via raw()')
      sender.raw(
        '@+roost-split=abc12345;+roost-index=1;+roost-total=2 PRIVMSG ' +
          CHAN +
          ' :tagged message',
      )
    }, 500)
  }
}

receiver.on('registered', () => {
  log('receiver', 'registered, joining ' + CHAN)
  receiver.join(CHAN)
  receiverReady = true
})
receiver.on('join', (e: any) => {
  if (e.nick === 'tag-receiver') {
    log('receiver', 'joined ' + e.channel)
    receiverJoined = true
    trySend()
  }
})
let messagesSeen = 0
receiver.on('message', (e: any) => {
  messagesSeen++
  log(
    'receiver',
    `message #${messagesSeen} from <${e.nick}> on ${e.target}: ${JSON.stringify({
      message: e.message,
      tags: e.tags,
    })}`,
  )
  if (messagesSeen >= 2) {
    setTimeout(() => {
      sender.quit('done')
      receiver.quit('done')
      setTimeout(() => process.exit(0), 500)
    }, 200)
  }
})

sender.on('registered', () => {
  log('sender', 'registered')
  sender.join(CHAN)
  senderReady = true
  trySend()
})
sender.on('join', (e: any) => {
  if (e.nick === 'tag-sender') {
    log('sender', 'joined ' + e.channel)
  }
})

// Connect both, negotiating message-tags via CAP (irc-framework does this
// automatically when the capability is offered by the server).
sender.connect({ host: SERVER, port: PORT, nick: 'tag-sender', username: 'tag-sender', gecos: 'tag-sender' })
receiver.connect({ host: SERVER, port: PORT, nick: 'tag-receiver', username: 'tag-receiver', gecos: 'tag-receiver' })

// Safety timeout.
setTimeout(() => {
  log('probe', 'TIMEOUT — no message received in 8s')
  process.exit(2)
}, 8000)
