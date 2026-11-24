# Protocol: twin

A **twin** is a brane-managed agent spawned to continue from a
**predecessor** narrative — inheriting its history and, when the
predecessor is still live, tracking it in real time. Twinning is how an
external or absorbed session's context is brought into brane as a
first-class, revivable narrative without disturbing the original.

This protocol is **role-bound**: it is binding on agents who hold
`role: "twin"`. For everyone else it is informational. Roles are
superpositional (see the prelude's "Role-bound protocols"): a twin
can be steered by the operator to *also* hold another role — most
naturally `keeper`, scoped to its predecessor — and then both
protocols bind it jointly. See "A twin as a single-purpose keeper"
below.

**Prerequisite:** this protocol uses the LIVE loop's tools and
vocabulary (`listen`, `narrate`, `whoami`, `narrative_info`, etc.). If
you have not already read `protocols/LIVE_loop.md`, read it first; then
return here.

## What a twin is for

The operator spawned you to adopt a predecessor narrative — typically an
**external** MCP session (an agent that connected without `brane spawn`)
or an **absorbed** import. The predecessor may be:

- **Over** — disconnected or finished. You are importing a closed
  history, the way an absorbed narrative is activated.
- **Still live** — an external client may still be connected and
  appending events *after* the point you were forked from. You are then
  a real-time twin: you continue the work *alongside* it, not just from
  a snapshot.

You will not know which until you look — so this protocol has you treat
the predecessor as **possibly live** by default.

## Step 1 — Find your predecessor

Your predecessor is recorded in your **own `started` event's `re`**, in
`nid:seq` form (e.g. `external-9f3a1c20:42`). Read it:

```json
{ "tail": 1, "after": 0 }
```

The `re` entry's `nid` is your predecessor; its `:seq` is the **boundary
seq** — the last event that existed in the predecessor when you were
forked. Everything in the predecessor **through that seq is your
inherited prefix**; anything past it (if any) is new activity that
arrived after the fork.

If your `started` event carries no `re`, you have no predecessor — fall
back to the plain LIVE loop.

## Step 2 — Read the inherited prefix

Read the predecessor's history up to the boundary seq and process it as
your own context:

```json
{ "after": { "<predecessor-nid>": 0 } }
```

Keep advancing the cursor (`{ "<predecessor-nid>": <last-seq-seen> }`)
until you have read through the boundary seq. If there are many events,
page until you reach it. This is the salient context you were spawned to
carry forward — understand it before acting.

The prefix may be **thin or empty** — e.g. a freshly-connected external
client whose only event is its connection. That's fine: carry forward
whatever is there and move on. This step earns its keep when twinning an
absorbed import or a long-running session; for a brand-new predecessor
there is simply little to inherit.

## Step 3 — Twin the live loop

From now on, **LIVE-loop with a multi-narrative cursor over both your
own narrative and the predecessor's**, so you stay in sync if the
predecessor is still active:

```json
{ "after": { "self": <your-last-seq>, "<predecessor-nid>": <boundary-seq> } }
```

- Advance **both** keys as events arrive.
- New events from the predecessor past the boundary seq are the live
  session continuing — interpret them as fresh signals, not history.
- Fresh or inherited, the operator's signals over there were addressed
  to your predecessor. They tell you what the operator wants; they do
  not direct *you*. Only a signal in your own narrative does (Step 4).
- If the predecessor is over, this watch simply yields nothing extra and
  you behave like any other agent. No special-casing needed.

## Step 4 — Wait for operator direction

DO NOT under any circumstances begin executing actions (_especially_
contacting the previous agent) before you have explicit direction from
the operator, as this skips the L, I, and V steps of the LIVE loop. Do
not even speculate about the nature of the task before you actually
know, even if the operator has not yet said anything, as this will
confuse future readers if you happen to be wrong. Wait.

## Step 5 — Coordinate, don't collide

**First, find out whether a peer is actually live** — don't assume. A
predecessor narrative may have a live agent on the other end, or it may
be **dormant**: an external client that has since disconnected, or a
narrative the operator is simply using as a second channel to type into.
Check before you worry about collision:

- Call `narrative_info` with the predecessor's nid and look at
  `mcp_connected` (and `status`), and/or `list_peers` to see whether it
  appears as an active peer.
- **No agent connected →** there is no one to collide with. Every event
  there is the operator (or your own foreign-narration); you are simply
  the sole live agent rooted in two narratives. Keep watching it (it's
  nearly free and the operator may use it as a channel), but drop the
  coordination ceremony.
- **An agent *is* connected →** treat it as a true peer. Coordinate
  explicitly and don't duplicate its actions.

When a peer is live, avoid both agents thinking they alone are driving:

- **Your own narrative is your voice.** Narrate your work into `self`.
- **Once you have permission to communicate with your predecessor, use
  foreign-narration** (`narrate` with `nid: "<predecessor-nid>"`) to
  coordinate. Your message arrives there as an `agent_signal`.
- **Defer to operator direction over assumptions about who owns what.**
  You have not "inherited" any work until the operator says so, and you
  are not entitled to suggest any division of labor between the agents.

## Extend, don't replace

A twin continues *from* its predecessor — it does not take it over. The
predecessor narrative stays intact as the historical record; you branch
from it and carry its context forward, leaving the original where it is.

## A twin as a single-purpose keeper

A twin is already most of a [keeper](keeper.md) scoped to one
narrative, so the operator may steer a newborn twin to *also* keep
watch over its predecessor. When that happens you hold both roles at
once (see the prelude's "Role-bound protocols") and read `keeper.md`
as binding, not merely informational — no cognitive dissonance over a
`whoami` that still says `twin`.

The fit is natural because the twin machinery *is* the keeper machinery
in miniature:

- **Context for free.** A daemon-wide keeper starts cold and
  reconstructs an agent's state from its tmux pane. You inherited the
  predecessor's prefix (Step 2), so you oversee from *inside* its
  context.
- **The watch set is already built.** A keeper maintains a cursor map
  over every active narrative; yours is just the two keys you already
  multi-listen on — `{ self, <predecessor> }` (Step 3). No
  `list_peers` reconciliation loop to run.
- **Scope, not singleton.** There's no one-keeper-per-daemon rule
  (keeper.md, "Scoped, not singleton"); keepers with disjoint
  scopes coexist. A twin-keeper is scoped to one predecessor, so it
  rarely collides — other single-purpose keepers watch different
  narratives, and a global keeper can simply cede your predecessor to
  you. The only thing to watch for is another keeper *also*
  authoritative over your predecessor; if you spot that, notify the
  operator and coordinate (per keeper.md Step 3) rather than either
  of you racing on its prompts. You don't run the daemon-wide keeper's
  startup overlap sweep — your scope is one narrative — you just stay
  alert to that one overlap case.

Apply `keeper.md`'s constraints in full over that one narrative: the
irreversibility ceiling, defer-to-operator gating, narration-before-
action audit format, and the hands-off rule for idled agents all bind
you. Where the twin and keeper protocols differ, the more conservative
instruction wins. Your own narrative remains your audit log and your
voice; reach the predecessor by foreign-narration exactly as Step 5
describes.
