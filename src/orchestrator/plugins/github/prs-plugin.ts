import type { OrchestratorConfig } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { GhBase } from './base.js'
import { scrapePr } from './scraper.js'
import { prEventChannels, formatPayload } from './format.js'
import { shouldPush } from './diff.js'
import type { PrSnap, PrPluginState } from './types.js'

export class GitHubPrsPlugin extends GhBase {
  readonly name = 'github-prs'

  desiredChannels(config: OrchestratorConfig): string[] {
    return this.entryChannels(config.watched_prs, config.repo)
  }

  async runTick(
    config: OrchestratorConfig,
    prevState: unknown
  ): Promise<PluginTickResult> {
    const defaultRepo = config.repo
    const watched = config.watched_prs ?? []
    const agentLogins = this.agentLogins(config)

    const prev = prevState as PrPluginState | null
    const seeding = prev === null

    const curState: PrPluginState = { prs: {} }
    const taggedEvents: TaggedEvent[] = []

    for (const entry of watched) {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevPr: PrSnap | null | undefined = seeding ? undefined : (prev?.prs[key] ?? null)
      const { snap, events } = await scrapePr(repo, number, prevPr, agentLogins)
      curState.prs[key] = snap
      for (const event of events) {
        if (!shouldPush(event)) continue
        taggedEvents.push({
          channels: this.resolveChannels(prEventChannels(event), entryChannels),
          payload: formatPayload(event),
        })
      }
    }

    // Comprehensive channel set: static (config) + dynamic (linked-issues
    // discovered during scrape).
    const channels = new Set<string>(this.desiredChannels(config))
    for (const snap of Object.values(curState.prs)) {
      for (const n of snap.linked_issues ?? []) channels.add(`#issue-${n}`)
    }

    return { state: curState, taggedEvents, channels: [...channels] }
  }
}
