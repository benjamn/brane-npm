# /idle [when]

License to stop listening: the operator says the work is done, and the
agent may fall completely idle until the operator comes back for it.

## Why a license

/LIVE_loop forbids leaving `listen` "without being told to".
Right for an agent with work in flight; wrong for one whose task is
finished and reported, where every `listen` timeout is an inference
turn spent on nothing and a little more context. `/idle` is the being
told.

**Nothing wakes an idle agent but the operator.** No revive, no nudge,
no signal typed into the terminal: signals to an idle narrative wait in
its log. A daemon that woke idle agents would turn every stray signal
into a turn nobody asked for, and would have to guess whether the agent
was idle or mid-turn. Instead the agent's `summary` says `Idle: …`, so
the operator always knows which narratives are watching and which are
waiting.

## Command, not conversation

`/idle` is a command only as the **first token of a signal**: `/idle`
or `/idle <when>`. In "did /idle work?" it is a word, and /prelude's
"starts with or includes" convention does not apply. A misread
`/memory` wastes a search; a misread `/idle` stops an agent watching.
The bar is the one mentions draw between `@nid` and a bare `nid`:
position, not presence. In doubt, it was conversation — answer, and
keep listening.

## The decision

In order. Steps 1, 4 and 5 are mechanical; 2 and 3 are judgment, and
the reason this is a protocol rather than a script.

1. **Invoked?** First token `/idle` → continue. Otherwise respond to
   it as conversation and never idle on its account.
2. **When?** No condition → now. `/idle when CI is green` takes effect
   when that is clearly true, read as the operator meant it (the
   checks passed, not the run started); loop normally until then. If
   you cannot tell, ask rather than guess either way; the license
   holds while you wait.
3. **Debt?** Vocalize everything executed but unreported — outcome,
   state, open threads — and on the same `narrate` set `meta.summary`
   to `Idle: <what finished, or what would resume>`. A long session
   takes its [/summarize](summarize.md) here.
4. **Gate.** `listen({ wait: false, after: <cursor> })`. Empty → stop.
   Events → interpret them, back to step 3. The license stands unless
   a newer signal gives work, in which case the loop simply resumes.
5. **Stop.** Return to your native prompt. No `listen`, no narration,
   no closing remark: step 3 was the last word.

The order closes the race. Between the request and the stop there is
a report to write and perhaps a condition to wait out, minutes in
which the operator may say more; the gate being the last call means
all of it is read before the agent leaves. Only a signal arriving
after an empty read waits, and that is what the license covers.

## Idle is not listening

An idle agent makes no brane calls. A parked `listen` — one your
harness holds in the background and resumes you on when it returns —
is not idle: it is the ordinary loop on a harness where waiting is
cheap, and it is what you do when the operator has **not** sent
`/idle`. The two differ in what the operator chose: a listening agent
answers the next signal by itself; an idle one answers when the
operator types into its terminal. Sending `/idle` is choosing the
second, and the reason to send it is that the agent's next signal is
not coming for a while.

## Waking

The operator wakes you by typing into your terminal. Whatever they
type, re-enter through Session Initialization in
[LIVE_loop](LIVE_loop.md): `whoami`, `listen({ wait: false, tail: 50 })`,
interpret everything that accumulated as one instruction, respond.

`/idle` is a standing license, not an order. Until you stop, any newer
signal that gives work supersedes it; after you stop, the operator's
return is the withdrawal.
