// Plugin instantiation. A plugin not listed in `config.plugins` is not built —
// no default-on. New projects pick up shipped plugins via `bin/roost init`.
import type { OrchestratorConfig } from './config.js'
import { getPluginFactory, priorityOf, registeredPluginNames, type Plugin, type PluginLogger } from './plugin.js'

// Representative lines covering the two bare-grammar shapes defined by
// tryClaimPerN / tryClaimPerRepo in plugins/grammar.ts. Keyword-prefixed
// plugins (e.g. `watch pr 1`) only claim lines starting with their keyword,
// so they can't tie on these probes unless two plugins share a keyword.
// Extend this set when grammar.ts gains a new bare-grammar shape.
const PROBE_LINES = ['watch 1', 'watch org/repo']

type ParseablePlugin = Plugin & { parseCommand: NonNullable<Plugin['parseCommand']> }

function isParseable(p: Plugin): p is ParseablePlugin {
  return typeof p.parseCommand === 'function'
}

// Warn once per conflicting pair: same effective priority AND both claim the
// same probe line. Points operators at `plugin_priorities` in config.json.
export function warnPriorityTies(plugins: Plugin[], config: OrchestratorConfig, log: PluginLogger): void {
  const parseable = plugins.filter(isParseable)
  for (let i = 0; i < parseable.length; i++) {
    for (let j = i + 1; j < parseable.length; j++) {
      const a = parseable[i]
      const b = parseable[j]
      const pri = priorityOf(a, config)
      if (pri !== priorityOf(b, config)) continue
      for (const probe of PROBE_LINES) {
        if (a.parseCommand(probe)?.kind === 'ok' && b.parseCommand(probe)?.kind === 'ok') {
          log(
            `[priority-tie] "${a.name}" and "${b.name}" both claim "${probe}" at priority ${pri};` +
            ` "${b.name}" shadowed by config order.` +
            ` set plugin_priorities.${a.name} or plugin_priorities.${b.name} in config.json to resolve.\n`
          )
          break
        }
      }
    }
  }
}

// Order follows `Object.keys` insertion order so emission order is predictable.
export function buildPlugins(config: OrchestratorConfig, defaultChannel: string, log: PluginLogger): Plugin[] {
  const names = Object.keys(config.plugins ?? {})
  const plugins = names.map(name => {
    const factory = getPluginFactory(name)
    if (!factory) {
      const available = registeredPluginNames().sort().join(', ') || '(none)'
      throw new Error(`unknown plugin in config: ${name}. available: ${available}`)
    }
    return factory(defaultChannel, log)
  })
  warnPriorityTies(plugins, config, log)
  return plugins
}
