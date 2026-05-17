// Project-level issue triage feed. Polls the repo for open issues and emits a
// oneline announcement to the project channel the first time a given issue
// number is observed. Sibling to `github-issues`: that plugin routes activity
// for hand-watched issues; this one surfaces brand-new issues so the team
// doesn't have to notice them manually. Issue #342.
//
// State slice: `{ seen_issue_numbers: number[] }`. Seeding (`prev===null`)
// captures the current open set without emitting — only ticks after seed
// announce. Closed issues that re-open will re-announce only if they were
// pruned from `seen` (we don't prune today, so closed-then-reopened is
// silently suppressed; that's fine, the operator can `watch <N>` for it).
import type { OrchestratorConfig } from '../../config.js'
import { BasePlugin, type PluginLogger, type PluginTickResult, type TaggedEvent, defaultPluginLogger } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
import { fetchRepoOpenIssues, labelNames, type GhRepoIssue } from './github-api.js'

interface NewIssuesPluginConfig {
  repo?: string
  channels?: string[]
}

export interface NewIssuesPluginState {
  seen_issue_numbers: number[]
}

export class GitHubNewIssuesPlugin extends BasePlugin {
  readonly name = 'github-new-issues'

  constructor(defaultChannel: string, protected readonly log: PluginLogger = defaultPluginLogger) {
    super(defaultChannel)
  }

  // Project channel is unioned in by the orchestrator, so the default case
  // returns []. An explicit slice.channels override is surfaced here so those
  // channels join at boot.
  desiredChannels(config: OrchestratorConfig): string[] {
    const slice = this.pluginConfig<NewIssuesPluginConfig>(config) ?? {}
    return slice.channels?.length ? [...slice.channels] : []
  }

  private resolveRepo(config: OrchestratorConfig): string {
    const slice = this.pluginConfig<NewIssuesPluginConfig>(config) ?? {}
    const repo = slice.repo ?? config.repo
    if (!repo) throw new Error('github-new-issues: no repo (set `repo` at top level or under plugins.github-new-issues)')
    return repo
  }

  private resolveAnnouncementChannels(config: OrchestratorConfig): string[] {
    const slice = this.pluginConfig<NewIssuesPluginConfig>(config) ?? {}
    if (slice.channels?.length) return slice.channels
    return [resolveProjectChannel(config)]
  }

  async runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult> {
    const repo = this.resolveRepo(config)
    const issues = await fetchRepoOpenIssues(this.log, repo)
    const currentNumbers = issues
      .map(i => i.number)
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b)

    const prev = prevState as NewIssuesPluginState | null
    const seen = new Set<number>(prev?.seen_issue_numbers ?? [])
    const taggedEvents: TaggedEvent[] = []

    if (prev !== null) {
      const announcementChannels = this.resolveAnnouncementChannels(config)
      const newIssues = issues
        .filter(i => i.number != null && !seen.has(i.number))
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      for (const issue of newIssues) {
        taggedEvents.push({
          channels: announcementChannels,
          payload: { kind: 'oneline', text: formatNewIssue(repo, issue) },
        })
      }
    }

    // Always merge — even on seed — so seen accumulates from tick 1.
    for (const n of currentNumbers) seen.add(n)

    const state: NewIssuesPluginState = { seen_issue_numbers: [...seen].sort((a, b) => a - b) }
    return { state, taggedEvents, channels: [] }
  }
}

export function formatNewIssue(repo: string, issue: GhRepoIssue): string {
  const tag = `${repo}#${issue.number}`
  const title = issue.title ?? ''
  const labels = labelNames(issue.labels)
  const labelStr = labels.length ? ` [${labels.join(', ')}]` : ''
  const url = issue.html_url ?? ''
  return `new issue ${tag}: ${title}${labelStr} — ${url}`
}
