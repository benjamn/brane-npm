# MCP and the LIVE Loop

The MCP bridge, how a parked `listen` wakes and retires, the LIVE loop tools, and narrative metadata.

## MCP Architecture

The MCP server (`src/mcp/server.ts`) is a **thin stdio↔WebSocket bridge**. It has zero SQLite dependency. All tool logic (narrate, listen, whoami, revive, etc.) lives in the daemon at `src/daemon/server.ts`.

**Error handling convention**: Use `sendToolError()` for real errors (maps to MCP `isError: true`), not `sendToolResult({ error: ... })`. The bridge at `src/mcp/server.ts` translates `tool_error` → `isError: true` on the MCP response. Foreign narration to non-existent narrative IDs returns a tool error.

When `brane spawn` creates an agent session, it sets `BRANE_NARRATIVE_ID` as a tmux session environment variable (not in the MCP config file). The MCP bridge process inherits this from the tmux environment at startup. This allows multiple agents to share the same fold without conflicting MCP configs. The one exception is Copilot, which requires explicit env in its per-session config file since it doesn't inherit parent env vars into MCP subprocesses.

### Listen Wakeup

**The caller's own words never interrupt its waiting.** `checkForEvents`
returns everything in range but reports an *arrival* only for an event whose
server-stamped `source` isn't the caller, so an agent's own narration (here or
narrated into another narrative) neither wakes its parked listen, ends its
waiting narrate, nor returns a blocking listen at once. It is still returned
alongside whatever does arrive, and a `wait: false` read returns it on its
own. #515 dropped those events from forward reads instead, and an agent that
resumed after compaction with a remembered cursor lost them silently; the
daemon can't tell that read from any other. Pinned by
`src/test/listen-own-words.test.ts`.

**A listen outlives nothing.** A parked listen (or waiting narrate) whose
socket closes is retired by the MCP close handler — `cleanup()` unregisters
its wakeups, its tool row settles, and no reply is built — and `wakeup`
refuses to answer on a socket that isn't `OPEN`. Otherwise the next event
ran its `reply`, and the mention receipt inside it marked mentions sent
(and read) into a socket that drops the send.

**Nor does it outlive its caller's patience.** Esc, or killing a
backgrounded tool task, reaches the bridge as MCP `notifications/cancelled`.
The bridge forgets the call (a late result is dropped, never sent) and sends
the daemon `tool_cancel`; `cancelMcpCall` retires the parked call as the
close handler does, and the awaiting glow goes out at once. Before, the bridge answered the notification "Method not found" (an
error with no id, which Claude Code logs as a connection error) and the
daemon never heard, so a cancelled listen glowed until the next event or the
hour-long timeout. Notifications are never answered, known or not. Pinned by
`src/test/mcp-bridge-cancel.test.ts` and `src/test/awaiting.test.ts`.

The daemon uses a `listenWaiters` map to immediately wake blocked `listen` calls when new events arrive. When a signal is sent or a narration is written, `notifyListenWaiters(nid)` fires all registered callbacks for that narrative. This replaces polling and gives near-instant delivery.

`narrate({ wait: true })` is a narrate followed by a listen in one call, so an exchange costs the agent one re-read of its context instead of two. `handleMcpNarrate` writes the narration and returns a `NarrateWaitPlan`; the dispatcher hands the plan to `startMcpListen`, which parks on the plan's cursor with the new narration filtered out wherever it landed (`omit` in `checkForEvents`) and returns listen's result plus the narration's `nid`, `seq` and `warnings`. There is no second waiting mechanism: wakeup, poller, timeout, mention receipt and shutdown flush are listen's, and the pending entry carries its `toolName` so the narrate's row is the one that settles. `narrateWaitCursor` accepts any cursor `listen` does, multi-narrative included (claude-2il811nw:31); with none, it waits from the current heads of the caller's narrative and, for a foreign narration, the target's. `before`/`tail` have nothing to wait for, and they fall back rather than refuse: the narrate posts as usual and its receipt carries `wait_ignored`, since a refusal would cost the agent the narration and a turn to resend it. On a lost daemon connection the bridge tells a pending narrate to check before re-narrating rather than to retry, since a waiting narrate has always already posted.

## LIVE Loop Protocol

Agents communicate via cursor-based long-polling. Read `protocols/LIVE_loop.md` for full details.

Core tools available via MCP:

| Tool | Purpose |
|------|---------|
| **narrate** | Vocalize status + receive pending signals (non-blocking) |
| **listen** | Block until signals arrive (long-poll with timeout) |
| **whoami** | Get narrative ID and brane ID |
| **revive** | Restart a dead agent session |
| **narrative_search** | Semantic search across narrative history |
| **narrative_info** | Get narrative info: browse recent narratives or get details on specific ones |
| **list_peers** | List active LIVE-loop agent peers, grouped by fold |
| **list_branes** | List all branes hosted by this daemon (caller's home first) — use to expand `narrative_search` / `narrative_info` across branes |
| **list_protocols** / **read_protocol** | Access protocol documents |

## Narrative Metadata

Narratives have persistent `summary` and `title` columns. Agents set them via the `meta` parameter on `narrate`. The daemon broadcasts metadata changes over the control WebSocket as `type: "meta"` messages. The Expo app renders the summary as a subtitle below the narrative ID.

Narratives can be **archived** via `PATCH /api/narratives/:id/archive`. Archived narratives are hidden from the default list but preserved in the database.
