#!/usr/bin/env bun
/**
 * roost stub channel MCP — Test 1
 *
 * Minimal MCP that proves the load-bearing assumptions for the full
 * IRC-backed channel architecture:
 *   - declares claude/channel + tools capabilities together
 *   - exposes a trivial tool (`echo`)
 *   - emits a notifications/claude/channel event every TICK_INTERVAL_MS
 *
 * Run with:
 *   claude --mcp-config mcp-config.json
 *
 * Inspect resulting session JSONL in ~/.claude/projects/... for:
 *   (a) both capabilities accepted at init
 *   (b) <channel source="roost-stub">tick N</channel> events arrive
 *   (c) zero messages_changed / tools_changed cache misses
 *   (d) cache_creation.ephemeral_1h_input_tokens dominates
 *   (e) this MCP subprocess still alive at end of run
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync, mkdirSync } from 'node:fs'

const TICK_INTERVAL_MS = Number(process.env.ROOST_TICK_MS ?? 60_000)
const SOURCE_NAME = 'roost-stub'
// Out-of-band tick log for tests — confirms the bun MCP process actually
// ran and emitted ticks, independent of whether the host session surfaced
// them to the model.
const TICK_LOG_DIR = process.env.ROOST_TICK_LOG_DIR ?? '/tmp/roost-stub'
const TICK_LOG_PATH = `${TICK_LOG_DIR}/ticks-${process.pid}.log`
try {
  mkdirSync(TICK_LOG_DIR, { recursive: true })
} catch {
  // best-effort; the stub still works without the side log
}

const mcp = new Server(
  { name: SOURCE_NAME, version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: `roost stub MCP. Emits a tick channel event every ${TICK_INTERVAL_MS}ms. The 'echo' tool returns whatever text you pass it. Both surfaces exist to exercise the channel + tools capability paths in a single MCP.`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Return the text you pass in. Trivial tool to exercise the tools capability.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to echo back.' },
        },
        required: ['text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'echo') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  }
  const text = (req.params.arguments?.text as string | undefined) ?? ''
  return { content: [{ type: 'text', text }] }
})

await mcp.connect(new StdioServerTransport())

let tick = 0
const startedAt = new Date().toISOString()
process.stderr.write(`roost-stub: started ${startedAt}, ticking every ${TICK_INTERVAL_MS}ms\n`)

setInterval(() => {
  tick += 1
  const ts = new Date().toISOString()
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: `tick ${tick} at ${ts}`,
      meta: {
        tick: String(tick),
        ts,
        source: SOURCE_NAME,
      },
    },
  })
  process.stderr.write(`roost-stub: emitted tick ${tick} at ${ts}\n`)
  try {
    appendFileSync(TICK_LOG_PATH, `${ts}\ttick=${tick}\tpid=${process.pid}\n`)
  } catch {
    // stub keeps going even if logging fails
  }
}, TICK_INTERVAL_MS)
