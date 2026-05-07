import { mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const SCHEMA_VERSION = 1

export interface WatchedEntry {
  repo?: string
  number: number
}

export type WatchedEntryInput = number | WatchedEntry

export interface OrchestratorConfig {
  repo?: string
  agent_logins?: string[]
  irc?: {
    nick?: string
    project_channel?: string
    server?: string
    port?: number
    interval_seconds?: number
  }
  watched_prs?: WatchedEntryInput[]
  watched_issues?: WatchedEntryInput[]
}

export interface PrSnap {
  repo: string
  number: number
  title: string | null
  url: string | null
  head_ref: string | null
  head_oid: string | null
  is_draft: boolean
  merged: boolean
  state: string | null
  labels: string[]
  ci_state: string | null
  linked_issues: number[]
  seen_review_comment_ids: number[]
  seen_conversation_comment_ids: number[]
  seen_review_ids: number[]
}

export interface IssueSnap {
  repo: string
  number: number
  title: string | null
  url: string | null
  state: string | null
  labels: string[]
  seen_comment_ids: number[]
}

export interface OrchestratorState {
  schema_version: number
  generated_at: string
  prs: Record<string, PrSnap>
  issues: Record<string, IssueSnap>
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      )
    }
    return v
  }, 2) + '\n'
}

export async function loadConfig(stateDir: string): Promise<OrchestratorConfig> {
  const path = join(stateDir, 'config.json')
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`config missing: ${path}`)
  return file.json() as Promise<OrchestratorConfig>
}

export async function loadState(stateDir: string): Promise<OrchestratorState | null> {
  const path = join(stateDir, 'state.json')
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  const text = (await file.text()).trim()
  if (!text) return null
  const state = JSON.parse(text) as OrchestratorState
  if (state.schema_version !== SCHEMA_VERSION) {
    process.stderr.write(
      `state.json schema mismatch: got ${state.schema_version}, expected ${SCHEMA_VERSION}; re-seeding.\n`
    )
    return null
  }
  return state
}

export async function writeState(stateDir: string, state: OrchestratorState): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const tmp = join(stateDir, `.state.${process.pid}.${Date.now()}.tmp`)
  try {
    await Bun.write(tmp, sortedJson(state))
    await rename(tmp, join(stateDir, 'state.json'))
  } catch (e) {
    try { await unlink(tmp) } catch { /* ignore */ }
    throw e
  }
}

export async function writeHeartbeat(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await Bun.write(join(stateDir, 'last-tick.txt'), new Date().toISOString() + '\n')
}

export async function writeLastError(stateDir: string, tb: string): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true })
    await Bun.write(join(stateDir, 'last-error.txt'), tb)
  } catch { /* best-effort */ }
}

export async function clearLastError(stateDir: string): Promise<void> {
  try { await unlink(join(stateDir, 'last-error.txt')) } catch { /* ignore if missing */ }
}

export function coerceRepoEntry(entry: WatchedEntryInput, defaultRepo?: string): [string, number] {
  if (typeof entry === 'number') {
    if (!defaultRepo) throw new Error(`bare-int watched entry ${entry} requires a top-level repo in config`)
    return [defaultRepo, entry]
  }
  const repo = entry.repo ?? defaultRepo
  if (!repo) throw new Error(`watched entry missing repo: ${JSON.stringify(entry)}`)
  return [repo, entry.number]
}
