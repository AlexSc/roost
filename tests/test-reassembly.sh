#!/bin/bash
# Reassembly test: sender posts a long message; receiver should see
# exactly one channel event with the full text, with meta.reassembled=true.
# A standalone listener observes the raw IRC wire and should see >1
# PRIVMSG (the split chunks).

set -uo pipefail

ROOST_DIR="/Users/alex/Dev/GoCarrot/roost"
PROJECTS_DIR="/Users/alex/.claude/projects/-Users-alex-Dev-GoCarrot-roost"
LOG_DIR="${ROOST_DIR}/tests/logs"
mkdir -p "${LOG_DIR}"
LISTENER_LOG="${LOG_DIR}/test-reassembly-listener-$(date +%s).log"
DONE_DIR="/tmp/roost-reassembly"
mkdir -p "${DONE_DIR}"
rm -f "${DONE_DIR}"/*

CHANNEL="#reassembly-test"
SENDER_SESSION="roost-reasm-sender"
RECEIVER_SESSION="roost-reasm-receiver"
LISTENER_SESSION="roost-reasm-listener"

PRE_JSONLS="$(ls "${PROJECTS_DIR}"/*.jsonl 2>/dev/null | sort)"

for s in "${SENDER_SESSION}" "${RECEIVER_SESSION}" "${LISTENER_SESSION}"; do
  tmux kill-session -t "$s" 2>/dev/null || true
done

echo "[reasm] starting listener..."
tmux new-session -d -s "${LISTENER_SESSION}" -x 200 -y 50 -c "${ROOST_DIR}" \
  "ROOST_LISTEN_LOG=${LISTENER_LOG} ROOST_LISTEN_NICK=reasm-watcher ROOST_LISTEN_CHAN=${CHANNEL} \
   bun run tests/irc-listener.ts"
sleep 2

echo "[reasm] launching receiver..."
tmux new-session -d -s "${RECEIVER_SESSION}" -x 200 -y 50 -c "${ROOST_DIR}" \
  "ROOST_IRC_NICK=reasm-rx ROOST_IRC_CHANNELS=${CHANNEL} \
   claude --mcp-config ${ROOST_DIR}/mcp-config-irc.json \
          --dangerously-skip-permissions \
          --dangerously-load-development-channels server:roost-irc"

echo "[reasm] launching sender..."
tmux new-session -d -s "${SENDER_SESSION}" -x 200 -y 50 -c "${ROOST_DIR}" \
  "ROOST_IRC_NICK=reasm-tx ROOST_IRC_CHANNELS=${CHANNEL} \
   claude --mcp-config ${ROOST_DIR}/mcp-config-irc.json \
          --dangerously-skip-permissions \
          --dangerously-load-development-channels server:roost-irc"

# Dismiss dev-channels prompts.
for s in "${RECEIVER_SESSION}" "${SENDER_SESSION}"; do
  for i in $(seq 1 30); do
    if tmux capture-pane -t "$s" -p 2>/dev/null \
         | grep -q "I am using this for local development"; then
      tmux send-keys -t "$s" Enter
      echo "[reasm] $s: prompt dismissed at +${i}s"
      break
    fi
    sleep 1
  done
done

sleep 6

# Build a long, distinctive payload — must span >3 chunks at MAX_CHUNK_BODY=300
# to exercise the adaptive-window fix (which kicks in once chunkCount > 1
# and must hold across server-side rate-limit pauses between chunks).
# Also includes sentence punctuation so we can eyeball whether splits
# land on natural boundaries.
LONG_MSG='REASSEMBLY-PROBE: '
for n in $(seq 1 60); do
  LONG_MSG+="word${n} "
done
LONG_MSG+='. Sentence two with more content. '
for n in $(seq 61 120); do
  LONG_MSG+="word${n} "
done
LONG_MSG+='. Sentence three closing. '
for n in $(seq 121 180); do
  LONG_MSG+="word${n} "
done
LONG_MSG+=':END'
EXPECTED_BYTES=${#LONG_MSG}
echo "[reasm] payload length: ${EXPECTED_BYTES} chars"
# Use printf (no trailing newline) so byte-for-byte equality with the
# receiver's Write-tool output works.
printf '%s' "${LONG_MSG}" > "${DONE_DIR}/expected.txt"

# Receiver: standing instruction. When it sees the probe, write it to
# a file with full text and chunk count from meta.reassembled.
RECEIVER_PROMPT='You are the roost reassembly-test receiver, on IRC as nick "reasm-rx", auto-joined to #reassembly-test. Standing instruction:

When you receive any channel event from #reassembly-test that contains the literal string "REASSEMBLY-PROBE:", do exactly this:

1. Use the Write tool to write the EXACT message body you received (starting with "REASSEMBLY-PROBE:" and ending with ":END") to file path /tmp/roost-reassembly/received.txt. The content should be ONLY the message text, no extra quotes or characters.

2. Then run the Bash tool with command: touch /tmp/roost-reassembly/receiver.done

Then stop. Do not initiate any messages. Only react to the probe.'

SENDER_PROMPT="You are the roost reassembly-test sender, on IRC as nick \"reasm-tx\", auto-joined to #reassembly-test.

Do exactly this:

1. Call mcp__roost-irc__channel_message with channel=\"#reassembly-test\" and text set to the EXACT string below (a single line, no trimming):
${LONG_MSG}

2. Then run Bash: touch /tmp/roost-reassembly/sender.done

Then stop. Do not initiate further messages."

echo "[reasm] sending receiver prompt..."
PF=$(mktemp); printf '%s' "${RECEIVER_PROMPT}" > "$PF"
tmux load-buffer -b reasm-rx-prompt "$PF"
tmux paste-buffer -t "${RECEIVER_SESSION}" -b reasm-rx-prompt -p
tmux send-keys -t "${RECEIVER_SESSION}" Enter
rm -f "$PF"
sleep 4

echo "[reasm] sending sender prompt..."
PF=$(mktemp); printf '%s' "${SENDER_PROMPT}" > "$PF"
tmux load-buffer -b reasm-tx-prompt "$PF"
tmux paste-buffer -t "${SENDER_SESSION}" -b reasm-tx-prompt -p
tmux send-keys -t "${SENDER_SESSION}" Enter
rm -f "$PF"

# Wait for both done markers.
echo "[reasm] waiting for done markers (max 90s)..."
for i in $(seq 1 90); do
  if [ -f "${DONE_DIR}/sender.done" ] && [ -f "${DONE_DIR}/receiver.done" ]; then
    echo "[reasm] both done at +${i}s"
    break
  fi
  sleep 1
done

# Snapshot panes.
for s in "${SENDER_SESSION}" "${RECEIVER_SESSION}"; do
  echo
  echo "[reasm] === ${s} pane (last 18 lines) ==="
  tmux capture-pane -t "$s" -p -S -100 2>/dev/null | tail -18 | sed 's/^/  | /'
done

echo
echo "[reasm] === IRC listener log (raw wire) ==="
sed 's/^/  | /' "${LISTENER_LOG}" 2>&1

# Teardown.
for s in "${SENDER_SESSION}" "${RECEIVER_SESSION}" "${LISTENER_SESSION}"; do
  tmux kill-session -t "$s" 2>/dev/null || true
done
sleep 2

# Locate receiver JSONL.
POST_JSONLS="$(ls "${PROJECTS_DIR}"/*.jsonl 2>/dev/null | sort)"
NEW_JSONLS=$(comm -13 <(echo "${PRE_JSONLS}") <(echo "${POST_JSONLS}"))
echo
echo "[reasm] new JSONLs:"
echo "${NEW_JSONLS}" | sed 's/^/  | /'

# Receiver-side check: was the long message reassembled into one event?
RX_JSONL=""
for j in ${NEW_JSONLS}; do
  if grep -q "reasm-rx" "$j" 2>/dev/null && grep -q "reasm-tx" "$j" 2>/dev/null; then
    RX_JSONL="$j"
    break
  fi
done
[ -z "${RX_JSONL}" ] && RX_JSONL=$(echo "${NEW_JSONLS}" | head -1)

echo
echo "[reasm] receiver JSONL: ${RX_JSONL}"
RX_LEGACY_MARKERS=$(grep -c 'roost-split' "${RX_JSONL}" 2>/dev/null; true)
RX_BUFFERED=$(grep -c 'buffered' "${RX_JSONL}" 2>/dev/null; true)
RX_PROBES=$(grep -c 'REASSEMBLY-PROBE' "${RX_JSONL}" 2>/dev/null; true)
echo "[reasm] roost-split markers in receiver JSONL (should be 0): ${RX_LEGACY_MARKERS}"
echo "[reasm] buffered (meta key) occurrences in receiver JSONL (should be >=1): ${RX_BUFFERED}"
echo "[reasm] REASSEMBLY-PROBE occurrences in receiver JSONL: ${RX_PROBES}"

# Listener: count PRIVMSGs from the sender (regardless of body content),
# and detect any legacy markers on the wire.
LISTENER_PRIVMSGS=$(grep -c "<reasm-tx>" "${LISTENER_LOG}" 2>/dev/null; true)
LISTENER_MARKERS=$(grep -c "roost-split" "${LISTENER_LOG}" 2>/dev/null; true)
echo
echo "[reasm] listener saw ${LISTENER_PRIVMSGS} PRIVMSGs from reasm-tx (>=2 expected: split happened)"
echo "[reasm] listener saw ${LISTENER_MARKERS} legacy [roost-split:...] markers (0 expected with buffer build)"
LISTENER_HITS=${LISTENER_PRIVMSGS}

# Compare expected vs received.
if [ -f "${DONE_DIR}/received.txt" ] && [ -f "${DONE_DIR}/expected.txt" ]; then
  if diff -q "${DONE_DIR}/expected.txt" "${DONE_DIR}/received.txt" > /dev/null; then
    echo "[reasm] ✓ received.txt EXACTLY matches expected.txt"
    PAYLOAD_OK=1
  else
    echo "[reasm] ✗ received.txt differs from expected.txt:"
    diff "${DONE_DIR}/expected.txt" "${DONE_DIR}/received.txt" | head -20 | sed 's/^/  | /'
    PAYLOAD_OK=0
  fi
else
  echo "[reasm] ✗ missing received.txt or expected.txt"
  PAYLOAD_OK=0
fi

echo
echo "============================================="
echo "[reasm] SUMMARY"
echo "============================================="
echo "  payload bytes:          ${EXPECTED_BYTES}"
echo "  listener raw hits:      ${LISTENER_HITS} (expect >=2 = split happened)"
echo "  listener marker hits:   ${LISTENER_MARKERS} (expect 0 with buffer build, no body markers on wire)"
echo "  receiver payload match: $([ "${PAYLOAD_OK:-0}" -eq 1 ] && echo yes ✓ || echo NO ✗)"
echo "  sender.done present:    $([ -f "${DONE_DIR}/sender.done" ] && echo yes ✓ || echo NO ✗)"
echo "  receiver.done present:  $([ -f "${DONE_DIR}/receiver.done" ] && echo yes ✓ || echo NO ✗)"

if [ "${PAYLOAD_OK:-0}" -eq 1 ] && [ "${LISTENER_HITS}" -ge 2 ] && [ "${LISTENER_MARKERS}" -eq 0 ] \
   && [ -f "${DONE_DIR}/sender.done" ] && [ -f "${DONE_DIR}/receiver.done" ]; then
  echo
  echo "[reasm] PASS — naked split + receive-buffering works end-to-end, no markers on wire"
  exit 0
else
  echo
  echo "[reasm] FAIL — see findings above"
  exit 1
fi
