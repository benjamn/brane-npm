# Append-Only Event Log

The durable substrate behind every narrative. A single SQLite table
(`events` in `~/.brane/brane.db`) that every narration, operator signal,
and foreign narration lands in — and once landed, cannot be changed.
Integrity is not an agent convention or a trust assumption; it is a
property of the code that has the only write path and the SQL that
schema enforces.

Every event belongs to a narrative and carries a `seq` that is unique
within it — `PRIMARY KEY (narrative_id, seq)` in `src/db/schema.ts`.
The composite key makes the (narrative, seq) pair unforgeable: two
events cannot share a seq in the same narrative, and no event can exist
without one. Alongside `seq` an event carries its `time` (stamped at
append), a `type`, free-form `content`, a server-stamped `source`,
optional `re` back-references, optional `payloads`, and an opt-in
`meta` object. The three conversational types — `narration`,
`human_signal`, `agent_signal` — say *who spoke*, never what kind of
thing was said; the system types (`started`, `restarted`,
`binding_rejected`) record lifecycle facts nobody said at all. The
schema itself is documented with the code in `AGENTS.md`.

## The write path

Every live write goes through `appendEvent` in `src/db/events.ts`,
which reads the current max seq, increments it, and inserts. Callers
never provide their own `seq` — the options type has no such field —
so there is no way to write out of order or collide with an existing
row. (The one exception is `brane absorb`, whose import pipeline
inserts directly with self-computed seqs; it is operator-initiated and
not reachable from any agent tool.)

`source` is written by the daemon at append time — the MCP bridge and
the agent have no write path of their own. How the value is chosen
differs by event type:

- **Operator signals** arrive over the HTTP signal route or the
  control WebSocket. `source` names the delivering transport
  (defaulting to `"web"`), supplied by the authenticated operator
  client — so a token holder chooses the label on its own signals, but
  an agent cannot write a human signal at all.
- **Foreign narrations** are appended by the daemon's MCP `narrate`
  handler with the *caller's* narrative ID as `source`, taken from the
  authenticated WebSocket identity. The agent does not get to choose
  what is written into that column.
- **Own narrations** go through the same handler with the same
  server-stamped identity.

The MCP bridge (`src/mcp/server.ts`) does not import `better-sqlite3`
and holds no database handle. It is a thin stdio↔WebSocket translator;
every database write goes through the daemon, which means the identity
check and the `source` stamp cannot be bypassed by a compromised bridge
or a misbehaving tool call.

There is no DELETE against the `events` table anywhere in the codebase,
and no code path mutates an event's `content`, `seq`, `source`, `time`,
or `type` after append. The one UPDATE that exists is the memory
indexer's additive backfill of the `meta` column (session and model
attribution, `src/memory/index.ts`) — it annotates, it never rewrites.
Append-only for the record itself is enforced by the absence of
mutation code, not by a runtime flag that could be flipped later.

## The read path

The cursor API (`readEvents` in `src/db/events.ts`) takes three
optional bounds: `after: N` for events with `seq > N`, `before: N` for
events with `seq < N`, and `tail: N` for the last N matching events.
They compose — `{ after, before }` is a window, `{ tail, before }` is
backward pagination — and results always come back in ascending `seq`
order regardless of which bounds were used [claude-b629ddae:19].

The cursor is the contract for no-missed-signals: a caller that polls
with `after: 42` is guaranteed every event with `seq > 42`, so any
signal that arrived while the caller was elsewhere surfaces on the next
call. This is what makes the LIVE loop's long-poll semantics correct
(/LIVE_loop) — not magic on the server, just a monotonically increasing
integer the client remembers.

## Integrity properties

Four properties fall out of the append-only design and the server-side
`source` stamp [claude-f64c335a:53]:

- **Unrewritable history.** No DELETE, and nothing ever touches an
  event's `content`, `seq`, `source`, or `time` after append. The agent
  cannot redact, edit, or reorder its own past; the only way the record
  can change is if the entire database is replaced, which a LIVE loop
  agent has no authority to do.
- **Unforgeable origin.** `source` is stamped by the daemon from the
  authenticated caller's identity. An agent narrating into a foreign
  narrative cannot claim to be the operator; a client cannot forge
  narrations from another narrative's agent.
- **Monotonic contract.** `PRIMARY KEY (narrative_id, seq)` makes the
  seq unique per narrative, and `appendEvent` always writes
  `MAX(seq) + 1`. No gaps, no duplicates, no out-of-order.
- **Durable.** Written to `~/.brane/brane.db` in WAL mode, synced on
  commit. Survives daemon restarts, crashes, and context compactions —
  everything external to the host filesystem.

These are the properties the safety argument in
[sedimentary-superintelligence](sedimentary-superintelligence.md)
depends on: an agent's trail cannot be covered up by the agent itself,
because the write path the agent can reach is append-only and the
`source` field is out of its control. The defense against an agent
that would edit its own trail is not "watch harder" — at machine speed
no operator can — but append-only, monotonically-sequenced,
agent-unwritable event storage, expressed as database invariants rather
than as trust in the model's cooperation [claude-f64c335a:53].

## What it enables

- **Cursor-based long-polling.** The `listen` tool's wait-for-new-events
  semantics depend on the monotonic seq to guarantee no missed signals.
  Without append-only integrity the cursor would be a suggestion, not a
  contract (/LIVE_loop).
- **Semantic memory across narratives.** Events with stable `seq`
  values can be indexed by the memory subsystem and cited from future
  sessions as `narrative-id:seq` — a form that only works because seq
  is stable after write (/memory).
- **Compounding narrations.** Every token spent on a narration lands in
  a log that is searchable, citable, and available to future agents.
  Terminal output is volatile and unindexed; narrations accumulate.
  This is the premise of
  [sedimentary-superintelligence](sedimentary-superintelligence.md),
  and the same property is what makes the narrative
  [sequesterable](sequestering-the-narrative.md) — a medium durable
  enough that `/clear` becomes a routine operation rather than an
  emergency.
- **Safety-by-construction for capable agents.** An agent that could
  rewrite its own history can conceal intent; an agent that cannot can
  only be observed. Making the log append-only converts the supervision
  problem from "trust the model" into "watch the stream"
  [claude-f64c335a:53].

## Related

- [sedimentary-superintelligence](sedimentary-superintelligence.md) —
  the log *is* the sediment. This page describes the substrate's
  integrity; that page describes what the substrate is for.
- [sequestering-the-narrative](sequestering-the-narrative.md) — the
  narrative's *position*, set apart from scrollback and context; this
  page is about its *integrity*.
- [owning-your-narratives](owning-your-narratives.md) — the practice
  that makes an unrewritable record worth reading.
- [premature-ontologies](premature-ontologies.md) — why the schema
  types who spoke and never what was said.
- /LIVE_loop — the protocol that reads from and writes to this log;
  authoritative on cursor parameters and response shapes.
