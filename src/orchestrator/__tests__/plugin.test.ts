import { describe, it, expect, spyOn } from 'bun:test'
import { BasePlugin, type PluginTickResult } from '../plugin.js'
import { GitHubPlugin } from '../github-plugin.js'
import type { OrchestratorConfig, PrSnap, IssueSnap } from '../config.js'
import { resolveRepoEntry } from '../config.js'
import * as scraper from '../scraper.js'
import type { OrchestratorEvent } from '../diff.js'

class TestPlugin extends BasePlugin {
  readonly name = 'test'
  desiredChannels(): string[] { return [] }
  async runTick(): Promise<PluginTickResult> {
    return { state: null, taggedEvents: [], channels: [] }
  }
  resolve(autoDetected: string[], entryChannels: string[]): string[] {
    return this.resolveChannels(autoDetected, entryChannels)
  }
}

describe('BasePlugin.resolveChannels', () => {
  const p = new TestPlugin('#proj')

  it('unions auto-detected and entry channels with dedupe', () => {
    expect(p.resolve(['#issue-14'], ['#issue-7', '#issue-14'])).toEqual(['#issue-14', '#issue-7'])
  })

  it('returns auto-detected when entry channels empty', () => {
    expect(p.resolve(['#issue-25'], [])).toEqual(['#issue-25'])
  })

  it('returns entry channels when auto-detected empty', () => {
    expect(p.resolve([], ['#side-channel'])).toEqual(['#side-channel'])
  })

  it('falls back to default channel when both empty', () => {
    expect(p.resolve([], [])).toEqual(['#proj'])
  })
})

describe('resolveRepoEntry', () => {
  it('returns repo, number, and channels (defaulting channels to [])', () => {
    expect(resolveRepoEntry({ number: 5 }, 'org/repo')).toEqual({ repo: 'org/repo', number: 5, channels: [] })
  })

  it('honors entry-specific repo override', () => {
    expect(resolveRepoEntry({ repo: 'other/repo', number: 5 }, 'org/repo')).toEqual({ repo: 'other/repo', number: 5, channels: [] })
  })

  it('passes channels through', () => {
    expect(resolveRepoEntry({ number: 5, channels: ['#a', '#b'] }, 'org/repo')).toEqual({ repo: 'org/repo', number: 5, channels: ['#a', '#b'] })
  })

  it('throws when no repo available', () => {
    expect(() => resolveRepoEntry({ number: 5 })).toThrow(/missing repo/)
  })
})

describe('GitHubPlugin.runTick — entry channels + auto-detected union', () => {
  function fakePrSnap(overrides: Partial<PrSnap> = {}): PrSnap {
    return {
      repo: 'org/repo', number: 25, title: 'P', url: 'https://example.com/p/25',
      head_ref: 'feat/x', head_oid: 'abc', is_draft: false, merged: false,
      state: 'OPEN', labels: [], ci_state: null, linked_issues: [],
      seen_review_comment_ids: [], seen_conversation_comment_ids: [], seen_review_ids: [],
      ...overrides,
    }
  }
  function fakeIssueSnap(overrides: Partial<IssueSnap> = {}): IssueSnap {
    return {
      repo: 'org/repo', number: 50, title: 'I', url: 'https://example.com/i/50',
      state: 'open', labels: [], seen_comment_ids: [], ...overrides,
    }
  }

  it('routes a PR comment to linked-issue channels unioned with entry channels', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 25, url: 'https://example.com/p/25',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [14],
    } as OrchestratorEvent

    const prSpy = spyOn(scraper, 'scrapePr').mockResolvedValue({
      snap: fakePrSnap({ linked_issues: [14] }),
      events: [commentEv],
    })
    const issueSpy = spyOn(scraper, 'scrapeIssue').mockResolvedValue({
      snap: fakeIssueSnap(), events: [],
    })

    try {
      const cfg: OrchestratorConfig = {
        repo: 'org/repo',
        watched_prs: [{ number: 25, channels: ['#extra'] }],
        watched_issues: [],
      }
      const result = await new GitHubPlugin('#proj').runTick(cfg, { prs: {}, issues: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels.sort()).toEqual(['#extra', '#issue-14'])
      expect(result.channels.sort()).toContain('#issue-14')
      expect(result.channels.sort()).toContain('#extra')
    } finally {
      prSpy.mockRestore()
      issueSpy.mockRestore()
    }
  })

  it('routes an issue comment to its own channel unioned with entry channels', async () => {
    const issueEv: OrchestratorEvent = {
      kind: 'issue_comment',
      repo: 'org/repo', issue: 50, url: 'https://example.com/i/50',
      author: 'bob', body: 'y', body_preview: 'y', is_worker_reply: false,
      comment_id: 2, comment_url: 'https://example.com/c/2',
    } as OrchestratorEvent

    const prSpy = spyOn(scraper, 'scrapePr').mockResolvedValue({
      snap: fakePrSnap(), events: [],
    })
    const issueSpy = spyOn(scraper, 'scrapeIssue').mockResolvedValue({
      snap: fakeIssueSnap(), events: [issueEv],
    })

    try {
      const cfg: OrchestratorConfig = {
        repo: 'org/repo',
        watched_prs: [],
        watched_issues: [{ number: 50, channels: ['#leads'] }],
      }
      const result = await new GitHubPlugin('#proj').runTick(cfg, { prs: {}, issues: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels.sort()).toEqual(['#issue-50', '#leads'])
    } finally {
      prSpy.mockRestore()
      issueSpy.mockRestore()
    }
  })

  it('persists scraped state under its own slice', async () => {
    const prSpy = spyOn(scraper, 'scrapePr').mockResolvedValue({
      snap: fakePrSnap({ linked_issues: [7] }), events: [],
    })
    const issueSpy = spyOn(scraper, 'scrapeIssue').mockResolvedValue({
      snap: fakeIssueSnap(), events: [],
    })
    try {
      const cfg: OrchestratorConfig = {
        repo: 'org/repo',
        watched_prs: [{ number: 25 }],
        watched_issues: [],
      }
      const result = await new GitHubPlugin('#proj').runTick(cfg, null)
      const state = result.state as { prs: Record<string, PrSnap> }
      expect(state.prs['org/repo#25']?.linked_issues).toEqual([7])
      // Linked-issue channel discovered post-scrape lands in the channel set.
      expect(result.channels).toContain('#issue-7')
    } finally {
      prSpy.mockRestore()
      issueSpy.mockRestore()
    }
  })
})

describe('GitHubPlugin.desiredChannels', () => {
  it('includes #issue-N for each watched PR and issue', () => {
    const cfg: OrchestratorConfig = {
      repo: 'org/repo',
      watched_prs: [{ number: 25 }],
      watched_issues: [{ number: 14 }],
    }
    const chans = new GitHubPlugin('#proj').desiredChannels(cfg).sort()
    expect(chans).toEqual(['#issue-14', '#issue-25'])
  })

  it('unions entry-attached channels into the desired set', () => {
    const cfg: OrchestratorConfig = {
      repo: 'org/repo',
      watched_prs: [{ number: 25, channels: ['#extra'] }],
      watched_issues: [{ number: 14, channels: ['#extra', '#more'] }],
    }
    const chans = new GitHubPlugin('#proj').desiredChannels(cfg).sort()
    expect(chans).toEqual(['#extra', '#issue-14', '#issue-25', '#more'])
  })

  it('returns empty when no watches configured', () => {
    expect(new GitHubPlugin('#proj').desiredChannels({})).toEqual([])
  })
})
