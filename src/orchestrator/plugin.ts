// Plugin seam (#116). A plugin owns a slice of `state.plugins[name]`,
// declares which IRC channels it wants joined, and on each tick returns
// pre-routed events. The dispatcher itself is plugin-agnostic — it just
// walks `TaggedEvent[]` and writes to IRC.
import type { OrchestratorConfig } from './config.js'
import type { OrchestratorEvent } from './diff.js'

export interface TaggedEvent {
  event: OrchestratorEvent
  channels: string[]
}

export interface PluginTickResult {
  state: unknown
  taggedEvents: TaggedEvent[]
  // Comprehensive channel set the plugin wants joined now — includes dynamic
  // members only learnable after scraping (PR linked-issues channels), so
  // the orchestrator picks them up post-tick. Pre-tick boot uses the
  // synchronous desiredChannels(config) view instead.
  channels: string[]
}

export interface PluginTickOpts {
  seed: boolean
}

export interface Plugin {
  readonly name: string
  // Synchronous, config-only view of channels the plugin wants joined at boot,
  // before the first tick. Does NOT include the project/default channel —
  // the orchestrator unions that in itself.
  desiredChannels(config: OrchestratorConfig): string[]
  // Per-tick: state slice + tagged events + the live channel set (post-scrape,
  // including dynamic discoveries like PR linked-issues). The returned
  // `channels` does NOT include the project/default channel — orchestrator
  // unions it in. Same contract as desiredChannels.
  runTick(config: OrchestratorConfig, prevState: unknown, opts: PluginTickOpts): Promise<PluginTickResult>
}

export abstract class BasePlugin implements Plugin {
  abstract readonly name: string
  constructor(protected readonly defaultChannel: string) {}
  abstract desiredChannels(config: OrchestratorConfig): string[]
  abstract runTick(config: OrchestratorConfig, prevState: unknown, opts: PluginTickOpts): Promise<PluginTickResult>

  // Union auto-detected channels (PR linked-issues, issue's own channel) with
  // the entry's declared channels; fall back to the default channel if both
  // are empty — defensive for any future entity-less event the dispatcher
  // might receive (today's dispatcher-error path goes via direct client.say).
  protected resolveChannels(autoDetected: string[], entryChannels: string[] = []): string[] {
    const merged = Array.from(new Set([...autoDetected, ...entryChannels]))
    return merged.length ? merged : [this.defaultChannel]
  }
}
