// Pricing for Anthropic models keyed by the exact `message.model` value
// that appears in Claude Code session JSONLs. Used by bin/roost-token-usage
// to estimate cost from token counts.
//
// All rates are USD per 1M tokens. Mirrors Anthropic's posted pricing as of
// the 2026-05 snapshot — bump when Anthropic publishes new rates or when
// new model IDs start appearing in transcripts. `/usage` inside Claude Code
// is the canonical reference; this table tries to match its numbers.
//
// Unknown model IDs cause roost-token-usage to print `$?` for that nick
// and stderr-warn the unknown ID, rather than silently defaulting to a
// rate that could mislead the reader either direction.

export interface ModelPricing {
  input: number
  output: number
  cache_creation: number
  cache_read: number
}

export const PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-opus-4-7':           { input: 15, output: 75, cache_creation: 18.75, cache_read: 1.50 },
  'claude-opus-4-5':           { input: 15, output: 75, cache_creation: 18.75, cache_read: 1.50 },
  'claude-sonnet-4-6':         { input: 3,  output: 15, cache_creation: 3.75,  cache_read: 0.30 },
  'claude-sonnet-4-5':         { input: 3,  output: 15, cache_creation: 3.75,  cache_read: 0.30 },
  'claude-haiku-4-5':          { input: 1,  output: 5,  cache_creation: 1.25,  cache_read: 0.10 },
  'claude-haiku-4-5-20251001': { input: 1,  output: 5,  cache_creation: 1.25,  cache_read: 0.10 },
}

// IDs that appear in transcripts but don't represent real API spend —
// internal placeholders we count as zero cost without warning.
export const SKIPPED_MODELS: ReadonlySet<string> = new Set(['<synthetic>'])

export interface UsageCounts {
  input: number
  output: number
  cache_creation: number
  cache_read: number
}

// Returns the USD cost for the given counts at the given model's rates, or
// `null` if the model is unknown (caller surfaces `$?` and warns).
export function costFor(model: string, u: UsageCounts): number | null {
  if (SKIPPED_MODELS.has(model)) return 0
  const p = PRICING[model]
  if (!p) return null
  return (
    p.input * u.input
    + p.output * u.output
    + p.cache_creation * u.cache_creation
    + p.cache_read * u.cache_read
  ) / 1_000_000
}
