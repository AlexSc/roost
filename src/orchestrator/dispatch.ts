import type { RoostIrcClient } from '../irc-client.js'
import type { SystemKind, ConnectOpts } from '../irc-client.js'
import type { TaggedEvent } from './plugin.js'

export async function waitForReady(
  client: RoostIrcClient,
  timeoutMs = 10_000
): Promise<void> {
  if (client.isReady()) return
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('IRC connection timed out'))
    }, timeoutMs)
    client.on('system', (kind: SystemKind) => {
      if (kind === 'registered') {
        clearTimeout(timer)
        resolve()
      } else if (kind === 'registration-failed') {
        clearTimeout(timer)
        reject(new Error('IRC registration failed'))
      }
    })
  })
}

export async function connectAndWait(
  client: RoostIrcClient,
  opts: ConnectOpts,
  channels: string[]
): Promise<void> {
  client.connect(opts)
  await waitForReady(client)
  await Promise.all(channels.map(ch => client.join(ch)))
}

// Pure plumbing: pre-routed, pre-formatted events in, IRC writes out.
// The dispatcher knows how to write the two payload variants but nothing
// about plugins, event kinds, or routing rules. say() is a synchronous
// socket write with no delivery ack — a mid-tick disconnect drops in-flight
// events silently.
export async function dispatchTaggedEvents(
  taggedEvents: TaggedEvent[],
  client: RoostIrcClient
): Promise<void> {
  const failures: string[] = []
  for (const { channels, payload } of taggedEvents) {
    const seen = new Set<string>()
    for (const target of channels) {
      if (seen.has(target)) continue
      seen.add(target)
      try {
        if (payload.kind === 'oneline') {
          client.say(target, payload.text)
        } else {
          client.say(target, [payload.header, payload.body, payload.url].join('\n'))
        }
      } catch (e) {
        failures.push(`${payload.kind} -> ${target}: ${e}`)
      }
    }
  }
  if (failures.length) throw new Error(failures.join('; '))
}
