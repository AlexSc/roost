import { describe, it, expect } from 'bun:test'
import {
  LinearAttachmentResolver,
  makeBatchedAttachmentQuery,
  BATCHED_ATTACHMENTS_QUERY,
  type AttachmentQuery,
  type RawIssueWithAttachments,
} from '../linear-link.js'

function stubQuery(response: RawIssueWithAttachments[]): { fn: AttachmentQuery; calls: string[][] } {
  const calls: string[][] = []
  const fn: AttachmentQuery = async (ids) => {
    calls.push([...ids])
    return response
  }
  return { fn, calls }
}

describe('LinearAttachmentResolver.resolve', () => {
  it('builds a map of "owner/repo#N" → [linear identifier] from github attachments', async () => {
    const { fn } = stubQuery([
      {
        identifier: 'C-758',
        attachments: {
          nodes: [
            { id: 'a1', sourceType: 'github', url: 'https://github.com/AvesAlight/roost/pull/495' },
          ],
        },
      },
    ])
    const map = await new LinearAttachmentResolver(fn).resolve(['C-758'])
    expect(map.get('AvesAlight/roost#495')).toEqual(['C-758'])
    expect(map.size).toBe(1)
  })

  it('ignores attachments with non-github sourceType', async () => {
    const { fn } = stubQuery([
      {
        identifier: 'C-1',
        attachments: {
          nodes: [
            { id: 'a1', sourceType: 'slack', url: 'https://github.com/x/y/pull/1' },
            { id: 'a2', sourceType: null, url: 'https://github.com/x/y/pull/2' },
          ],
        },
      },
    ])
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1'])
    expect(map.size).toBe(0)
  })

  it('ignores github attachments whose URL is not a well-formed pull/<N>', async () => {
    const { fn } = stubQuery([
      {
        identifier: 'C-1',
        attachments: {
          nodes: [
            { id: 'a1', sourceType: 'github', url: 'https://github.com/x/y/issues/3' },
            { id: 'a2', sourceType: 'github', url: 'https://github.com/x/y/pulls/4' },
            { id: 'a3', sourceType: 'github', url: null },
          ],
        },
      },
    ])
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1'])
    expect(map.size).toBe(0)
  })

  it('collects multiple Linear identifiers when the same PR is attached to several issues', async () => {
    const { fn } = stubQuery([
      {
        identifier: 'C-1',
        attachments: { nodes: [{ id: 'a1', sourceType: 'github', url: 'https://github.com/x/y/pull/42' }] },
      },
      {
        identifier: 'C-2',
        attachments: { nodes: [{ id: 'a2', sourceType: 'github', url: 'https://github.com/x/y/pull/42' }] },
      },
    ])
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1', 'C-2'])
    expect(map.get('x/y#42')).toEqual(['C-1', 'C-2'])
  })

  it('dedups when the same Linear issue has multiple github attachments pointing at the same PR', async () => {
    const { fn } = stubQuery([
      {
        identifier: 'C-1',
        attachments: {
          nodes: [
            { id: 'a1', sourceType: 'github', url: 'https://github.com/x/y/pull/42' },
            { id: 'a2', sourceType: 'github', url: 'https://github.com/x/y/pull/42' },
          ],
        },
      },
    ])
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1'])
    expect(map.get('x/y#42')).toEqual(['C-1'])
  })

  it('skips the query entirely when the identifier list is empty', async () => {
    const { fn, calls } = stubQuery([])
    const map = await new LinearAttachmentResolver(fn).resolve([])
    expect(map.size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('issues a single batched query regardless of N watched identifiers', async () => {
    const { fn, calls } = stubQuery([])
    await new LinearAttachmentResolver(fn).resolve(['C-1', 'C-2', 'C-3', 'C-4', 'C-5'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['C-1', 'C-2', 'C-3', 'C-4', 'C-5'])
  })

  it('handles an issue with null attachments cleanly', async () => {
    const { fn } = stubQuery([{ identifier: 'C-1', attachments: null }])
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1'])
    expect(map.size).toBe(0)
  })

  it('rejects construction without a query function', () => {
    expect(() => new LinearAttachmentResolver(undefined as unknown as AttachmentQuery)).toThrow(/query function required/)
  })
})

describe('makeBatchedAttachmentQuery', () => {
  it('wraps a LinearClient.graphql call with the batched-attachments query + ids variable', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> | undefined }> = []
    const client = {
      graphql: async (query: string, variables?: Record<string, unknown>) => {
        calls.push({ query, variables })
        return {
          issues: {
            nodes: [
              {
                identifier: 'C-1',
                attachments: { nodes: [{ id: 'a1', sourceType: 'github', url: 'https://github.com/x/y/pull/9' }] },
              },
            ],
          },
        }
      },
    }
    const query = makeBatchedAttachmentQuery(client)
    const nodes = await query(['C-1', 'C-2'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.query).toBe(BATCHED_ATTACHMENTS_QUERY)
    expect(calls[0]?.variables).toEqual({ ids: ['C-1', 'C-2'] })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.identifier).toBe('C-1')
  })

  it('returns [] without calling graphql when the identifier list is empty', async () => {
    let called = 0
    const client = { graphql: async () => { called++; return null } }
    const result = await makeBatchedAttachmentQuery(client)([])
    expect(result).toEqual([])
    expect(called).toBe(0)
  })

  it('returns [] when the graphql response is null or missing issues', async () => {
    const nullClient = { graphql: async () => null }
    expect(await makeBatchedAttachmentQuery(nullClient)(['C-1'])).toEqual([])
    const emptyClient = { graphql: async () => ({ issues: null }) }
    expect(await makeBatchedAttachmentQuery(emptyClient)(['C-1'])).toEqual([])
  })
})
