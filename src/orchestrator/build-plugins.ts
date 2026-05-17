// Plugin instantiation. Separate module so the default-on behavior (#342) is
// testable without importing orchestrator.ts (which executes `main()` at load).
import type { OrchestratorConfig } from './config.js'
import { getPluginFactory, registeredPluginNames, type Plugin, type PluginLogger } from './plugin.js'

// Plugins enabled by default when `config.repo` is set, even if the slice
// isn't present in config.json. Lets existing projects benefit from triage
// announcements (#342) without a config edit.
//
// Today only `github-new-issues` is default-on; older plugins (`github-prs`,
// `github-issues`) need an explicit slice because they're scoped to specific
// watched entries — auto-enabling them would do nothing useful.
export const DEFAULT_ON_PLUGINS = ['github-new-issues'] as const

// Instantiate plugins from `config.plugins` via the registry. Order follows
// `Object.keys` insertion order in the config JSON, with default-on plugins
// appended at the end when missing. Predictable emission order from the
// operator's POV.
export function buildPlugins(config: OrchestratorConfig, defaultChannel: string, log: PluginLogger): Plugin[] {
  const explicit = Object.keys(config.plugins ?? {})
  const explicitSet = new Set(explicit)
  const implicit = config.repo
    ? DEFAULT_ON_PLUGINS.filter(n => !explicitSet.has(n))
    : []
  const names = [...explicit, ...implicit]
  return names.map(name => {
    const factory = getPluginFactory(name)
    if (!factory) {
      const available = registeredPluginNames().sort().join(', ') || '(none)'
      throw new Error(`unknown plugin in config: ${name}. available: ${available}`)
    }
    return factory(defaultChannel, log)
  })
}
