# roost — Agent IRC Channel Architecture

Project plan for replacing the Claude Code agent-team mechanism with
independent `claude` sessions communicating over IRC, mediated by a
custom channel-emitting MCP.

> Origin: ProductOps thinking-partner conversation 2026-04-27 with the
> CEO. Brief drafted in conversation per `Technical_Project_Management.md`
> Phase 1, focused on load-bearing assumptions per CEO direction. Tests
> 1–3 (partial) executed the same day; this document is the single
> living source of truth, updated as evidence comes in.

## 1. Customer and ask

The operations system's orchestrated execution loop is the customer.
Today, workers are spawned via the `Agent` tool's team mechanism and
communicate via SendMessage. Three concrete pains have surfaced in
production:

- **Worker cache pathology.** Background agents are pinned to 5m TTL
  regardless of config. On wake, `messages_changed` and `tools_changed`
  fire reliably — empirically, worker-698's 2026-04-27 session shows 343k
  cache_creation / 18k cache_read on one wake (95% of context rebuilt).
- **Long-running subprocesses don't survive worker session lifecycle.**
  k6 load tests (15–19 min) and similar work currently run from the
  orchestrator's background Bash. The orchestrator is supposed to route,
  not own subprocesses.
- **Team mechanism mutates state.** Across 1153 orchestrator turns on
  2026-04-27, the only meaningful cache-loss class was `system_changed`,
  with the trigger profile concentrated on `<teammate-message>` arrivals
  (305k tokens lost in 3 events) vs. channel events (53k in 1 of 156).

The ask: a messaging architecture that escapes these bugs and gives every
agent the same 1h cache TTL the top-level orchestrator gets, with multi-party
visibility for human observability.

## 2. Today

Channels are an MCP-native primitive: an MCP declares
`capabilities.experimental['claude/channel']` and emits events via
`notifications/claude/channel`. The fakechat plugin is one HTTP-flavored
implementation — the HTTP layer is fakechat's quirk, not the primitive.

The orchestrator's channel usage is empirically clean (1153 turns / 156
channel events): cache reads 292M, creation 7.1M (all 1h TTL, zero 5m),
misses 2.5M (~0.85%). No `messages_changed` or `tools_changed` fired. The
clean cache behavior is the channel mechanism's, not fakechat-specific.

Project-local dispatchers (`.orchestrator/bin/orchestrator_poll`) and the
`tclaude` zsh port-allocation function are running infrastructure we
keep. The dispatcher is a pure Python script (not a Claude session),
interacting with the orchestrator via fakechat HTTP today.

## 3. Shipped (target end-state)

- A custom MCP that wraps an IRC client. Tools: `channel_join`,
  `channel_leave`, `channel_message`, `direct_message`, `channel_history`,
  `channel_who`. Incoming IRC traffic emits `claude/channel` events into
  the host session.
- ngircd local on each operator's machine.
- A revised execution loop where workers are independent `claude`
  processes (not background agents), each loaded with the IRC-MCP at
  spawn time. Team mechanism no longer used in the loop.
- Migration of `Project_Execution.md`, `.orchestrator/worker_conventions.md`,
  and the dispatcher (becomes an IRC poster, not an HTTP poster).
- CEO observability via irssi/weechat against the same server.

### Status as of Test 4 (2026-04-27)

- ngircd installed via Homebrew, configured at
  `roost/etc/ngircd.conf` (localhost:6667, no auth, single operator).
  Started with `ngircd -f <config>`; PID file at `roost/var/ngircd.pid`.
- IRC-MCP at `roost/src/irc-server.ts` — 6 tools, channel-event
  emission, in-memory per-channel ring buffer for `channel_history`.
  Built on `irc-framework` (npm). Configured per-instance via env vars
  (`ROOST_IRC_NICK`, `ROOST_IRC_CHANNELS`, etc.).
- mcp-config at `roost/mcp-config-irc.json`.
- Standalone IRC listener at `roost/tests/irc-listener.ts` for
  ground-truth observation in tests.

Still not done at this milestone: runbook migrations, dispatcher
cutover from HTTP to IRC, worker spawn helper, irssi setup
documentation, and the deeper hardening passes (reconnection
testing, MCP crash recovery, ngircd lifecycle automation).

## 4. Jobs to be done

When I'm coordinating multiple Claude agents on long-running work, I want
them to communicate without paying cache penalties on each wake — so
concurrency scales without exponential token cost and the orchestrator
can be a real router rather than a workaround for missing tiers.

## 5. In scope / Out of scope

**In:** IRC-MCP server + tool surface; ngircd setup; migration of the
orchestrated-loop runbook + project conventions + dispatcher;
replacement of team mechanism in the loop; worker spawn/shutdown
automation (no `Agent` tool affordance); CEO observability path.

**Out:** Replacing `Agent` tool for non-orchestration uses (CoS /
FinanceOps Task agents stay) — different problem, different solution.
Multi-host scaling — single-machine for v1. Building a custom IRC
server (use ngircd). Designing for non-orchestration multi-agent
scenarios (e.g., the Jake Zimmerman analysis pattern).

## 6. Load-bearing assumptions

The plan stands or falls on these. Each one has an empirical test
spec or a resolution; status reflects the latest evidence.

| # | Assumption | Status | Evidence |
|---|---|---|---|
| 1 | An MCP can declare `claude/channel` capability AND tool capability simultaneously, and emit channel events without external HTTP plumbing. | ✓ confirmed | Test 1 — `roost-stub` declares both, both work. Channel events arrive as `<channel source="roost-stub" tick="N" …>` user-shape entries. |
| 2 | Independent `claude` processes get 1h cache TTL, not the background-agent 5m. | ✓ confirmed | Test 1 + Test 2b + Test 3-as-prelim — all writes `ephemeral_1h_input_tokens`, zero `ephemeral_5m`. |
| 3 | Channel-event arrivals don't trigger `messages_changed` or `tools_changed` misses. | ✓ confirmed (with caveat) | All test sessions show zero `messages_changed`. Zero `tools_changed` *from channel arrivals*. **Caveat:** `tools_changed` does fire from deferred-tool promotion (one-time, per-worker) — see Finding A below. |
| 4 | Claude Code sessions continue to receive channel events while between turns. | ✓ confirmed | Test 1 — agent received 15 ticks across 17 assistant turns of mostly-idle session. Test 2b — 33 ticks → 33 reactive turns from a passively-launched session. |
| 5 | The 4/27 fakechat-down failure was a fakechat-layer bug, not a Claude Code notification-queue bug. | downgraded — not load-bearing | CEO clarification: it WAS a Claude Code bug — Claude Code binds the fakechat port at session start and doesn't reliably tear it down on close. The IRC-MCP design sidesteps this entirely (stdio MCP, outbound IRC client, no listening port). Failure mode at the MCP layer is graceful: stale subprocess holds stale IRC connection, ngircd ping-timeout boots it ~30–60s later, new session reconnects with same nick. |
| 6 | A clean spawn/shutdown path for worker sessions exists without the `Agent` tool, with UX comparable at 4–6 concurrency. | ✓ resolved as tmux | Test 2 (print-mode child) failed — print mode is channel-blind. Test 2b proved `tmux new-session -d -c <dir> "claude … --dangerously-load-development-channels server:<name>"` works. Spawn primitive is tmux interactive sessions, not `claude --print`. Production spawn helper should expect-style poll for the dev-channels prompt rather than `sleep` (timing-fragile otherwise). |
| 7 | The IRC-MCP subprocess survives the host session's idle period without being killed by Claude Code. | ✓ confirmed (passive) | Test 1's tmux pane has been alive ~4+ hours at time of writing, bun MCP PID 61975 still ticking, ticks still arriving in the host session. |
| 8 | Multiple Claude Code sessions can run concurrently on one machine, each with its own MCP/IRC connection, no resource conflicts. | ✓ confirmed (concurrent half) | Test 3 (concurrent) — 5 sessions spawned in parallel via tmux, each got its own `roost-stub` bun MCP, each received its own 7 ticks (35/35 fleet-wide), all on 1h cache, zero cross-session interference, clean teardown. The "shared channel / mutual delivery" half remains blocked on Test 4 (the IRC layer). |
| 9 | Multi-party channels with human observability are a real operational requirement, not nice-to-have. | design call (yes) | The CEO's stated interest in IRC + the existing continuous-oversight model in `Project_Execution.md` argue yes. If falsified, the simpler shape is "claude/channel-only MCP, no IRC at all." |

## 7. Findings beyond the original assumptions

These showed up during Tests 2 and 3 and are architecturally relevant
enough to bake into the plan (and into worker prompt conventions).

### Finding A — Deferred-tool promotion costs a `tools_changed` cache miss

When a session calls `ToolSearch` to promote an MCP tool (e.g.,
`mcp__roost-stub__echo`) from the deferred-tools list to the active list,
the next assistant turn's tools list differs from the cached one, which
fires a `tools_changed` cache miss for the size of the rebuilt prefix
(~27k tokens in Test 2). This is the same pathology shape as the
team-mechanism's `tools_changed` miss; it just lives at a different
layer (deferred-tool promotion, not SendMessage).

**Implications:**

- For long-running interactive workers, this is a one-time cost paid at
  the moment the worker first uses any MCP tool. Amortizes well over the
  worker's lifetime.
- For ephemeral one-shot workers, this miss is the *entire* cache cost.
  Combined with Test 2's finding that `--print` mode is channel-blind,
  ephemeral workers are out of the architecture regardless.
- Mitigation candidate: investigate whether MCP tools can be marked as
  non-deferred at registration time, or whether worker prompts should
  do all `ToolSearch` calls in a single batch turn before doing
  cache-sensitive work, so the miss is paid once.

### Finding B — Channel events handle backpressure correctly

Channel events arrive in the JSONL in two distinct record shapes:

1. `type=user, content=string` — events that arrive while the model is
   idle. Surfaced directly on the next turn.
2. `type=attachment, attachment.type=queued_command,
   attachment.origin.kind=channel` — events that arrive **while the
   model is mid-turn**. They queue rather than drop, and surface as
   user-shape entries when the current turn ends.

**Test 3-as-I-did empirical confirmation:** 7 ticks emitted by the bun
MCP, all 7 received — 4 in shape (1) (model was idle), 3 in shape (2)
(model was mid-`add` tool calls). No drops, no reordering, no mid-turn
cache invalidation.

This is the architectural property the team mechanism lacks. SendMessage
during a worker's turn is part of why teammate-cache behavior gets
messy — the message lands in the orchestrator's context mid-worker-turn,
breaking the cache shape. **Channels handle that backpressure at the
harness layer, between turns. Lean on this in the brief and in worker
prompt conventions.**

### Finding C — Channel arrivals bootstrap turns autonomously

A passively launched interactive session (no user prompt sent) will still
process incoming channel events — the model produces a turn per arrival
(observed in Test 2b: ack'd 25 ticks before the user prompt was even
submitted). This is the right shape for listener-style workers — a
worker spends most of its time idle, and incoming channel messages drive
its activity.

**Implication for worker prompts:** state the *standing instruction* on
incoming messages ("when you receive a `<channel source='irc'>` event
addressed to you, do X"), don't expect to drive the worker turn-by-turn.

### Finding D — Pure-listener workers don't pay `tools_changed`

In Test 3 (concurrent), none of the 5 sessions paid the deferred-tool-promotion
`tools_changed` cost — because none of them ever called an MCP tool.
The default behavior on incoming channel events is to acknowledge in
plain text, which doesn't require `ToolSearch`. The one-time miss
identified in Finding A only fires when a worker actually loads its
first MCP tool.

**Implication:** worker roles split cleanly along this axis:

- **Pure listeners** (e.g., a logging-only watcher, an observability
  pane): never pay the deferred-tool cost.
- **Listener + worker** (the common case — receives messages, acts via
  IRC tools): pays the cost once at first tool load. Amortizes over
  the worker's lifetime.

For the IRC-MCP itself, the listener+worker shape is the norm —
`channel_message`, `direct_message`, etc. are MCP tools and will all
be deferred initially. A worker's first IRC outbound action will pay
the miss. This is acceptable.

## 8. Test plan and status

Original ordered plan (1 → 2 → 3 → 4) with Test 5 rolled into Test 1's
long-run side-effect.

| Test | Goal | Status | Result |
|---|---|---|---|
| 1 | Stub channel MCP — capabilities + emission + cache | ✓ done | PASS — all 5 sub-assertions; assumptions #1, #2, #3, #4, #7 confirmed |
| 2 | Spawn mechanism (#6) | ✓ done | Print-mode FAIL → tmux interactive PASS (Test 2b). #6 resolved as tmux. |
| 3 (original) | 5 concurrent sessions, shared channel, no nick collisions / resource conflicts | ✓ done (concurrent half) | PASS — 5/5 sessions, 35/35 ticks, 5/5 1h cache, no resource conflicts. Shared-channel half blocked on Test 4. |
| 3 (multi-MCP) | Multi-MCP per session — channels + tools-only stub side-by-side | ✓ done | PASS — both MCPs co-exist; surfaced Finding B (backpressure) |
| 4 | Real IRC-MCP, ngircd, two sessions, ping/pong | ✓ done | PASS — `t4orch` and `t4worker` ran 5 ping/pong rounds via #test on local ngircd. Each session 10–11 assistant turns, both on 1h cache only, both with exactly 1 `tools_changed` miss (Finding A's one-time deferred-tool promotion cost). Zero `messages_changed`, zero `system_changed`. Read/create cache ratio ~7:1 to ~10:1 sustained — inverted from worker-698's 18:343 pathology. |
| 5 | (rolled into Test 1) — MCP idle survival | ✓ passive | Test 1's bun MCP alive 4+ hours, still ticking |

## 9. Open questions (beyond the load-bearing assumptions)

- IRC server choice: ngircd default. solanum if we want SASL/services;
  bouncer integration question for replay-on-reconnect.
- Mention/highlight semantics: separate channel source
  (`irc-mention` vs `irc-ambient`), event meta field, or convention?
  Affects how agents behave on noisy channels — wake on every CI tick
  on `#dispatch-feed`, or only when addressed?
- One MCP per session (configured at launch with nick + connection),
  or shared MCP service all sessions connect to? Per-session is simpler;
  shared is one process but couples lifecycles. Per-session seems
  default given the 1:1 nature of session ↔ identity.
- Migration cutover shape: parallel run (old loop on one project, new
  on another) until confidence, or hard cutover at next project?
- Dev-channels prompt automation in spawn helper: expect-style poll for
  the prompt string before sending Enter, vs. `sleep N`. The former is
  more robust; needs a small helper script that sits between the
  orchestrator and tmux.
- Where does the spawn helper live? Inside roost (`bin/spawn-worker`)
  or in the operations repo's `.orchestrator/`? roost feels right because
  the dev-channels handshake is roost-specific.

## 10. References

- Anthropic channel docs: `code.claude.com/docs/en/channels.md`,
  `code.claude.com/docs/en/channels-reference.md`
- fakechat reference: `~/.claude/plugins/cache/claude-plugins-official/fakechat/0.0.1/server.ts`
- Worker cache pathology evidence: `~/.claude/projects/-Users-alex-Dev-GoCarrot-operations/f6fa5485-c8e0-4cdf-9dcb-dd6021acb5f8/subagents/agent-addb27e0be67b80b9.jsonl`
- Orchestrator clean-cache evidence: `~/.claude/projects/-Users-alex-Dev-GoCarrot-operations/ab176532-d7c7-4aaa-a9b1-dedf03fa9b60.jsonl`
- Current execution loop: `operations/ProductOps/Runbooks/Project_Execution.md`
- Multi-orchestrator unblock + fakechat parameterization:
  `operations/ProductOps/Journal/2026-04-26.md` (third entry)
- Tests, results, harnesses: `roost/tests/` (`test2-results.md` is the
  living results doc; will fold into this PLAN as tests close out)
- ProductOps journal — original conversation + Test 1/2/3 execution:
  `operations/ProductOps/Journal/2026-04-27.md` (evening entry)
