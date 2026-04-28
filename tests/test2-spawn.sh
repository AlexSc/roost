#!/bin/bash
# Test 2 — Spawn mechanism
#
# Confirms a parent claude session can shell-exec an ephemeral child claude
# worker that loads roost-stub via the dev-channels flag, calls a tool,
# observes channel events, and exits cleanly.
#
# Sub-assertions:
#   (a) child process exits 0
#   (b) child session JSONL is created in -Users-alex-Dev-GoCarrot-roost
#   (c) child loaded roost-stub MCP (echo tool callable)
#   (d) child received >= 2 tick channel events during its run
#   (e) child cache writes land in 1h bucket (ephemeral_1h_input_tokens)
#   (f) child has zero messages_changed / tools_changed misses

set -uo pipefail

ROOST_DIR="/Users/alex/Dev/GoCarrot/roost"
PROJECTS_DIR="/Users/alex/.claude/projects/-Users-alex-Dev-GoCarrot-roost"
LOG_DIR="${ROOST_DIR}/tests/logs"
mkdir -p "${LOG_DIR}"

# Snapshot pre-existing JSONLs so we can identify the child's after the run.
PRE_JSONLS="$(ls "${PROJECTS_DIR}"/*.jsonl 2>/dev/null | sort)"

# Tick fast so the child catches multiple ticks during its ~15s wait window.
export ROOST_TICK_MS=3000
# Per-run side-log dir — gives us out-of-band ground truth on whether the
# bun MCP process actually ticked.
TICK_LOG_DIR="${LOG_DIR}/ticks-$(date +%s)"
mkdir -p "${TICK_LOG_DIR}"
export ROOST_TICK_LOG_DIR="${TICK_LOG_DIR}"

CHILD_PROMPT='You are running as an ephemeral test worker for the roost Test 2 spawn check. Do not load extra tools; the tools you need are already available.

Do exactly this, in order:

1. Call the mcp__roost-stub__echo tool with text="hello from child".
2. Run this single Bash command (an until-loop — NOT a standalone sleep) to keep your session alive for ~15 seconds while channel events arrive:
     end=$(( $(date +%s) + 15 )); until [ $(date +%s) -ge $end ]; do sleep 1; done; echo done
3. Write a single short sentence reporting:
   - What the echo tool returned
   - The exact count of <channel source="roost-stub"> tick events you saw arrive during your session

End immediately after that sentence. No follow-up questions, no extra tool calls.'

STDOUT_LOG="${LOG_DIR}/test2-child-stdout.log"
STDERR_LOG="${LOG_DIR}/test2-child-stderr.log"

echo "[test2] launching child claude (ROOST_TICK_MS=${ROOST_TICK_MS})..."
START_TS=$(date +%s)

cd "${ROOST_DIR}"

claude \
  --print \
  --dangerously-skip-permissions \
  --mcp-config "${ROOST_DIR}/mcp-config.json" \
  --dangerously-load-development-channels server:roost-stub \
  --allowedTools "mcp__roost-stub__echo Bash" \
  --output-format text \
  "${CHILD_PROMPT}" \
  > "${STDOUT_LOG}" 2> "${STDERR_LOG}"

CHILD_EXIT=$?
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

echo "[test2] child exited ${CHILD_EXIT} after ${ELAPSED}s"
echo "[test2] stdout:"
sed 's/^/  | /' "${STDOUT_LOG}"
echo "[test2] stderr (last 30 lines):"
tail -n 30 "${STDERR_LOG}" | sed 's/^/  | /'

# Identify child JSONL: any *.jsonl in projects dir that wasn't there pre-run.
POST_JSONLS="$(ls "${PROJECTS_DIR}"/*.jsonl 2>/dev/null | sort)"
CHILD_JSONL="$(comm -13 <(echo "${PRE_JSONLS}") <(echo "${POST_JSONLS}") | head -1)"

if [[ -z "${CHILD_JSONL}" ]]; then
  echo "[test2] FAIL: no new child session JSONL detected"
  exit 1
fi

echo "[test2] child JSONL: ${CHILD_JSONL}"
echo "[test2] child JSONL size: $(wc -c < "${CHILD_JSONL}") bytes, $(wc -l < "${CHILD_JSONL}") lines"

# Out-of-band tick ground truth from the side log(s).
echo "[test2] tick side-logs in ${TICK_LOG_DIR}:"
if compgen -G "${TICK_LOG_DIR}/ticks-*.log" > /dev/null; then
  for f in "${TICK_LOG_DIR}"/ticks-*.log; do
    echo "  | $(basename "$f"): $(wc -l < "$f") ticks emitted"
    head -3 "$f" | sed 's/^/  |   /'
    if [ "$(wc -l < "$f")" -gt 3 ]; then
      echo "  |   ..."
      tail -2 "$f" | sed 's/^/  |   /'
    fi
  done
else
  echo "  | (no tick side-log files — the bun MCP may not have started)"
fi

# Hand off to the analysis script.
python3 "${ROOST_DIR}/tests/analyze-jsonl.py" "${CHILD_JSONL}"
ANALYZE_EXIT=$?

if [[ ${CHILD_EXIT} -ne 0 ]]; then
  echo "[test2] FAIL: child exited non-zero (${CHILD_EXIT})"
  exit 2
fi
exit ${ANALYZE_EXIT}
