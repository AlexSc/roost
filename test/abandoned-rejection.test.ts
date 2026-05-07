import { describe, it, expect } from 'bun:test'
import { suppressLateRejection } from './helpers/tool.js'

// Regression for issue #170. Bun 1.2.20 hangs the test runner indefinitely
// when an unhandled promise rejection arrives from a test the runner has
// already abandoned (e.g. after a test timeout). Our timeout-based test
// helpers (waitForNotification, waitForMessage, waitForPart, joinChannel,
// changeNick) wrap their internal Promise in `suppressLateRejection` so the
// stale reject() never becomes unhandled. These tests pin that contract.
//
// If you remove the .catch() inside `suppressLateRejection`, the second test
// here will not fail-and-hang; it will fail-and-hang the entire bun process.
describe('suppressLateRejection — issue #170 regression', () => {
  it('a still-pending await receives the rejection normally', async () => {
    const p = suppressLateRejection(
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('expected reject')), 50)
      }),
    )

    let caught: Error | null = null
    try { await p } catch (e) { caught = e as Error }
    expect(caught?.message).toBe('expected reject')
  })

  it('an abandoned helper rejection does not hang the runner', async () => {
    // Simulate the scenario from #170: caller creates a helper-style promise
    // with a 50ms reject timer, never awaits it, and the test continues.
    // Without suppressLateRejection, this rejection becomes unhandled at 50ms
    // and (combined with any further work) wedges the bun runner.
    suppressLateRejection(
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('abandoned reject')), 50)
      }),
    )

    // Yield long enough for the rejection timer to fire.
    await new Promise(r => setTimeout(r, 100))

    // If we reach this assertion, the runner did not hang.
    expect(true).toBe(true)
  })
})
