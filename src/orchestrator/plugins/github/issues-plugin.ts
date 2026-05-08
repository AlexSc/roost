import type { OrchestratorConfig } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { GhBase } from './base.js'
import { scrapeIssue } from './scraper.js'
import { issueEventChannels, formatPayload } from './format.js'
import { shouldPush } from './diff.js'
import type { IssueSnap, IssuePluginState } from './types.js'

export class GitHubIssuesPlugin extends GhBase {
  readonly name = 'github-issues'

  desiredChannels(config: OrchestratorConfig): string[] {
    return this.entryChannels(config.watched_issues, config.repo)
  }

  async runTick(
    config: OrchestratorConfig,
    prevState: unknown
  ): Promise<PluginTickResult> {
    const defaultRepo = config.repo
    const watched = config.watched_issues ?? []
    const agentLogins = this.agentLogins(config)

    const prev = prevState as IssuePluginState | null
    const seeding = prev === null

    const curState: IssuePluginState = { issues: {} }
    const taggedEvents: TaggedEvent[] = []

    for (const entry of watched) {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevIssue: IssueSnap | null | undefined = seeding ? undefined : (prev?.issues[key] ?? null)
      const { snap, events } = await scrapeIssue(repo, number, prevIssue, agentLogins)
      curState.issues[key] = snap
      for (const event of events) {
        if (!shouldPush(event)) continue
        taggedEvents.push({
          channels: this.resolveChannels(issueEventChannels(event), entryChannels),
          payload: formatPayload(event),
        })
      }
    }

    return { state: curState, taggedEvents, channels: this.desiredChannels(config) }
  }
}
