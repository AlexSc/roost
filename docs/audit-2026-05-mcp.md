# Roost simplify pass — MCP/IRC layer (May 2026)

Audit of the MCP server, IRC plumbing, perm-irc layer, and their test
helpers — 9 files, ~1772 LOC; ~half is `src/irc-server.ts` at 911.

**Headline:** three layers should be three files — the IRC protocol
layer, a full-featured IRC client (almost weechat-minus-TUI), and an
MCP UI for agents. Today layers 2 and 3 are mashed into one 780-line
closure in `src/irc-server.ts`. The [Rearchitect
proposal](#rearchitect-proposal-ircclient-extraction) splits them:
~480-LOC `src/irc-client.ts` + ~300-400-LOC `src/mcp.ts`. Total LOC
roughly the same; the seam is what changes.

**22 findings** (6 delete, 2 correctness, 14 clarify) plus the
rearchitect proposal as its own deliverable.

## Categories

**delete** — dead code, duplicate code, defensive-for-impossible code,
speculative params with no callers, single-use wrappers earning their
status only by name. **clarify** — code that stays but hides the happy
path or repeats a shape often enough that extraction reads better.
**correctness** — live latent bugs, races, swallowed signals. When
ambiguous between delete and clarify I preferred delete.

## Meta-finding: silent fall-through

A pattern that recurs across closed bugs #87/#92/#97/#100: code takes
an unrecognized input, a stale cache, or an unexpected branch and
proceeds as if everything is fine. Each fix was small; the shape kept
reappearing because nothing in the codebase makes "this case shouldn't
happen" loud when it does. Present-tense instances in scope: C1, C2,
L4, L8 — see the per-finding section.

## Top wins (read these first)

| # | Title | Cat | Δ LOC | Sev |
|---|---|---|---|---|
| **R** | **Rearchitect: extract `RoostIrcClient` from `createMcpServer`** | architecture | shape, not LOC | high |
| D1 | Collapse `channel_message`/`direct_message` handlers | delete | −15 | medium |
| L1 | Lift `TOOL_SCHEMAS` to module-level constant | clarify | ~0 | medium |
| C1 | `socket close` leaves resolvers on 5s timer | correctness | +2 | medium |
| C2 | `server-time` cap requested but not validated | correctness | +6 | medium |
| L2 | Three near-parallel emit functions | clarify | −5 | low |
| L3 | `setTimeout(...).unref?.()` repeated 3x | clarify | −6 | low |
| D2-D4 | `roost-permbot` dead state (`fileno`, `registered`, dlog gate) | delete | −6 | low |

---

## Rearchitect proposal: IrcClient extraction

The mental model — three layers:

- **The IRC protocol layer** — wire format, batches, caps. Owned by
  the library (today `irc-framework`).
- **A full-featured IRC client** — almost weechat-minus-TUI. Owns
  history, users, replay-dedupe, multiline assembly, unread, presentation.
- **An MCP UI for agents** — translates between agents and the client.
  Thin.

**Scope note:** this proposal *is* the deliverable. Acting on it is
per-slice execution work — not an alpha gate, not bundled with this
PR. The slices below can land alpha, beta, or never; each is
independently green.

### Current shape

`createMcpServer(ircClient, config)` is a 780-line closure
(irc-server.ts:58-837) that does five things at once:

1. Holds IRC client state (history, user sets, fingerprints, resolvers,
   multiline cap, ready flag).
2. Defines IRC event handlers (registered, join, part, kick, quit, nick,
   message, two batch-end variants, socket close/error).
3. Implements MCP tool dispatch (8 tools).
4. Bridges IRC events to MCP notifications via three emit-helpers.
5. Does send-side multiline batching.

The seam is loose: `createMcpServer` takes `ircClient` as an arg, then
mutates MCP-internal state (`unread`, `mcp.notification` calls) inside
IRC event handlers. Layers entangled though conceptually independent.

### Proposed split

Three files, mapping to the three layers:

| Proposed file | Layer | Responsibility | Est. LOC |
|---|---|---|---|
| `src/irc-client.ts` *(new)* | full-featured client | `RoostIrcClient` class — wraps `irc-framework`, owns history, users, fingerprints, unread, multiline assembly. Typed methods + typed event surface. | ~480 |
| `src/mcp.ts` *(replaces `src/irc-server.ts`)* | MCP UI | Declares tools, dispatches to `RoostIrcClient`, bridges client events to `mcp.notification`. | ~300-400 |
| `src/irc-lib.ts` *(unchanged)* | protocol helpers | Pure functions: `splitLineForMultiline`, `findNaturalBoundary`, `newBatchId`, `reassembleMultilineBatch`. | 74 |

`src/constants.ts` (3 lines) stays. `bin/roost-irc-server` (the 3-line
launcher) updates to point at `src/mcp.ts`; `.mcp.json` references the
launcher by name so no consumer-side change.

### Proposed `RoostIrcClient` interface

```ts
export interface RoostIrcClient {
  // Lifecycle (caller still owns connect timing)
  connect(opts: ConnectOpts): void
  isReady(): boolean

  // Outbound
  join(channel: string, force?: boolean): Promise<boolean>
  leave(channel: string): Promise<boolean>
  say(target: string, text: string): { chunks: number; mode: 'single' | 'multiline' }
  whoisChannels(nick?: string): Promise<string[] | false>

  // State queries
  getHistory(key: string, limit?: number): IrcMessage[]
  getUsers(channel: string): string[]
  getUnread(): Map<string, UnreadInfo>
  ackUnread(key: string): void

  // Replay-dedupe (PreCompact handler)
  clearDedupeCache(): void

  // Typed event surface
  on(event: 'message',    handler: (msg: IrcMessage, meta: MessageMeta) => void): void
  on(event: 'membership', handler: (kind: 'join'|'leave'|'nick', nick: string, channel: string, extras: MembershipExtras) => void): void
  on(event: 'system',     handler: (kind: 'disconnected'|'reconnected', content: string) => void): void
}
```

### Move table — every closure binding accounted for

#### State variables

| # | Today's location | Symbol | Verdict | Note |
|---|---|---|---|---|
| 1 | irc-server.ts:64 | `irc_ready` | → IrcClient internal | exposed via `isReady()` |
| 2 | irc-server.ts:65 | `hasRegistered` | → IrcClient internal | drives reconnect-vs-initial-register branching |
| 3 | irc-server.ts:66 | `join_resolvers` | → IrcClient internal | `join()` returns Promise |
| 4 | irc-server.ts:67 | `part_resolvers` | → IrcClient internal | same |
| 5 | irc-server.ts:72 | `multilineMaxLines` | → IrcClient internal | derived from cap negotiation |
| 6 | irc-server.ts:76 | `history` Map | → IrcClient internal | exposed via `getHistory(key, limit)` |
| 7 | irc-server.ts:89 | `unread` Map | → IrcClient internal | exposed via `getUnread()` / `ackUnread()` (see Q1) |
| 8 | irc-server.ts:107 | `seenFingerprints` Map | → IrcClient internal | exposed via `clearDedupeCache()` |
| 9 | irc-server.ts:138 | `receiveSeq` | **stays in MCP shim** | numbers MCP notifications, not IRC events |
| 10 | irc-server.ts:149 | `channelUsers` Map | → IrcClient internal | exposed via `getUsers(channel)` |

#### Inline helpers

| # | Today's location | Symbol | Verdict | Note |
|---|---|---|---|---|
| 11 | irc-server.ts:77-82 | `pushHistory(key, msg)` | → IrcClient private | |
| 12 | irc-server.ts:91-96 | `formatUnreadLine(...)` | → MCP shim helper | translates client's raw UnreadInfo → display string |
| 13 | irc-server.ts:98-101 | `unreadSuffix()` | → MCP shim helper | |
| 14 | irc-server.ts:109 | `msgFingerprint(msg)` | → IrcClient private | |
| 15 | irc-server.ts:112-122 | `addFingerprint(msg)` | → IrcClient private | |
| 16 | irc-server.ts:124-125 | `hasFingerprint(msg)` | → IrcClient private | |
| 17 | irc-server.ts:150-157 | `ensureChannelSet(channel)` | → IrcClient private | |
| 18 | irc-server.ts:159-210 | `sendMultiline(target, text)` | → IrcClient public method (`say`) | renamed |
| 19 | irc-server.ts:212-218 | `pushNotification(content, meta)` | → MCP shim helper | |
| 20 | irc-server.ts:221-249 | `emitChannelEvent(msg, extras)` | **splits**: IrcClient applies pushHistory + addFingerprint + unread bookkeeping internally, then emits typed `message` event; MCP shim subscriber calls pushNotification | the conflated case from L2 |
| 21 | irc-server.ts:255-277 | `emitMembershipEvent(...)` | **splits**: IrcClient emits typed `membership` event; MCP shim subscriber formats summary + pushNotification | same shape |
| 22 | irc-server.ts:281-285 | `emitSystemEvent(...)` | **splits**: IrcClient emits typed `system` event; MCP shim formats + pushNotification | same shape |
| 23 | irc-server.ts:823-834 | `emitUnreadSummary` | → MCP shim method | queries `client.getUnread()`, formats, pushes notification; SIGUSR2 wires to it |

#### MCP server pieces

| # | Today's location | Symbol | Verdict | Note |
|---|---|---|---|---|
| 24 | irc-server.ts:289-298 | `mcp = new Server(...)` instance | → MCP shim | base of the MCP module |
| 25 | irc-server.ts:300-402 | ListTools handler with inline tool schemas | → MCP shim, lift schemas to module const (see L1) | TOOL_SCHEMAS const |
| 26 | irc-server.ts:404-547 | CallTool handler (switch dispatch) | → MCP shim, **bodies become 1-3 line wrappers** around RoostIrcClient methods | L1+D1 collapse here |

#### IRC event handlers

| # | Today's location | Event | Verdict | Note |
|---|---|---|---|---|
| 27 | irc-server.ts:551-604 | `'registered'` | → IrcClient internal | cap parsing, auto-rejoin on reconnect |
| 28 | irc-server.ts:606-620 | `'join'` | **splits** | state mutation in client; emits `membership` for non-self joins |
| 29 | irc-server.ts:624-637 | `'userlist'` | → IrcClient internal | populates channelUsers; no MCP-visible event today |
| 30 | irc-server.ts:639-656 | `'part'` | **splits** | state mutation in client; resolves part_resolvers; emits `membership` for non-self |
| 31 | irc-server.ts:661-679 | `'kick'` | **splits** | same shape as part |
| 32 | irc-server.ts:683-695 | `'quit'` | **splits** | clears all channels for self; per-channel `membership` emit for non-self |
| 33 | irc-server.ts:700-712 | `'nick'` | **splits** | renames in every channel set; emits anchored to "first shared channel" — see C2 |
| 34 | irc-server.ts:714-736 | `'message'` | **splits** | history + fingerprint in client; `message` event to subscribers |
| 35 | irc-server.ts:739-768 | `'batch end draft/multiline'` | **splits** | reassembly + history in client; `message` event |
| 36 | irc-server.ts:771-811 | `'batch end chathistory'` | **splits** | dedup + history in client; `message` events with `historical` flag |
| 37 | irc-server.ts:813-817 | `'socket close'` | **splits** | client clears `irc_ready`; emits `system('disconnected')` — see C1 |
| 38 | irc-server.ts:819-821 | `'socket error'` | → IrcClient internal | stderr trace only |

#### Returned API

| # | Today's location | Symbol | Verdict |
|---|---|---|---|
| 39 | irc-server.ts:836 | `{ server, clearDedupeCache, emitUnreadSummary }` | shape changes — entrypoint constructs `RoostIrcClient`, then `createMcpServer` takes the client; `clearDedupeCache` becomes a method on the client; `emitUnreadSummary` stays MCP-side and queries the client |

### Open questions

**Q1. Where does `unread` live? — resolved: in `RoostIrcClient`.** Per
the three-layer model, unread is IRC-client state, not MCP presentation
state. MCP shim queries via `getUnread()` / `ackUnread()`. Knock-on:
future non-MCP consumers can query unread directly.

**Q2. Where does `receiveSeq` live? — resolved: stays in MCP shim.**
Numbers `mcp.notification` calls; pure MCP concern.

**Q3. Should the multiline cap value be a typed object?** Today parsed
string-split at irc-server.ts:561-566. A `MultilineCapValues` +
`parseMultilineCap()` is a trivial extraction; helps if Q5 lands. Open.

**Q4. Does `channelUsers` belong with IRC client or in a separate state
module? — resolved: stays inside IrcClient.** Every read flows through
`channel_who` or the membership handlers; no external consumer.

**Q5. Should we migrate the orchestrator from Python to TS so both
processes share `RoostIrcClient`?** Plausible but **out of scope** —
warrants its own issue. The Python orchestrator has its own ~160 LOC
in-file IrcClient (`bin/orchestrator_poll`); the JS extraction makes a
future TS port cheap, but the decision is much bigger than "extract
IrcClient." Flagging here; not arguing for it.

**Q6. Is `irc-framework` the right substrate?** Open research question.
The library forces `// @ts-expect-error — irc-framework lacks first-class
type defs` at three sites (`src/irc-server.ts:32`,
`test/helpers/peer.ts:1`, `test/helpers/mcp-inprocess.ts:3`). Our IRCv3
needs span multiline batches, chathistory, server-time, labeled-response,
and cap negotiation — most of which we hand-roll on top of the library's
lower-level event surface (see `'batch end draft/multiline'` /
`'batch end chathistory'` handlers, the manual cap parser at
irc-server.ts:561-566, the fingerprint dedupe layered over chathistory
replay). Two sub-questions: *can `irc-framework` do more of this lifting
natively?* and *are there better-typed, more IRCv3-native alternatives?*
(e.g. `irc.js`/`irc-message`-family, or building on `irc-framework`'s
lower wire layer with our own typed wrapper). Materially affects the
rearchitect — `RoostIrcClient` is the right place to consolidate or
swap. Worth a spike before extraction lands; not blocking the audit.

### What this unlocks

- **Typed IRC surface.** Three `// @ts-expect-error` sites today; after
  extraction, the suppression appears once inside `RoostIrcClient`.
- **MCP shim becomes scannable.** Adding a tool = method on client + 3-line
  wrapper in the switch + tests. No closure spelunking.
- **Direct `RoostIrcClient` testability.** Tests can assert at IRC-level
  directly; MCP shim tested only for the tool surface.
- **Replay-dedupe and history become inspectable.** Closure-scoped Maps
  become methods — queryable from tests / debug tools.
- **Self-event handling consolidates.** The `event.nick === NICK`
  early-return at 8 sites collapses to one branch or a typed `self.*` surface.

### Estimated effort

| Slice | Effort | Risk | Notes |
|---|---|---|---|
| Define `RoostIrcClient` interface in new file | S | low | mostly typing |
| Move `irc-framework` instantiation + `connect`/`registered` handler | S | low | localizes the @ts-expect-error |
| Move `history` + `pushHistory` + `getHistory` | S | low | pure state move |
| Move `channelUsers` + `getUsers` + userlist/join/part/kick/quit/nick handlers (inline emits become typed-event calls) | M | low | bulk of the move |
| Move `seenFingerprints` + `clearDedupeCache` | S | low |  |
| Move `sendMultiline` → `say` | S | low | rename + signature shift |
| Move `join_resolvers`/`part_resolvers` + `join`/`leave` methods | S | low |  |
| Move multiline-cap parsing | S | low | optional Q3 typing |
| Rewrite MCP shim's CallTool switch as 1-3 line wrappers | M | low | |
| Subscribe MCP shim to `RoostIrcClient` events; build typed `MessageMeta`/`MembershipExtras` | M | medium | the bridging is where bugs hide |
| Update `test/helpers/mcp-inprocess.ts` to construct `RoostIrcClient` directly | S | low |  |
| Run tests, hunt for closure-leak bugs | M | medium | |

---

## Findings — `src/irc-server.ts` (911 LOC)

### D1. `channel_message` and `direct_message` handlers duplicate — delete · medium · −15 LOC

`src/irc-server.ts:415-440`. Both call `sendMultiline`, `unread.delete`,
build the same note/preview/suffix. Only the target arg name and prefix
string differ.

**Fix:** subsumed by R (the two cases become 1-line wrappers around
`client.say()`); if R doesn't land, extract `formatSendResult(target,
text, prefix)` shared by both.

### L1. `TOOL_SCHEMAS` lifted to module-level constant — clarify · medium · ~0 LOC

`src/irc-server.ts:300-402`. 103 lines of static tool-schema JSON
declared inline in the ListTools handler — ~13% of the function body
referencing zero closure state.

**Fix:** lift to `const TOOL_SCHEMAS: Tool[] = [...]` at module scope;
handler becomes `async () => ({ tools: TOOL_SCHEMAS })`.

### L2. Three near-parallel emit functions — clarify · low · −5 LOC

`src/irc-server.ts:221-285` — `emitChannelEvent`, `emitMembershipEvent`,
`emitSystemEvent` each build a meta record (channel/sender/isDirect/ts),
call `pushNotification`, write a stderr trace.

**Fix:** subsumed by R (becomes three event-bridge subscribers in the
MCP shim); if R doesn't land, extract a `buildBaseMeta` helper.

### L3. `setTimeout(...).unref?.()` idiom repeated 3x — clarify · low · −6 LOC

`src/irc-server.ts:452, 468, 522`. Each Promise-with-timeout repeats
`setTimeout(() => resolve(false), 5000).unref?.()`.

**Fix:** subsumed by R (`join`/`leave` become Promise-returning methods
on `RoostIrcClient` with timeout internalized); if R doesn't land,
extract a `withTimeout` helper.

### L4. `multilineMaxLines` cap parser silently `continue`s on bad values — clarify · low · ~0 LOC

`src/irc-server.ts:561-566`. The parser `continue`s on non-finite or
non-positive values, silently keeping the `100` placeholder. Won't bite
today (we control both ends via ergo) but it's the silent-fall-through
shape.

**Fix:** stderr warn on malformed values, or replace with a typed parser
(Q3).

### C1. `socket close` leaves pending join/part resolvers on 5s timer — correctness · medium · +2 LOC

`src/irc-server.ts:813-817` (`'socket close'` handler) + lines 446-453
(join), 463-468 (leave). When the socket drops mid-`channel_join`, the
resolver stays alive until its 5s timer fires; the caller gets
`'join #foo timed out'` instead of "we lost the connection."

**Fix:** in `'socket close'`, walk both resolver maps and resolve each
entry with `false` immediately. Resolver code already handles `false`.

### C2. `server-time` cap requested but not validated — correctness · medium · +6 LOC

`src/irc-server.ts:558-575` (multiline gate, present) vs `:900`
(server-time requested, unchecked) vs `:731, 795` (consumers). Live
`'message'` falls back to `new Date().toISOString()` when the time tag
is missing; chathistory replay reads `c.getServerTime?.()`. If
`server-time` is silently disabled, the same message arriving live and
via chathistory backfill yields two `ts` values → fingerprint mismatch
→ dedupe fails → duplicate emitted. Exact #44 shape.

**Fix:** mirror the multiline gate — add `if (!enabled.includes('server-time'))
{ stderr; process.exit(1) }`.

### L5. `userlist` handler's `set.add(NICK)` is defensive-for-impossible — clarify · low · −1 LOC

`src/irc-server.ts:631`. `userlist` fires post-`RPL_NAMREPLY/ENDOFNAMES`,
which only fires after our JOIN succeeds — the server *guarantees*
our nick is in `event.users`. The `set.add(NICK)` defends against a
contradiction.

**Fix:** drop the line and the stale "we're definitely there" comment.
Trust the protocol.

### L6. `'nick'` membership event anchors arbitrarily to "first shared channel" — clarify · low · ~0 LOC

`src/irc-server.ts:700-712`. A nick change is global, but we emit one
membership event scoped to whichever channel iterates first in the Map
— the meta says `channel: X` for an event that isn't per-channel. The
same anchoring leaks into `unread` and `history` Maps: the nick handler
only renames in `channelUsers`, so DM history/unread keyed on the old
nick is stranded after a rename (`channel_history alice` returns the
old DMs, `channel_history alex` is empty).

**Fix:** rename the nick in every Map keyed on it (`channelUsers`,
`history`, `unread`); for the membership event, either emit one per
shared channel or emit a single global event with `channel: ''` (the
system-event shape at irc-server.ts:281-285 has precedent). Edge of
correctness — agents don't care today, but truthfulness will matter.

### L7. `mcp.notification(...).catch(() => {})` swallows silently — clarify · low · +2 LOC

`src/irc-server.ts:217`. The empty catch matches any rejection — the
inline comment names "transport teardown" but real bugs would also be
swallowed.

**Fix:** narrow the catch — log to stderr unless the error message
indicates the known-OK transport-closed shape.

### L13. Unread-suffix is an undocumented contract — clarify · low · ~0 LOC

`src/irc-server.ts:419-426, 432-439, 530-534, 823-834`. Unread surfaces
to the agent at four sites (channel_message / direct_message result
trailers, channel_list output, SIGUSR2 unread-summary) — and is
mentioned in zero tool schema descriptions. The MCP `instructions`
field (line 296) names only the SIGUSR2 event. Agents learn the
"after sending you also get unread for other channels" nudge by
observation.

**Fix (pick one):** document the suffix in each tool's description and
the `instructions` string; or scope unread to SIGUSR2 + a dedicated
`unread_list` MCP tool, dropping the bolt-on suffix entirely.

### L14. Channel-name case-handling is inconsistent — clarify · low · ~0 LOC

`src/irc-server.ts:442, 462` lowercase channel keys on entry to
`channelUsers`; `:728, 733-734` (history, unread, emit-side) use
`event.target` server-case. Invisible on ergo (server normalizes
lowercase); on a server that preserves mixed-case, `channel_who #FOO`
and `channel_history #FOO` would disagree.

**Fix:** normalize at one boundary — best done as part of R, where
`RoostIrcClient` becomes the canonicalizer. Materially related to Q6:
substrate swap may bring different canonicalization rules.

---

## Findings — `bin/roost-permbot` (318 LOC)

### D2-D4. Dead state — delete · low · −6 LOC

Three small dead bindings on the same wrapper class:

- **D2.** `bin/roost-permbot:57-58` — `dlog` early-return is dead;
  `DEBUG_LOG` is truthy unconditionally so `if not DEBUG_LOG: return`
  never fires. Drop the guard.
- **D3.** `bin/roost-permbot:75-76` — `IRC.fileno` method never called;
  selectors register `irc.sock` directly (line 135). Delete the method.
- **D4.** `bin/roost-permbot:73, 256` — `IRC.registered` set in
  `__init__` and on `001`, never read. Delete both lines.

### L9. In-flight tuple shape is positional, not named — clarify · low · ~0 LOC

`bin/roost-permbot:140-141, 186, 271, 285`. `in_flight = (client_sock,
req, deadline)` is unpacked positionally at three sites. A future
addition (queue-depth metric, request id) means rewriting every unpack.

**Fix:** `dataclass`/`NamedTuple` `InFlight(client_sock, req, deadline)`;
all unpacks become attribute access.

---

## Findings — `bin/irc-permission-prompt` (262 LOC)

### L8. Fall-back-to-terminal is invisible to remote operators — clarify · low · ~0 LOC

`bin/irc-permission-prompt:39-40, 233, 248-249, 258`. The `emit("ask",
reason)` path defers to Claude Code's local terminal prompt — fine for
interactive use, but for an unattended worker spawn (the common case)
the local terminal has no human watching, and the worker blocks
indefinitely on a prompt nobody sees.

**Fix:** when falling back to terminal, also DM the operator (if known
via `ROOST_PERM_TARGET`) with the reason and tool summary. Doesn't
override the terminal prompt; just makes the failure visible to the
same human who owns the worker. Promotable to medium if oversight gaps
recur.

---

## Findings — `test/helpers/`

### D5. `startMcp` `extraEnv` parameter is unused — delete · low · −2 LOC

`test/helpers/mcp.ts:13, 24`. No call site passes a third arg.

**Fix:** drop the param.

### D6. `wireMcpClient` `clientName` parameter is cosmetic — delete · low · −3 LOC

`test/helpers/mcp-core.ts:32, 40` (call site `mcp-inprocess.ts:43`
passes `'roost-test-ip'`). Surfaces only in the MCP initialize
handshake, not asserted anywhere.

**Fix:** drop the param, hardcode `'roost-test'`.

### L10. Two near-identical `startMcp` shapes — clarify · low · ~0 LOC

`test/helpers/mcp.ts` (subprocess via stdio) and `mcp-inprocess.ts`
(in-process via InMemoryTransport) do the same five things in different
order. Differences are real (process boundary vs in-process) but the
shared shape isn't visible.

**Fix:** subsumed by R — both helpers construct `RoostIrcClient`
directly post-extraction; if R doesn't land, status quo is fine.

### L11. `wireMcpClient`'s waiter cleanup uses identity comparison — clarify · low · ~0 LOC

`test/helpers/mcp-core.ts:71-78`. The timeout's cleanup finds the
waiter to splice via `w.resolve === wrappedResolve` — function
identity, closed-over per-call. Works today; a refactor that memoized
resolvers would silently break cleanup.

**Fix:** unique id (counter) at insert; cleanup indexes by id. Or
accept the identity shape and add a comment naming it.

### L12. `pollUntilIrcReady` couples to a string-literal sentinel — clarify · low · ~0 LOC

`test/helpers/mcp-core.ts:96` (`text.includes('not ready')`); partner
string at `src/irc-server.ts:409` (`'IRC client not ready (still
connecting).'`). The substring check is intentional — JSDoc documents
the design — but a wording change on either side would silently mask
real bring-up races.

**Fix:** export a shared `NOT_READY_SENTINEL` from `src/irc-server.ts`
so server and test reference the same literal.

---

## Findings — `bin/roost-irc-server` (3 LOC)

Skipped — single-purpose PATH-resolvable launcher referenced from
`.mcp.json`. Required as-is.

---

## Skipped / out of scope

- **`src/constants.ts` ↔ `bin/orchestrator_poll` `MULTILINE_LINE_BYTES`**:
  cross-language constant, documented in `orchestrator_poll`'s comment.
  Orchestrator outside MCP/IRC scope.
- **`bin/orchestrator_poll`'s Python `IrcClient`**: see Q5.
- **Adding new MCP tools**: orthogonal.

---

## Pattern issues — what shape enabled them, is it still here?

- **#87 (permbot reply parser exact-match):** fixed at
  `bin/irc-permission-prompt:251-253` via first-token split. Shape gone.
- **#92 (cache staleness on reconnect):** fixed by reconnect cache
  invalidation + auto-rejoin (`src/irc-server.ts:582-595`); `channel_list`
  goes to the server (PR #108). Shape mostly gone — local cache can
  still briefly drift between disconnect detection and reconnect.
- **#97 (deny reason not propagated):** fixed at
  `bin/irc-permission-prompt:251-258` — first token decides, rest
  becomes the message. Shape gone.
- **#100 (channel_leave fire-and-forget):** fixed at
  `src/irc-server.ts:461-475`. Shape gone. C1 is a sibling — resolver
  pattern is correct but doesn't pre-empt on socket close.

Live present-tense instances of silent fall-through in this audit:
**C1, C2, L4, L8.**
