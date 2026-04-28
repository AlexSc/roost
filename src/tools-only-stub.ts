#!/usr/bin/env bun
/**
 * Second smoke-test MCP — tools-only (NO channel capability).
 *
 * Test 3 uses this alongside `roost-stub` (which has the channel
 * capability) to confirm the additive capability surface — both MCPs
 * live in the same session without stepping on each other's tools or
 * each other's channel registration.
 *
 * Exposes a single tool, `add`, that returns the sum of two numbers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const SOURCE_NAME = 'roost-tools'

const mcp = new Server(
  { name: SOURCE_NAME, version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      // intentionally NO claude/channel — this is the tools-only control
    },
    instructions: `Tools-only stub for roost Test 3. Provides 'add'. No channel surface.`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'add',
      description: 'Return the sum of two numbers a + b.',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First addend.' },
          b: { type: 'number', description: 'Second addend.' },
        },
        required: ['a', 'b'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'add') {
    return {
      content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
      isError: true,
    }
  }
  const a = Number(req.params.arguments?.a ?? 0)
  const b = Number(req.params.arguments?.b ?? 0)
  return { content: [{ type: 'text', text: `${a + b}` }] }
})

await mcp.connect(new StdioServerTransport())
process.stderr.write(`roost-tools: started ${new Date().toISOString()}\n`)
