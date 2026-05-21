import { describe, it, expect } from 'bun:test'
import { LinearScraper, type LinearGraphqlSurface } from '../scraper.js'
import { isTombstone, type LinearIssueSnap } from '../types.js'
import type { RawLinearIssue, LinearSeedEvent } from '../diff.js'

function mockClient(response: RawLinearIssue | null): LinearGraphqlSurface {
  return {
    graphql: async () => ({ issue: response }),
  }
}

function rawIssue(overrides: Partial<RawLinearIssue> = {}): RawLinearIssue {
  return {
    id: 'uuid-1',
    identifier: 'C-758',
    title: 't',
    url: 'https://linear.app/teakio/issue/C-758/t',
    state: { type: 'started', name: 'In Progress' },
    labels: { nodes: [] },
    comments: { nodes: [] },
    attachments: { nodes: [] },
    ...overrides,
  }
}

describe('LinearScraper.scrapeIssue', () => {
  it('seeding (prev=undefined): produces snap, no events', async () => {
    const s = new LinearScraper(mockClient(rawIssue()))
    const r = await s.scrapeIssue('C-758', undefined)
    expect(isTombstone(r.next)).toBe(false)
    expect(r.events).toEqual([])
  })

  it('new-to-watch (prev=null): emits added_to_watch', async () => {
    const s = new LinearScraper(mockClient(rawIssue()))
    const r = await s.scrapeIssue('C-758', null)
    expect(r.events.map(e => e.kind)).toEqual(['linear_issue_added_to_watch'])
  })

  it('new-to-watch with pre-existing comments emits backlog seed', async () => {
    const s = new LinearScraper(mockClient(rawIssue({
      comments: { nodes: [
        { id: 'c1', body: 'old', user: null, parent: null },
        { id: 'c2', body: 'old', user: null, parent: null },
      ] },
    })))
    const r = await s.scrapeIssue('C-758', null)
    expect(r.events.map(e => e.kind)).toEqual([
      'linear_issue_added_to_watch',
      'linear_issue_has_existing_comments',
    ])
    const backlog = r.events.find(e => e.kind === 'linear_issue_has_existing_comments') as LinearSeedEvent
    expect(backlog.comment_count).toBe(2)
  })

  it('normal diff: emits change events vs. prev snap', async () => {
    const prev: LinearIssueSnap = {
      id: 'uuid-1', identifier: 'C-758', title: 't', url: 'https://x', status: 'In Progress',
      statusType: 'started', labels: [], seen_comment_ids: [], seen_github_attachment_ids: [],
    }
    const s = new LinearScraper(mockClient(rawIssue({
      state: { type: 'completed', name: 'Done' },
    })))
    const r = await s.scrapeIssue('C-758', prev)
    expect(r.events.map(e => e.kind)).toContain('linear_state_changed')
  })

  it('disappeared on prev=normal: emits disappeared event + tombstone next', async () => {
    const prev: LinearIssueSnap = {
      id: 'uuid-1', identifier: 'C-758', title: 't', url: 'https://x', status: 'In Progress',
      statusType: 'started', labels: [], seen_comment_ids: [], seen_github_attachment_ids: [],
    }
    const s = new LinearScraper(mockClient(null))
    const r = await s.scrapeIssue('C-758', prev)
    expect(isTombstone(r.next)).toBe(true)
    expect(r.events.map(e => e.kind)).toEqual(['linear_issue_disappeared'])
  })

  it('disappeared on prev=null (new watch, immediately 404): emits once + tombstone next', async () => {
    const s = new LinearScraper(mockClient(null))
    const r = await s.scrapeIssue('C-9999', null)
    expect(isTombstone(r.next)).toBe(true)
    expect(r.events.map(e => e.kind)).toEqual(['linear_issue_disappeared'])
  })

  it('disappeared on prev=undefined (seeding): tombstone next, NO event (silent during seed)', async () => {
    const s = new LinearScraper(mockClient(null))
    const r = await s.scrapeIssue('C-9999', undefined)
    expect(isTombstone(r.next)).toBe(true)
    expect(r.events).toEqual([])
  })

  it('prev=tombstone: no fetch, no event, passes through', async () => {
    let calls = 0
    const c: LinearGraphqlSurface = {
      graphql: async () => { calls++; return { issue: null } },
    }
    const s = new LinearScraper(c)
    const r = await s.scrapeIssue('C-758', { identifier: 'C-758', disappeared: true })
    expect(calls).toBe(0)
    expect(isTombstone(r.next)).toBe(true)
    expect(r.events).toEqual([])
  })

  it('sends issue identifier as the `id` variable', async () => {
    let captured: Record<string, unknown> | undefined
    const c: LinearGraphqlSurface = {
      graphql: async (_q, vars) => { captured = vars; return { issue: rawIssue() } },
    }
    const s = new LinearScraper(c)
    await s.scrapeIssue('ENG-42', null)
    expect(captured).toEqual({ id: 'ENG-42' })
  })
})
