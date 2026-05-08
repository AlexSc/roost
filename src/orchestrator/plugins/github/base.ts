// GhBase — shared scaffolding for the two GitHub plugins (PRs, issues).
// Owns nothing except a tiny ergonomic surface: agent-login set, default repo,
// and a shared helper for collecting `<issue-channel> + entry.channels` from a
// WatchedEntry list. Channel resolution + default-channel fallback come from
// BasePlugin.
import type { OrchestratorConfig, WatchedEntry } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import { defaultProject, issueChannel } from '../../naming.js'
import { BasePlugin } from '../../plugin.js'

export abstract class GhBase extends BasePlugin {
  protected agentLogins(config: OrchestratorConfig): Set<string> {
    return new Set(config.agent_logins ?? [])
  }

  // No watches → no project lookup (avoids requiring `project`/`repo` on
  // minimal configs).
  protected entryChannels(config: OrchestratorConfig, entries: WatchedEntry[] | undefined): string[] {
    if (!entries?.length) return []
    const project = defaultProject(config)
    const chans = new Set<string>()
    for (const entry of entries) {
      const { number, channels } = resolveRepoEntry(entry, config.repo)
      chans.add(issueChannel(project, number))
      for (const c of channels) chans.add(c)
    }
    return [...chans]
  }
}
