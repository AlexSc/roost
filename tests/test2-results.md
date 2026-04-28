# Test 2 results — spawn mechanism

Date: 2026-04-27

## TL;DR

The spawn primitive is **tmux + interactive `claude`**, not `claude --print`.
Print-mode children cannot subscribe to channels — the bun MCP ticks fine
out-of-band, but the events never enter the model's context. Interactive
children spawned via `tmux new-session -d` work correctly: clean 1h cache,
zero `messages_changed` / `tools_changed` misses, channel events delivered
turn-for-turn.

A second finding surfaced too: deferred-tool promotion (ToolSearch loading
an MCP tool from the deferred list) costs a `tools_changed` cache miss.
This is the same pathology that hurt the team mechanism — different layer,
same shape.

## Test 2 (print-mode child)

**Setup.** Bash-spawned child:

```
claude --print \
  --dangerously-skip-permissions \
  --mcp-config mcp-config.json \
  --dangerously-load-development-channels server:roost-stub \
  --allowedTools "mcp__roost-stub__echo Bash" \
  "<prompt that calls echo, runs an until-loop for 15s, reports tick count>"
```

`ROOST_TICK_MS=3000`. Prompt explicitly used a `until [ $(date +%s) -ge $end ]; do sleep 1; done` loop — the standalone-`sleep` guardrail blocks plain `sleep N`.

**Out-of-band ground truth.** The bun stub appended each tick to a
side-log file (`/tmp/roost-stub/ticks-<pid>.log`). On the run that produced
session `3dec41ba…`, the log had 9 ticks at proper 3s intervals.

**JSONL analysis.**

| Metric | Value |
|---|---|
| Lines | 16 |
| Assistant turns | 5 |
| Echo tool_use | 1 ✓ |
| Tick channel events received | **0 ✗** |
| `cache_read` total | 93,244 |
| `cache_creation_1h` | 47,902 |
| `cache_creation_5m` | 0 ✓ |
| Cache misses | **2 × `tools_changed`** (27,522 tokens each) ✗ |

The model, asked to count ticks it had observed, answered "0" — not because
it lied but because none arrived. The bun MCP was emitting them. They just
didn't make it into the session's context stream.

**`tools_changed` cause.** Turn 1 cached the initial tools list (deferred
tools listed by name only). The model called `ToolSearch` to promote
`mcp__roost-stub__echo` from deferred to loaded. Turn 2's tools list now
differs from the cached one → `tools_changed` cache miss for 27,522
tokens. Same for turn 3 (Bash schema also got promoted). The
`--allowedTools` flag controls permission, not deferral; deferral is
orthogonal.

## Test 2b (interactive child via tmux)

**Setup.** Detached tmux session running an interactive `claude`:

```
tmux new-session -d -s roost-test2b \
  "ROOST_TICK_MS=3000 ROOST_TICK_LOG_DIR=… \
   claude --mcp-config mcp-config.json \
          --dangerously-skip-permissions \
          --dangerously-load-development-channels server:roost-stub"
```

Then `tmux send-keys` to dismiss the dev-channels confirmation (default
option is "accept"; one Enter). Then `tmux send-keys` for the prompt
("acknowledge each incoming tick with `ack tick N`"). 25-second observation
window.

**JSONL analysis.**

| Metric | Value |
|---|---|
| Lines | 183 |
| Assistant turns | 33 |
| Tick channel events received | **33 ✓** (1, 2, 3, …, 33) |
| `cache_read` total | 915,959 |
| `cache_creation_1h` | 15,626 |
| `cache_creation_5m` | 0 ✓ |
| Cache misses | 1 × `unavailable` (benign upstream API state) ✓ |

Channel events arrive as user-shape entries, the model produces an `ack
tick N` response per tick, the cache stays clean. Same shape as the Test 1
result — the difference between "interactive hand-launched" and
"interactive tmux-spawned" is just the spawn mechanic.

## Implications for the brief

1. **Spawn primitive: tmux session.** The orchestrator runs a Bash-equivalent
   `tmux new-session -d -s <worker-id> 'claude … --dangerously-load-development-channels server:roost-stub'`,
   then sends Enter once for the dev-channels prompt, then sends the worker's
   initial prompt. Workers identified by tmux session name. Lifecycle:
   `tmux kill-session -t <worker-id>`.

2. **`--print` is not viable for channel-subscribing workers.** Reserve it
   for tasks that explicitly do not need channel events (one-shot
   computations, file transformations). Channel-subscribing roles must be
   interactive.

3. **`tools_changed` from deferred-tool promotion is a real cost.** It
   shows up at the start of any worker that uses any deferred tool, and
   it's the same pathology this whole exercise was meant to escape — just
   moved one layer down. Mitigation candidates:
   - Pre-register the tools the worker needs as non-deferred (mechanism
     unclear; needs investigation).
   - Have workers do all `ToolSearch` loading in one batch before doing
     anything cache-sensitive, so the miss is paid once.
   - Accept the one-time miss and amortize it across long-running workers.
   For ephemeral one-shot workers this miss is the *whole* cache cost,
   which makes them a poor fit for cache-sensitive roles regardless of
   channels.

4. **Dev-channels confirmation timing is delicate.** The prompt blocks
   with a 1-of-2 choice ("accept" default) and exits if not answered.
   Automation needs a small wait + Enter sequence; faster than ~3s and the
   prompt isn't drawn yet, longer than ~10s and the prompt may have
   timed out. A real implementation would expect-style poll the pane
   contents for the prompt string before sending Enter.

## Test 3 — multi-MCP per session

**Setup.** Same tmux spawn primitive as Test 2b, but with an additional
tools-only MCP (`roost-tools`, exposes `add(a, b)`, no channel capability)
attached alongside `roost-stub`. Both servers started by `bun`. Worker
prompt asks the model to call `add(2, 3)`, observe at least 3 channel
ticks, call `add(10, 20)`, summarize, and `touch /tmp/roost-test3.done`.

**Result: PASS.**

| Metric | Value |
|---|---|
| Bun MCPs running | 2 (`roost-stub` PID 77202, `roost-tools` separate) |
| Tick channel events emitted (side-log) | 7 |
| Tick channel events received (JSONL, both surfaces) | **7** ✓ (1, 2, 3, 4, 5, 6, 7) |
| `roost-tools.add` calls | 2 (returned 5 and 30) ✓ |
| `cache_read` total | 333,627 |
| `cache_creation_1h` | 101,419 |
| `cache_creation_5m` | 0 ✓ |
| Cache misses | 1 × `tools_changed` (known one-time deferred-tool promotion) |

**Architectural finding — backpressure.** Channel events arrive in two
JSONL record shapes:

1. `type=user` with string content `<channel ...>` — surfaced directly
   when the model is idle (ticks 1, 2, 3, 7).
2. `type=attachment, attachment.type=queued_command,
   attachment.origin.kind=channel` — events that arrived **while the model
   was mid-turn**. They queue rather than drop, and drain into the next
   user-shape record when the current turn ends (ticks 4, 5, 6).

The team mechanism (SendMessage during a worker's turn) is what produces
much of the cache pathology this exercise is meant to escape. Channels
don't have that problem — backpressure is handled at the harness layer,
between turns, not by interrupting the model. **This is a real
architectural property to lean on**, not just an incidental observation.

The `--mcp-config` flag accepts multiple `mcpServers` entries cleanly. The
`--dangerously-load-development-channels server:roost-stub` flag only
needs to name the MCPs that emit channels; the tools-only MCP doesn't
need to be listed there. Both MCPs' tools land in the deferred-tools
surface and get promoted via `ToolSearch` on first use.

## Tests still pending

- **Test 4 — long-haul.** Multi-hour session, periodic ticks, confirm
  cache stays clean and ticks keep landing across multiple turns of
  inactivity. Depends on having an idle interactive child that's safe
  to leave running.
- **Test 5 — failure modes.** MCP crash mid-session; IRC disconnect (when
  the IRC layer exists); recover or fail loudly. Depends on the IRC
  layer being built.

Tests 4 and 5 can both run on the Test 2b/3 spawn primitive — no
architectural changes to the test harness.

## Harness state and small TODOs

- The Test 3 child's session JSONL ended up in the `operations/` project
  dir because the inherited cwd from the parent tmux spawn was the parent
  shell's cwd, not the roost dir. Fix: `tmux new-session -d -c <roost_dir>
  …` (the `-c` flag pins the session's working directory). Cosmetic — the
  JSONL is correct, just filed under the wrong project.
- The analyzer's pass/fail rules are baked in (always expects `echo` to
  be called; always fails on `tools_changed`). For per-test runs they
  produce noisy "FAIL" output that doesn't reflect the test's actual
  expectations. Should be parameterized — the analyzer is a measurement
  tool, the harness owns the assertions.
- The `unavailable` cache miss in Test 2b and the `tools_changed` miss
  in Tests 2 and 3 are different things and should be reported with
  different signal weight. `unavailable` is upstream Anthropic API state
  (benign); `tools_changed` is structural (deferred-tool promotion cost).
