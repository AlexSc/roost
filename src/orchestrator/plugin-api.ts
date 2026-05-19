// Stable public surface for external plugins. Reach here via the
// `roost/plugin` exports map — never the deep `src/orchestrator/...`
// paths. The set re-exported below is the seam: extending or trimming it
// is a deliberate API change. See docs/PLUGINS.md.
export {
  BasePlugin,
  registerPlugin,
  getPluginFactory,
  defaultPluginLogger,
  type Plugin,
  type PluginConfig,
  type PluginFactory,
  type PluginLogger,
  type PluginTickResult,
  type TaggedEvent,
  type TaggedEventPayload,
} from './plugin.js'

export { resolveRepoEntry, type WatchedEntry } from './config.js'

export type { Command } from './dispatcher-dm-handler.js'
