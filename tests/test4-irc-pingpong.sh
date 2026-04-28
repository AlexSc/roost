#!/bin/bash
# Test 4 — Real cross-session exchange via IRC-MCP
#
# Two interactive Claude sessions, each with the IRC-MCP loaded under
# its own nick, both joined to #test. Orchestrator sends "ping N" to
# the channel; worker replies "pong N"; orchestrator increments and
# sends "ping N+1". Continue until ping 5 / pong 5.
#
# This is the integration check before the IRC-MCP becomes the
# production thing. If both sessions' caches stay clean (1h TTL, no
# messages_changed/tools_changed beyond the known one-time deferred-tool
# promotion miss), we have working architecture.
#
# Sub-assertions:
#   (a) both sessions spawn and accept dev-channels prompts
#   (b) both sessions load the IRC-MCP and join #test
#   (c) ping/pong loop completes 5 rounds without intervention
#   (d) listener log shows interleaved ping/pong messages from both nicks
#   (e) both sessions stay on 1h cache TTL
#   (f) only allowed cache miss reasons appear: tools_changed (one-time),
#       unavailable (benign), previous_message_not_found (idle, shouldn't
#       happen in this short test)

set -uo pipefail

ROOST_DIR="/Users/alex/Dev/GoCarrot/roost"
PROJECTS_DIR="/Users/alex/.claude/projects/-Users-alex-Dev-GoCarrot-roost"
LOG_DIR="${ROOST_DIR}/tests/logs"
mkdir -p "${LOG_DIR}"
LISTENER_LOG="${LOG_DIR}/test4-listener-$(date +%s).log"
DONE_DIR="/tmp/roost-test4"
mkdir -p "${DONE_DIR}"
rm -f "${DONE_DIR}"/*

ORCH_SESSION="roost-test4-orch"
WORKER_SESSION="roost-test4-worker"
LISTENER_SESSION="roost-test4-listener"
CHANNEL="#test"
ROUNDS=5

PRE_JSONLS="$(ls "${PROJECTS_DIR}"/*.jsonl 2>/dev/null | sort)"

# Cleanup any prior sessions.
for s in "${ORCH_SESSION}" "${WORKER_SESSION}" "${LISTENER_SESSION}"; do
  tmux kill-session -t "$s" 2>/dev/null || true
done

echo "[test4] starting standalone IRC listener..."
tmux new-session -d -s "${LISTENER_SESSION}" -x 200 -y 50 -c "${ROOST_DIR}" \
  "ROOST_LISTEN_LOG=${LISTENER_LOG} ROOST_LISTEN_NICK=t4watcher ROOST_LISTEN_CHAN=${CHANNEL} \
   bun run tests/irc-listener.ts"
sleep 2

# Worker first — it needs to be in the channel before orchestrator sends ping 1.
echo "[test4] launching worker session..."
tmux new-session -d -s "${WORKER_SESSION}" -x 200 -y 50 -c "${ROOST_DIR}" \
  "ROOST_IRC_NICK=t4worker ROOST_IRC_CHANNELS=${CHANNEL} \
   claude --mcp-config ${ROOST_DIR}/mcp-config-irc.json \
          --dangerously-skip-permissions \
          --dangerously-load-development-channels server:roost-irc"

echo "[test4] launching orchestrator session..."
tmux new-session -d -s "${ORCH_SESSION}" -x 200 -y 50 -c "${ROOST_DIR}" \
  "ROOST_IRC_NICK=t4orch ROOST_IRC_CHANNELS=${CHANNEL} \
   claude --mcp-config ${ROOST_DIR}/mcp-config-irc.json \
          --dangerously-skip-permissions \
          --dangerously-load-development-channels server:roost-irc"

# Dismiss dev-channels prompts (poll-for-string).
echo "[test4] dismissing dev-channels prompts..."
for s in "${WORKER_SESSION}" "${ORCH_SESSION}"; do
  for i in $(seq 1 30); do
    if tmux capture-pane -t "$s" -p 2>/dev/null \
         | grep -q "I am using this for local development"; then
      tmux send-keys -t "$s" Enter
      echo "[test4]   ${s}: prompt dismissed at +${i}s"
      break
    fi
    sleep 1
  done
done

# Give the IRC-MCPs a moment to register and join.
sleep 6

# Worker prompt — standing instruction.
WORKER_PROMPT='You are roost Test 4 worker, on IRC as nick "t4worker". You have the roost-irc MCP loaded and you have already auto-joined #test.

STANDING INSTRUCTION: Each time you receive a channel event from the channel #test of the form "ping N" (where N is an integer), reply by calling the mcp__roost-irc__channel_message tool with channel="#test" and text="pong N" (same N). Always use that exact format, no extra words.

After you have replied to ping 5 (so you have just sent pong 5), do exactly this:
1. Call the Bash tool with command "touch /tmp/roost-test4/worker.done"
2. Stop. Do not produce further output.

Do not initiate any messages on your own. Only react to ping events from #test.'

# Orchestrator prompt.
ORCH_PROMPT='You are roost Test 4 orchestrator, on IRC as nick "t4orch". You have the roost-irc MCP loaded and you have already auto-joined #test. The other agent in #test is "t4worker", who will reply "pong N" whenever you say "ping N".

Your task:
1. Call mcp__roost-irc__channel_message with channel="#test" and text="ping 1".
2. When you see a channel event from #test of the form "pong N" sent by t4worker (and only by t4worker), if N < 5 call mcp__roost-irc__channel_message with channel="#test" and text="ping (N+1)".
3. After you have observed pong 5 from t4worker, call the Bash tool with command "touch /tmp/roost-test4/orch.done", then stop.

Use exactly the formats "ping N" and read responses with form "pong N". Do not embellish. Do not call any tools other than mcp__roost-irc__channel_message and Bash.'

# Send worker prompt first so it is listening when orchestrator pings.
echo "[test4] sending worker prompt..."
PF=$(mktemp); printf '%s' "${WORKER_PROMPT}" > "$PF"
tmux load-buffer -b t4worker "$PF"
tmux paste-buffer -t "${WORKER_SESSION}" -b t4worker -p
tmux send-keys -t "${WORKER_SESSION}" Enter
rm -f "$PF"
sleep 3

echo "[test4] sending orchestrator prompt..."
PF=$(mktemp); printf '%s' "${ORCH_PROMPT}" > "$PF"
tmux load-buffer -b t4orch "$PF"
tmux paste-buffer -t "${ORCH_SESSION}" -b t4orch -p
tmux send-keys -t "${ORCH_SESSION}" Enter
rm -f "$PF"

# Wait for both done markers, max 180s.
echo "[test4] waiting for both done markers (max 180s)..."
for i in $(seq 1 180); do
  if [ -f "${DONE_DIR}/orch.done" ] && [ -f "${DONE_DIR}/worker.done" ]; then
    echo "[test4] both done markers seen at +${i}s"
    break
  fi
  sleep 1
done

if [ ! -f "${DONE_DIR}/orch.done" ]; then
  echo "[test4] WARN: orch.done never appeared"
fi
if [ ! -f "${DONE_DIR}/worker.done" ]; then
  echo "[test4] WARN: worker.done never appeared"
fi

# Snapshot panes for diagnostic.
for s in "${ORCH_SESSION}" "${WORKER_SESSION}"; do
  echo
  echo "[test4] === ${s} pane (last 20 lines) ==="
  tmux capture-pane -t "$s" -p -S -100 2>/dev/null | tail -20 | sed 's/^/  | /'
done

echo
echo "[test4] === IRC listener log ==="
cat "${LISTENER_LOG}" 2>&1 | sed 's/^/  | /'

# Teardown.
for s in "${ORCH_SESSION}" "${WORKER_SESSION}" "${LISTENER_SESSION}"; do
  tmux kill-session -t "$s" 2>/dev/null || true
done
sleep 3

# Identify the two new JSONLs.
POST_JSONLS="$(ls "${PROJECTS_DIR}"/*.jsonl 2>/dev/null | sort)"
NEW_JSONLS=$(comm -13 <(echo "${PRE_JSONLS}") <(echo "${POST_JSONLS}"))
N_NEW=$(echo "${NEW_JSONLS}" | grep -c jsonl || true)

echo
echo "[test4] ${N_NEW} new JSONLs:"
echo "${NEW_JSONLS}" | sed 's/^/  | /'

# Per-session analysis.
SESSION_IDX=0
ANY_5M=0
ANY_BAD_MISS=0
ALL_PINGS=0
ALL_PONGS=0
for jsonl in ${NEW_JSONLS}; do
  SESSION_IDX=$((SESSION_IDX+1))
  echo
  echo "[test4] --- session ${SESSION_IDX}: $(basename "${jsonl}") ---"
  python3 "${ROOST_DIR}/tests/analyze-jsonl.py" "${jsonl}" 2>&1 || true

  cc_5m=$(jq -r '[.. | objects | .cache_creation? | objects | .ephemeral_5m_input_tokens? // 0] | add' "${jsonl}" 2>/dev/null)
  cc_5m=${cc_5m:-0}
  if [ "${cc_5m}" -gt 0 ] 2>/dev/null; then ANY_5M=1; fi
  miss_types=$(jq -r '.. | objects | .cache_miss_reason? | objects | .type? // empty' "${jsonl}" 2>/dev/null | sort -u || true)
  for m in ${miss_types}; do
    case "$m" in
      tools_changed|unavailable|previous_message_not_found) ;;
      *) ANY_BAD_MISS=1; echo "  ✗ unexpected miss: ${m}" ;;
    esac
  done
done

# Listener-side ping/pong tally.
ALL_PINGS=$(grep -c "ping [1-9]" "${LISTENER_LOG}" 2>/dev/null || echo 0)
ALL_PONGS=$(grep -c "pong [1-9]" "${LISTENER_LOG}" 2>/dev/null || echo 0)

echo
echo "============================================="
echo "[test4] SUMMARY"
echo "============================================="
echo "  rounds requested:             ${ROUNDS}"
echo "  pings observed (listener):    ${ALL_PINGS}"
echo "  pongs observed (listener):    ${ALL_PONGS}"
echo "  orch.done present:            $([ -f "${DONE_DIR}/orch.done" ] && echo yes ✓ || echo NO ✗)"
echo "  worker.done present:          $([ -f "${DONE_DIR}/worker.done" ] && echo yes ✓ || echo NO ✗)"
echo "  any session on 5m bucket:     $([ ${ANY_5M} -eq 0 ] && echo no ✓ || echo YES ✗)"
echo "  any unexpected miss:          $([ ${ANY_BAD_MISS} -eq 0 ] && echo no ✓ || echo YES ✗)"
echo "  new JSONLs:                   ${N_NEW}"

OK=1
if [ "${ALL_PINGS}" -lt "${ROUNDS}" ] || [ "${ALL_PONGS}" -lt "${ROUNDS}" ]; then
  echo "  ✗ FAIL: ping/pong count short of ${ROUNDS} rounds"
  OK=0
fi
if [ ! -f "${DONE_DIR}/orch.done" ] || [ ! -f "${DONE_DIR}/worker.done" ]; then
  echo "  ✗ FAIL: at least one session did not signal completion"
  OK=0
fi
if [ "${ANY_5M}" -eq 1 ]; then
  echo "  ✗ FAIL: at least one session wrote to 5m cache bucket"
  OK=0
fi
if [ "${ANY_BAD_MISS}" -eq 1 ]; then
  echo "  ✗ FAIL: unexpected cache miss reason"
  OK=0
fi
if [ "${N_NEW}" -lt 2 ]; then
  echo "  ✗ FAIL: expected 2 JSONLs"
  OK=0
fi

if [ ${OK} -eq 1 ]; then
  echo
  echo "[test4] PASS — IRC-MCP cross-session exchange works clean"
  exit 0
else
  echo
  echo "[test4] FAIL — see findings above"
  exit 1
fi
