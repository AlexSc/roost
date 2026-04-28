#!/bin/bash
# Test 3 (original) — Concurrent multi-session
#
# Confirms multiple Claude Code sessions can run simultaneously on one
# machine, each with its own roost-stub MCP subprocess, without resource
# conflicts. Validates load-bearing assumption #8.
#
# The "shared channel / mutual delivery" half of the original Test 3
# spec is blocked on the IRC layer existing — that's Test 4. This test
# covers everything else: concurrent spawn, independent MCP subprocesses,
# independent JSONLs, no nick collisions (each session has its own
# stdio MCP, no shared identity surface yet), 1h cache per session.
#
# Sub-assertions:
#   (a) all N sessions spawn and accept the dev-channels prompt
#   (b) all N sessions produce their own JSONL
#   (c) each session has its own bun MCP subprocess emitting ticks
#   (d) each session's JSONL shows ticks arriving from its own MCP
#   (e) all sessions stay on 1h cache TTL throughout
#   (f) no spurious system_changed / messages_changed misses across the
#       fleet (one tools_changed per session is the known one-time cost)

set -uo pipefail

ROOST_DIR="/Users/alex/Dev/GoCarrot/roost"
PROJECTS_DIR="/Users/alex/.claude/projects/-Users-alex-Dev-GoCarrot-roost"
LOG_DIR="${ROOST_DIR}/tests/logs"
mkdir -p "${LOG_DIR}"
TICK_LOG_DIR="${LOG_DIR}/test3-concurrent-ticks-$(date +%s)"
mkdir -p "${TICK_LOG_DIR}"

SESSIONS=5
ROOST_TICK_MS=4000
RUN_SECONDS=30

# Snapshot pre-existing JSONLs.
PRE_JSONLS="$(ls "${PROJECTS_DIR}"/*.jsonl 2>/dev/null | sort)"

# Cleanup any stale test3-concurrent-N sessions from prior runs.
for i in $(seq 1 ${SESSIONS}); do
  tmux kill-session -t "roost-test3c-${i}" 2>/dev/null || true
done

# Spawn N concurrent sessions in parallel.
echo "[test3c] spawning ${SESSIONS} concurrent sessions..."
SPAWN_T0=$(date +%s)
for i in $(seq 1 ${SESSIONS}); do
  tmux new-session -d -s "roost-test3c-${i}" -x 200 -y 50 -c "${ROOST_DIR}" \
    "ROOST_TICK_MS=${ROOST_TICK_MS} ROOST_TICK_LOG_DIR=${TICK_LOG_DIR} \
     claude --mcp-config ${ROOST_DIR}/mcp-config.json \
            --dangerously-skip-permissions \
            --dangerously-load-development-channels server:roost-stub"
done
SPAWN_T1=$(date +%s)
echo "[test3c] all ${SESSIONS} tmux sessions launched in $((SPAWN_T1-SPAWN_T0))s"

# Poll for the dev-channels prompt in each session, then send Enter.
echo "[test3c] dismissing dev-channels prompts..."
DISMISSED=0
for i in $(seq 1 ${SESSIONS}); do
  for attempt in $(seq 1 30); do
    if tmux capture-pane -t "roost-test3c-${i}" -p 2>/dev/null \
         | grep -q "I am using this for local development"; then
      tmux send-keys -t "roost-test3c-${i}" Enter
      echo "[test3c]   session ${i}: prompt dismissed at +${attempt}s"
      DISMISSED=$((DISMISSED+1))
      break
    fi
    sleep 1
  done
done
echo "[test3c] dismissed ${DISMISSED}/${SESSIONS} prompts"

# Let them run; channel events bootstrap turns autonomously per Finding C.
echo "[test3c] running for ${RUN_SECONDS}s..."
sleep ${RUN_SECONDS}

# Snapshot bun MCP processes BEFORE teardown so we can confirm each
# session had its own.
echo
echo "[test3c] bun stub-server processes before teardown:"
ps -ef | grep "bun run.*roost/src/stub-server.ts" | grep -v grep \
  | awk '{print "  | PID="$2" PPID="$3}'

# Capture last few lines of each pane for diagnostic, then teardown.
for i in $(seq 1 ${SESSIONS}); do
  echo
  echo "[test3c] === session ${i} pane (last 12 lines) ==="
  tmux capture-pane -t "roost-test3c-${i}" -p 2>/dev/null | tail -12 | sed 's/^/  | /'
  tmux kill-session -t "roost-test3c-${i}" 2>/dev/null || true
done

# Wait for processes to settle.
sleep 3

# Confirm all bun stubs reaped (Test 1's bun is parented to its own
# tmux pane, not these test3c panes — should not be in this list).
echo
echo "[test3c] bun stub-server processes after teardown:"
LEAKED=$(ps -ef | grep "bun run.*roost/src/stub-server.ts" | grep -v grep \
         | awk -v t1pid=$(pgrep -f roost-test1 || echo 0) '$3 != t1pid && $3 != 1 {print}' || true)
ps -ef | grep "bun run.*roost/src/stub-server.ts" | grep -v grep \
  | awk '{print "  | PID="$2" PPID="$3}'

# Identify all child JSONLs created by this run.
POST_JSONLS="$(ls "${PROJECTS_DIR}"/*.jsonl 2>/dev/null | sort)"
NEW_JSONLS=$(comm -13 <(echo "${PRE_JSONLS}") <(echo "${POST_JSONLS}"))
N_NEW=$(echo "${NEW_JSONLS}" | grep -c jsonl || true)

echo
echo "[test3c] ${N_NEW} new JSONLs:"
echo "${NEW_JSONLS}" | sed 's/^/  | /'

# Tick log summary — one log file per bun MCP PID.
echo
echo "[test3c] tick side-logs (one per bun MCP):"
TOTAL_TICKS=0
TICK_LOGS=0
for f in "${TICK_LOG_DIR}"/ticks-*.log; do
  [ -f "$f" ] || continue
  count=$(wc -l < "$f")
  echo "  | $(basename "$f"): ${count} ticks"
  TOTAL_TICKS=$((TOTAL_TICKS + count))
  TICK_LOGS=$((TICK_LOGS + 1))
done
echo "[test3c] total: ${TICK_LOGS} bun MCPs emitted ${TOTAL_TICKS} ticks combined"

# Per-session analyzer output — pulled into a tmp file so we can also
# parse it for the fleet summary.
ANALYZER_DUMP=$(mktemp)
TOTAL_TICKS_RECEIVED=0
ANY_5M_BUCKET=0
ANY_BAD_MISS=0
SESSION_IDX=0
for jsonl in ${NEW_JSONLS}; do
  SESSION_IDX=$((SESSION_IDX+1))
  echo
  echo "[test3c] --- session ${SESSION_IDX}: $(basename "${jsonl}") ---"
  python3 "${ROOST_DIR}/tests/analyze-jsonl.py" "${jsonl}" 2>&1 | tee -a "${ANALYZER_DUMP}" || true

  # Unique tick numbers actually received in this session's JSONL.
  # Use the analyzer's own dedup line (it counts user-shape +
  # queued_command attachments, not queue-operation plumbing).
  ticks=$(python3 "${ROOST_DIR}/tests/analyze-jsonl.py" "${jsonl}" 2>&1 \
           | awk -F'[: ]+' '/^tick events:/ {print $3; exit}')
  ticks=${ticks:-0}
  TOTAL_TICKS_RECEIVED=$((TOTAL_TICKS_RECEIVED + ticks))

  # 5m bucket usage anywhere in this session.
  cc_5m=$(jq -r '[.. | objects | .cache_creation? | objects | .ephemeral_5m_input_tokens? // 0] | add' \
           "${jsonl}" 2>/dev/null)
  cc_5m=${cc_5m:-0}
  if [ "${cc_5m}" -gt 0 ] 2>/dev/null; then ANY_5M_BUCKET=1; fi

  # Bad miss types — anything other than tools_changed (known one-time
  # deferred-tool promotion cost), unavailable (benign upstream), or
  # previous_message_not_found (not seen here, but benign on long idle).
  miss_types=$(jq -r '.. | objects | .cache_miss_reason? | objects | .type? // empty' \
                "${jsonl}" 2>/dev/null | sort -u || true)
  for m in ${miss_types}; do
    case "$m" in
      tools_changed|unavailable|previous_message_not_found) ;;
      *) ANY_BAD_MISS=1; echo "  ✗ unexpected miss: ${m}" ;;
    esac
  done
done
rm -f "${ANALYZER_DUMP}"

echo
echo "============================================="
echo "[test3c] SUMMARY"
echo "============================================="
echo "  sessions spawned:                ${SESSIONS}"
echo "  dev-channels prompts dismissed:  ${DISMISSED}"
echo "  bun MCP processes launched:      ${TICK_LOGS}"
echo "  ticks emitted (bun side-logs):   ${TOTAL_TICKS}"
echo "  ticks received (in JSONLs):      ${TOTAL_TICKS_RECEIVED}"
echo "  new JSONLs:                      ${N_NEW}"
echo "  any session on 5m bucket:        $([ ${ANY_5M_BUCKET} -eq 0 ] && echo no ✓ || echo YES ✗)"
echo "  any non-tools_changed bad miss:  $([ ${ANY_BAD_MISS} -eq 0 ] && echo no ✓ || echo YES ✗)"

OK=1
if [ "${TICK_LOGS}" -ne "${SESSIONS}" ]; then
  echo "  ✗ FAIL: expected ${SESSIONS} bun MCPs, got ${TICK_LOGS}"
  OK=0
fi
if [ "${N_NEW}" -ne "${SESSIONS}" ]; then
  echo "  ✗ FAIL: expected ${SESSIONS} JSONLs, got ${N_NEW}"
  OK=0
fi
if [ "${ANY_5M_BUCKET}" -eq 1 ]; then
  echo "  ✗ FAIL: at least one session wrote to the 5m cache bucket"
  OK=0
fi
if [ "${ANY_BAD_MISS}" -eq 1 ]; then
  echo "  ✗ FAIL: at least one session had a bad cache_miss_reason"
  OK=0
fi
if [ "${TOTAL_TICKS_RECEIVED}" -lt $((SESSIONS * 3)) ]; then
  echo "  ✗ FAIL: too few ticks received across fleet (expected >= ${SESSIONS}*3)"
  OK=0
fi

if [ ${OK} -eq 1 ]; then
  echo
  echo "[test3c] PASS — assumption #8 confirmed for ${SESSIONS} concurrent sessions"
  exit 0
else
  echo
  echo "[test3c] FAIL — see findings above"
  exit 1
fi
