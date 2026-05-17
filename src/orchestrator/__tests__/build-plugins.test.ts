import { describe, it, expect } from 'bun:test'
import { buildPlugins, DEFAULT_ON_PLUGINS } from '../build-plugins.js'
import type { OrchestratorConfig } from '../config.js'
import '../registry.js'

const NOOP_LOG = () => {}

describe('buildPlugins — default-on', () => {
  it('honors explicit plugin keys from config.plugins', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'github-issues': { watched: [] }, 'github-prs': { watched: [] } },
    }
    const names = buildPlugins(cfg, '#proj-leads', NOOP_LOG).map(p => p.name)
    // Explicit plugins come first, then default-on plugins are appended.
    expect(names.slice(0, 2)).toEqual(['github-issues', 'github-prs'])
    for (const def of DEFAULT_ON_PLUGINS) expect(names).toContain(def)
  })

  it('appends `github-new-issues` when repo is set and slice is missing', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'github-issues': { watched: [] } },
    }
    const names = buildPlugins(cfg, '#proj-leads', NOOP_LOG).map(p => p.name)
    expect(names).toContain('github-new-issues')
  })

  it('does not duplicate `github-new-issues` when slice is explicit', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'github-new-issues': {} },
    }
    const names = buildPlugins(cfg, '#proj-leads', NOOP_LOG).map(p => p.name)
    expect(names.filter(n => n === 'github-new-issues')).toHaveLength(1)
  })

  it('skips default-on plugins when repo is unset', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'github-issues': { watched: [] } },
    }
    const names = buildPlugins(cfg, '#proj-leads', NOOP_LOG).map(p => p.name)
    expect(names).not.toContain('github-new-issues')
  })

  it('preserves explicit order, appends defaults at the end', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'github-prs': { watched: [] }, 'github-issues': { watched: [] } },
    }
    const names = buildPlugins(cfg, '#proj-leads', NOOP_LOG).map(p => p.name)
    expect(names).toEqual(['github-prs', 'github-issues', 'github-new-issues'])
  })

  it('throws on unknown plugin key', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'nonexistent': {} },
    }
    expect(() => buildPlugins(cfg, '#proj-leads', NOOP_LOG)).toThrow(/unknown plugin/)
  })
})
