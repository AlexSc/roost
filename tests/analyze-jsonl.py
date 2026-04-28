#!/usr/bin/env python3
"""
Analyze a Claude Code session JSONL for the roost smoke-test sub-assertions:

  - tick channel events received (count + source check)
  - cache buckets used (1h vs 5m)
  - cache_miss_reason occurrences
  - tool calls observed (echo specifically)
  - aggregate cr / cc_5m / cc_1h / miss

Usage: analyze-jsonl.py <path/to/session.jsonl>
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: analyze-jsonl.py <session.jsonl>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"FAIL: file not found: {path}", file=sys.stderr)
        return 2

    tick_re = re.compile(r'<channel source="roost-stub"[^>]*tick="(\d+)"')

    n_lines = 0
    n_assistant = 0
    n_user = 0
    n_tool_use_echo = 0
    n_tool_result = 0
    cr_total = 0
    cc_5m_total = 0
    cc_1h_total = 0
    miss_total = 0
    miss_reasons: Counter[str] = Counter()
    tick_numbers: list[int] = []

    with path.open() as fh:
        for raw in fh:
            n_lines += 1
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = rec.get("type")
            if mtype == "assistant":
                n_assistant += 1
                msg = rec.get("message", {})
                usage = msg.get("usage") or {}
                cr_total += usage.get("cache_read_input_tokens", 0) or 0
                cc_5m_total += usage.get("cache_creation", {}).get("ephemeral_5m_input_tokens", 0) or 0
                cc_1h_total += usage.get("cache_creation", {}).get("ephemeral_1h_input_tokens", 0) or 0
                # cache_miss_reason can live in two places:
                #   - usage.cache_miss_reason (older shape, plain string)
                #   - diagnostics.cache_miss_reason (newer shape, {type, cache_missed_input_tokens})
                if isinstance(usage.get("cache_miss_reason"), str):
                    miss_reasons[usage["cache_miss_reason"]] += 1
                diag = msg.get("diagnostics") or rec.get("diagnostics") or {}
                if isinstance(diag, dict):
                    cmr = diag.get("cache_miss_reason")
                    if isinstance(cmr, dict) and "type" in cmr:
                        miss_reasons[cmr["type"]] += 1
                    elif isinstance(cmr, str):
                        miss_reasons[cmr] += 1
                # also detect echo tool_use
                for blk in msg.get("content", []) or []:
                    if isinstance(blk, dict) and blk.get("type") == "tool_use":
                        if blk.get("name", "").endswith("echo"):
                            n_tool_use_echo += 1
            elif mtype == "user":
                n_user += 1
                msg = rec.get("message", {})
                content = msg.get("content")
                if isinstance(content, list):
                    for blk in content:
                        if isinstance(blk, dict):
                            if blk.get("type") == "tool_result":
                                n_tool_result += 1
                            txt = blk.get("text") or blk.get("content") or ""
                            if isinstance(txt, str):
                                for m in tick_re.finditer(txt):
                                    tick_numbers.append(int(m.group(1)))
                elif isinstance(content, str):
                    for m in tick_re.finditer(content):
                        tick_numbers.append(int(m.group(1)))
            elif mtype == "attachment":
                # Channel events that arrive while the model is mid-turn
                # are stored as attachments with type=queued_command and
                # origin.kind=channel. These represent the backpressure
                # queue draining into the next user-shape record on the
                # following turn — count them as ticks observed.
                att = rec.get("attachment") or {}
                if (
                    isinstance(att, dict)
                    and att.get("type") == "queued_command"
                    and isinstance(att.get("origin"), dict)
                    and att["origin"].get("kind") == "channel"
                ):
                    txt = att.get("prompt") or ""
                    for m in tick_re.finditer(txt):
                        tick_numbers.append(int(m.group(1)))

    # miss_total comes from miss_reasons (each entry is one miss event)
    miss_total = sum(miss_reasons.values())

    print()
    print(f"=== analysis of {path.name} ===")
    print(f"lines: {n_lines}")
    print(f"assistant turns: {n_assistant}")
    print(f"user turns:      {n_user}")
    print(f"tool_use echo:   {n_tool_use_echo}")
    print(f"tool_result:     {n_tool_result}")
    print(f"tick events:     {len(tick_numbers)}  ticks={tick_numbers}")
    print(f"cache_read (cr):                  {cr_total:,}")
    print(f"cache_create 1h (cc_1h):          {cc_1h_total:,}")
    print(f"cache_create 5m (cc_5m):          {cc_5m_total:,}")
    print(f"cache_miss events:                {miss_total}  reasons={dict(miss_reasons)}")
    print()

    failures = []
    # Sub-assertion (c)
    if n_tool_use_echo == 0:
        failures.append("(c) echo tool was never called")
    # Sub-assertion (d)
    if len(tick_numbers) < 2:
        failures.append(f"(d) expected >=2 ticks, observed {len(tick_numbers)}")
    # Sub-assertion (e)
    if cc_5m_total > 0 and cc_1h_total == 0:
        failures.append(f"(e) cache landed in 5m bucket only (cc_5m={cc_5m_total}, cc_1h=0)")
    if cc_1h_total == 0 and cc_5m_total == 0 and n_assistant > 0:
        failures.append("(e) no cache_creation observed at all")
    # Sub-assertion (f)
    bad_reasons = {r for r in miss_reasons if r in ("messages_changed", "tools_changed")}
    if bad_reasons:
        failures.append(f"(f) saw bad cache_miss_reasons: {bad_reasons}")

    if failures:
        print("FAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS — sub-assertions (c),(d),(e),(f) satisfied")
    return 0


if __name__ == "__main__":
    sys.exit(main())
