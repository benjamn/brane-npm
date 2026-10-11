# /summarize [guidance]

Consolidate a session into a durable summary narration — the nap that
lets a fresh session pick up without re-learning what just happened.

## Why summarize

A session accumulates context that is about to be lost: the context
window gets compacted or cleared, the agent session dies and is
revived, a twin takes over, or the operator simply returns tomorrow.
The narrative event log survives all of these — but a reader arriving
cold gets the log in event order, newest last, with the load-bearing
conclusions scattered among the play-by-play. A summary narration is
the consolidation pass that fixes this: one event, near the end of the
log, that a `listen(wait: false, tail: 50)` on re-entry finds
immediately, stating where things stand.

The framing comes from Erik Bylund's "Agents Need Sleep"
(erikbylund.com, 2026): memory needs **consolidation as a first-class
practice** — a light "nap" after each unit of work so that "a fresh
session tomorrow picks up without re-learning what just happened."
Consolidation's job is salience, compression, trust, and *forgetting*
— not retrieval, which search already handles. `/summarize` is the
nap, adapted to brane's substrate.

That substrate changes the risk profile. Bylund's central warning —
*"distillation concentrates error exactly as efficiently as it
concentrates signal"* — is about mutable state files, where the
summary silently replaces the record and a stale claim inherits full
authority. A brane summary is a narration: append-only, attributed,
timestamped, and sitting *beside* the events it summarizes rather than
over them. It cannot erase anything, and every claim in it can carry
an `nid:seq` citation back to the event it came from. That is the
discipline this protocol enforces: a summary is a **checkable index
into the record**, not a replacement for it. Written this way, the
summary doubles as a **trailing table of contents** for the
narrative: its `nid:seq` backlinks — which the operator's UI
auto-linkifies into links that jump to the exact event — let a
reader navigate the whole session from one narration.

## Audiences

Write for all of these at once, in roughly this priority:

1. **Your future self** after a `/clear`, compaction, or revive —
   reloading via `listen` and needing plan, stance, and in-flight
   state back without re-reading everything.
2. **A successor or twin** continuing the work with none of your
   context (see the [twin](twin.md) protocol).
3. **The operator**, catching up asynchronously — possibly on a
   phone, possibly days later.
4. **Future search and `/digest` runs** — the summary is the event
   most worth surfacing for the whole session, so make it findable
   and self-contained.

The quality bar is Bylund's stranger test: **could a stranger read
this one narration and know where things stand?** If understanding it
requires having watched the session, it is not done.

## What a good session summary is

**A state snapshot, not a chronicle.** Report where things stand
*now* — not the order in which you got there. The sequence of
attempts, tool calls, and course corrections is already in the log in
perfect fidelity; re-telling it is the one thing a summary can never
do better than the record itself. Chronology earns a place only where
it explains the present ("X was tried before Y ruled it out").

**Forgetting is the job.** The append-only log is what makes
aggressive compression safe: nothing you omit is lost, only demoted to
search. Drop the routine and the resolved. What must *not* be dropped:
open threads, unanswered operator questions, and negative findings —
"we tried X and it failed because Y" is expensive knowledge that a
successor will otherwise re-purchase.

**Grounded, not remembered.** A wrong confident summary is worse than
no summary at all — it gets read *instead of* the record, so its
errors propagate with the full authority of consolidation. The rules
are the same as [/digest](digest.md)'s, and they are mandatory:

- Re-read the events before summarizing them. Your in-context memory
  of the session may already be compacted prose; the log is not.
  Report only what the log actually says.
- Cite claims as `nid:seq` so they are checkable — and so the summary
  works as an entry point into `listen` / `narrative_search` for any
  reader who needs the detail (see the [memory](memory.md) protocol).
  Always the full `nid:seq` form: prose like "seq 42" is not
  linkified, so it makes a claim checkable but not tappable.
- Repo facts (branch names, PR numbers, commit hashes, test results)
  are copied from real `git`/`gh` output obtained this run, never
  composed from memory to look precise.
- Attribute positions; don't assert them. Decisions are "the operator
  directed…" / "we agreed…" with a citation, not settled fact. Don't
  editorialize, sharpen vague outcomes into definite ones, or supply
  motives the events don't give.
- Name your gaps instead of filling them. If part of the session is
  unread or an outcome is unverified, say so plainly.

## Interpreting guidance

`/summarize [guidance]` is freeform; interpret intent generously, as
`/digest` does. The default — bare `/summarize` or
`/summarize session` — is the current narrative, whole session,
general audience. Guidance can adjust any of:

- **Scope** — `/summarize since the last summary`,
  `/summarize the last hour`, `/summarize the auth work only`
- **Audience** — `/summarize for a twin` (lean toward in-flight
  state, gotchas, and next actions), `/summarize for the operator`
  (lean toward outcomes and open questions)
- **Target** — `/summarize claude-4c7289d1`: summarize another
  narrative, loading it first via `listen` with a cursor (see
  *Cross-Narrative Context Loading* in [memory](memory.md)). Narrate
  the summary into your own narrative unless directed otherwise.
- **Focus** — any topical emphasis the guidance names

## Gathering

Ground the summary in the log, not in what you think you remember:

1. Find your previous summary, if any — scan your own narrative for
   the `**Session summary**` header (a `listen` re-read, or
   `narrative_search` scoped by content). Its seq is your default
   window start, and your `re` target for supersession.
2. Re-read the window: `listen` with `wait: false` and `after` set to
   the previous summary's seq (or `0` for the whole narrative —
   paginate if long). Note the seqs of load-bearing events as you go:
   operator direction, decisions, reversals, results.
3. Corroborate externals — run `git`/`gh` for any repo state the
   summary will assert; check that "done" things are actually merged,
   pushed, or passing.

For long sessions, narrate brief progress as you gather, per the LIVE
loop's narrate-often principle.

## Summary structure

Begin the narration with a header line:

```
**Session summary** — {one-line gist} ({date})
```

Then sections as needed, omitting any that are empty. Suggested
shape, not a rigid template — let the session's actual shape win:

- **Where things stand** — current state of the work: what exists,
  what is verified working, what is merely drafted. Concrete
  locations: branch, worktree, files, PRs.
- **Decisions** — direction set during the session, attributed and
  cited (`nid:seq`). Include decisions *against* things.
- **Open threads** — in-flight work, unanswered questions, promised
  follow-ups, blockers. This is the section a successor acts on
  first; make each item actionable.
- **Lessons and dead ends** — negative findings worth keeping:
  approaches ruled out and why, gotchas discovered, anything a
  successor would otherwise re-learn the hard way.
- **Pointers** — key events (`nid:seq`), PRs/commits, files, wiki
  pages (`slug#anchor`) for readers who need to go deeper. Together
  with the citations woven through the sections above, this is the
  trailing-table-of-contents role made explicit: every major beat of
  the session reachable through a backlink.

Keep it compact — a summary that must be summarized has failed.
Compression is safe precisely because the pointers carry the depth.

## Output

Narrate the summary in full via `narrate`, on one call that also:

- **Sets `meta.summary`** to a current one-liner for the narrative
  list — e.g. `"Summarized: daemon refactor merged; expo tab bug
  open"`. The narrated body and the metadata line serve different
  readers (log vs. list); update both.
- **Back-references via `re`**: the previous `**Session summary**`
  event if one exists (supersession by reference — the new summary
  visibly succeeds the old, and the chain of summaries becomes
  walkable), plus the load-bearing events the summary rests on.

Before posting, make one verification pass over the draft: every
claim, citation, and identifier — can you point to the event or
command output you read it from? Cut or flag anything you cannot.

## Cadence

`/summarize` runs when the operator invokes it, but the natural
moments to *suggest* one (or, with standing permission, run one) are
exactly Bylund's nap boundaries: a unit of work just completed, a
`/clear` or handoff is imminent, or the session is winding down. A
summary written while context is still warm is cheap; the same
summary reconstructed after context loss is expensive and worse.

The heavier tier — Bylund's "deep sleep," where accumulated summaries
are themselves challenged against reality and distilled — is not this
protocol. Cross-narrative consolidation belongs to [/digest](digest.md)
(activity over a time window) and the [/wiki](wiki.md) audit (curated
synthesis against the record).

## After generating

Return to the LIVE loop — `listen` for further signals. The operator
may ask follow-ups, request a different focus, or use the summary as
the handoff point for a `/clear` or twin spawn.
