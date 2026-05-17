// Plugin instantiation. Separate module so the config → ordered Plugin[]
// surface stays focused and testable. A plugin not listed under
// `config.plugins` is not instantiated — there is no default-on. New
// projects pick the shipped plugins up via `bin/roost init`'s template.
import type { OrchestratorConfig } from './config.js'
import { getPluginFactory, registeredPluginNames, type Plugin, type PluginLogger } from './plugin.js'

// Instantiate plugins from `config.plugins` via the registry. Order follows
// `Object.keys` insertion order in the config JSON, so emission order is
// predictable from the operator's POV.
export function buildPlugins(config: OrchestratorConfig, defaultChannel: string, log: PluginLogger): Plugin[] {
  const names = Object.keys(config.plugins ?? {})
  return names.map(name => {
    const factory = getPluginFactory(name)
    if (!factory) {
      const available = registeredPluginNames().sort().join(', ') || '(none)'
      throw new Error(`unknown plugin in config: ${name}. available: ${available}`)
    }
    return factory(defaultChannel, log)
  })
}
