#!/bin/bash
# Test 3 — Multi-MCP per session
#
# Confirms an interactive child claude session can run with TWO MCPs
# attached: roost-stub (channel-emitting) and roost-tools (tools-only).
#
# Sub-assertions:
#   (a) tmux child spawns and accepts the dev-channels prompt
#   (b) both MCPs load (echo + add tools both callable)
#   (c) channel ticks from roost-stub still arrive (>= 3 within window)
#   (d) calling roost-tools.add does not disturb channel delivery
#   (e) cache writes land in 1h bucket only
#   (f) zero messages_changed / tools_changed misses (after deferred-tool
#       promotion, which we accept as a one-time cost)
#
# The (f) check is informational: deferred-tool promotion will trigger
# tools_changed misses on first call to either echo or add. We capture
# the count and pattern but do not fail on it.

set -uo pipefail

ROOST_DIR="/Users/alex/Dev/GoCarrot/roost"
PROJECTS_DIR="/Users/alex/.claude/projects/-Users-alex-Dev-GoCarrot-roost"
LOG_DIR="${ROOST_DIR}/tests/logs"
mkdir -p "${LOG_DIR}"
TICK_LOG_DIR="${LOG_DIR}/test3-ticks-$(date +%s)"
mkdir -p "${TICK_LOG_DIR}"
SESSION_NAME="roost-test3"
DONE_MARKER="/tmp/roost-test3.done"
rm -f "${DONE_MARKER}"

# Ensure no stale tmux session
tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true

PRE_JSONLS="$(ls "${PROJECTS_DIR}"/*.jsonl 2>/dev/null | sort)"

export ROOST_TICK_MS=4000
export ROOST_TICK_LOG_DIR="${TICK_LOG_DIR}"

echo "[test3] launching tmux interactive child..."
tmux new-session -d -s "${SESSION_NAME}" -x 200 -y 50 -c "${ROOST_DIR}" \
  "ROOST_TICK_MS=${ROOST_TICK_MS} ROOST_TICK_LOG_DIR=${ROOST_TICK_LOG_DIR} \
   claude --mcp-config ${ROOST_DIR}/tests/test3-mcp-config.json \
          --dangerously-skip-permissions \
          --dangerously-load-development-channels server:roost-stub"

# Poll for the dev-channels prompt before sending Enter (lessons from Test 2b
# timing fragility).
echo "[test3] waiting for dev-channels prompt..."
for i in $(seq 1 30); do
  if tmux capture-pane -t "${SESSION_NAME}" -p 2>/dev/null \
       | grep -q "I am using this for local development"; then
    echo "[test3] prompt detected after ${i}s"
    break
  fi
  sleep 1
done

tmux send-keys -t "${SESSION_NAME}" Enter
sleep 5

# Send the worker prompt.
PROMPT='You are a roost Test 3 worker with two MCPs attached: roost-stub (channels + echo) and roost-tools (add).

Do exactly this, in order:

1. Call mcp__roost-tools__add with a=2 and b=3. Report the result inline.
2. After you see at least 3 channel ticks arrive (formatted "<- roost-stub: tick N at <ts>"), call mcp__roost-tools__add with a=10 and b=20. Report the result inline.
3. Then write a single sentence summarizing: how many ticks total you saw, and both add results.
4. Finally, run this Bash command exactly: touch /tmp/roost-test3.done

Acknowledge each tick you see in between with a short "ack tick N" line. After the touch, do not produce any further output.'

echo "[test3] sending worker prompt..."
# tmux send-keys with a multi-line string: build it via a temp file to avoid
# shell escaping headaches with the quotes and newlines.
PROMPT_FILE="$(mktemp)"
printf '%s' "${PROMPT}" > "${PROMPT_FILE}"
tmux load-buffer -b roost-test3-prompt "${PROMPT_FILE}"
tmux paste-buffer -t "${SESSION_NAME}" -b roost-test3-prompt -p
tmux send-keys -t "${SESSION_NAME}" Enter
rm -f "${PROMPT_FILE}"

# Poll for the done marker file, max 120s. Using a file (not a stdout
# sentinel) avoids matching the prompt-echo in the tmux input box.
echo "[test3] waiting for ${DONE_MARKER}..."
DONE=0
for i in $(seq 1 120); do
  if [ -f "${DONE_MARKER}" ]; then
    echo "[test3] done marker observed after ${i}s"
    DONE=1
    break
  fi
  sleep 1
done

echo "[test3] final pane (last 60 lines):"
tmux capture-pane -t "${SESSION_NAME}" -p -S -200 | tail -60 | sed 's/^/  | /'

# Teardown.
tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
sleep 1

# Identify child JSONL.
POST_JSONLS="$(ls "${PROJECTS_DIR}"/*.jsonl 2>/dev/null | sort)"
CHILD_JSONL="$(comm -13 <(echo "${PRE_JSONLS}") <(echo "${POST_JSONLS}") | head -1)"

if [[ -z "${CHILD_JSONL}" ]]; then
  echo "[test3] FAIL: no new child session JSONL detected"
  exit 1
fi

echo "[test3] child JSONL: ${CHILD_JSONL}"
echo "[test3] tick side-logs:"
for f in "${TICK_LOG_DIR}"/ticks-*.log; do
  [ -f "$f" ] || continue
  echo "  | $(basename "$f"): $(wc -l < "$f") ticks"
done

if [[ ${DONE} -ne 1 ]]; then
  echo "[test3] WARN: done marker never appeared — running analyzer anyway"
fi

python3 "${ROOST_DIR}/tests/analyze-jsonl.py" "${CHILD_JSONL}"
