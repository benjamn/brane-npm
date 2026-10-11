# /digest [guidance]

Generate a rich digest of narrative activity over a time window.

## Accuracy is the whole job

A digest is built entirely from the **narrative event log** — the
permanent, append-only record of `narration` and `human_signal` events.
That log is the source of truth, and it does not go away: you can always
re-read any narrative's events with `listen` / `narrative_info` /
`narrative_search`. The digest is nothing more than a faithful account
of what that record says. It is itself durable too — the next `/digest`
finds this one to set its window, so one invented detail propagates and
misleads for weeks.
**Accuracy outranks completeness** — a short digest covering only the
narratives you actually read beats a comprehensive-looking one padded
with guesses. The rules below are mandatory, not aspirational; a real
digest run violated every one (see "Failure modes" at the end).

### Report only what the log actually says

Every accomplishment, decision, and theme must trace to specific events
in the log — not to memory, not to what a narrative "probably" said. If
you are unsure whether something happened, re-read the events; the record
is right there. Do not invent narrative IDs, summaries, quotes, or
events, and do not attribute work to a narrative whose events you have
not read. Cite the narratives you draw on as `nid:seq` so every claim is
checkable against the record.

### Don't editorialize

Report what the events say without coloring it. This is the same
discipline the /wiki protocol calls *Voice and register* — a neutral,
descriptive account — applied to the digest:

- **Attribute positions; don't assert them.** A decision, preference,
  conjecture, or claim is reported as someone's — "the operator
  directed…", "claude-abc proposed…", "is described as…" — not stated as
  settled fact. Only things that demonstrably happened (a PR merged, a
  test added) are stated flat.
- **Cut editorializing phrases.** Don't inflate a routine fix into a
  milestone, dramatize a setback, or reach for adjectives ("major,"
  "critical," "elegant," "bold") the record hasn't earned. State a
  substantive claim plainly and attribute it; drop decoration.
- **Don't sharpen or supply motive.** Don't turn a vague status into a
  definite outcome or invent a "why" the events don't give. Where the
  record is ambiguous, say so rather than resolving it for them.

By default, then, the digest reads as wiki-style reference: neutral,
descriptive, attributed. The `[guidance]` is the one thing that loosens
this — when it asks for more than a neutral account (prioritization,
risk assessment, cross-narrative connections, recommendations, what to
do next), provide that judgment, but keep it grounded in the events and
clearly marked as your interpretation rather than woven into the
description as fact.

### gh/git are corroboration, not the substance

The digest reports what narratives did, drawn from their events — it is
not a catalog of PRs and commits. A PR number or commit hash belongs in
a digest only when a narrative's events reference it, and even then the
claim "this narrative shipped that PR" comes from the events, never from
guessing what a number maps to. If you cite a repo fact, copy the
identifier from real `gh`/`git` output obtained this run; never compose
one to look precise.

### Report gaps, don't fill them

You will not always read every narrative in the window — there may be too
many, or a search may return nothing. That is fine; an incomplete digest
is honest, a padded one is not. Name what you did not cover ("12
narratives not sampled") and exclude it from your claims rather than
guessing at its contents. Coverage you did not read is reported as
missing, never synthesized.

### Verify before you narrate

Before posting, pass over your draft once: every narrative you name,
every event you quote, every outcome you assert — can you point to the
event you read it from? Cut, flag as unverified, or re-check anything
you cannot trace. "Fairly sure" without a source is the signal to
re-fetch or omit — never to assert.

### Failure modes this guards against

Do not repeat the run that prompted these rules:

- Inventing narrative IDs, summaries, or events that are not in the log.
- Summarizing narratives whose events you never actually read.
- Reporting what a PR or commit "was about" from a guessed number
  instead of from a narrative's events or real `gh`/`git` output.
- Quietly dropping coverage you skipped instead of naming the gap.
- Dressing any of the above in confident, specific-sounding prose.

## Determining the time window

Before generating the digest, determine the correct time window:

1. **Find the last digest** — prefer `narrative_info` over semantic
   search. Every digest sets its `summary` to `"Digest: {start} to
   {end}"` (see Output below), so the reliable lookup is
   `narrative_info` in browse mode with `search: "Digest"`,
   `archived: true`, `limit: 0` — it matches that summary column
   directly and returns results newest-first. Use the most recent
   hit's end date as your window start.
   **Do not rely on `narrative_search "Digest generated"` for this.**
   Semantic search ranks *commentary about* digests above the actual
   digest narrations and routinely surfaces stale, older digests while
   missing more recent ones — a real run anchored to a digest two
   months out of date this way. `narrative_search` is for themes
   (step 3 of Gathering), not for locating the window boundary.
2. **Fallback**: if no previous digest is found, default to `7d`
   (one week).
3. **Override**: if the `/digest` signal includes guidance specifying a
   time range or other instructions, follow them. Examples:
   - `/digest 7d` — last 7 days
   - `/digest since monday` — since the most recent Monday
   - `/digest 2026-03-01 to 2026-03-15` — explicit date range
   - `/digest whole week ignoring previous /digest` — use 7d window,
     skip the "find last digest" step

   Freeform natural language is expected. Interpret intent generously.

The end of the window is always **now**.

## Gathering activity

**Narrate your progress as you go.** The data gathering phase can take
several minutes. Keep the operator informed by narrating status updates
as you work — e.g., "Found 33 narratives in the window, sampling the
top 10 by event count..." or "Reading events from the absorb sessions..."
This lets the operator follow along and redirect if needed.

Use the tools available to you to collect raw material:

1. **`narrative_info`** — call with `since` set to the time window
   (e.g., `"30d"`) and `limit: 0` to get all narratives active in
   the period. Include `archived: true` to capture completed work.
   Narrate what you found (count, date range, notable summaries).
2. **Event sampling** — for each narrative returned, use `listen` with
   `wait: false` and `tail: 20` to fetch the most recent events.
   Focus on `human_signal` events (operator decisions) and `narration`
   events with substantive content. Skip routine LIVE loop chatter.
3. **`narrative_search`** — use targeted queries to find cross-cutting
   themes (e.g., search for recurring topics, error patterns, or
   decision points).

When the number of narratives is large, prioritize:
- Narratives with the most events (highest activity)
- Narratives with `human_signal` events (operator engagement)
- Narratives whose summaries suggest completed work

### Parallelism

**Parallelize aggressively.** Issue multiple `listen` (with `wait:
false`) and `narrative_search` calls in a single tool-use turn. Batch
5–10 narrative event reads per turn rather than fetching one at a time
— this dramatically reduces the data gathering phase. Use `tail: 20`
(or similar) to keep each response manageable and avoid flooding your
context with long histories.

Narrate a progress update between each batch so the operator sees
movement — e.g., "Sampled 10/33 narratives so far, highlights: ..."

## Digest structure

Organize the digest into these sections, omitting any that have no
content:

### Activity overview
- Total narratives active in the period
- Breakdown by agent type and status
- Busiest folds (directories where work happened)

### Accomplishments
- Narratives that reached completion (ended status or "done" summaries)
- Key deliverables, features, or fixes — summarize what was achieved
- Link back to narrative IDs for reference

### Decisions & directions
- Operator signals that set direction or changed course
- Important choices made and their rationale (when visible)

### Open threads
- Active narratives that may need attention
- Unanswered agent questions or stalled work
- "Gone quiet" narratives — previously active but no recent events

### Themes
- Recurring topics across narratives
- Patterns in the kind of work being done
- Cross-narrative connections worth noting

### Absorbed context
- If any absorbed (imported) narratives were active or referenced in the
  period, note relevant connections to current work

## Output

Narrate the digest in full using `narrate`. Use markdown formatting for
readability, and write the digest body in the /wiki protocol's *Voice
and register* — neutral, descriptive, attributed (see "Don't
editorialize" above). Begin the narration with a header line:

```
**Digest generated** — {start_date} to {end_date} ({N} narratives)
```

This header line marks the narration as a digest. The primary locator
for future `/digest` invocations, though, is the `summary` metadata
below — set it on the same `narrate` call so the digest is findable via
`narrative_info` (browse mode, `search: "Digest"`), which is the
reliable way to determine the next window (see "Determining the time
window"). Keep the `Digest: {start} to {end}` summary format exact so
that search matches it.

Set your narrative metadata:

```json
{
  "meta": {
    "summary": "Digest: {start_date} to {end_date}"
  }
}
```

## After generating

After narrating the digest, return to the LIVE loop — `listen` for
further signals. The operator may ask follow-up questions about specific
narratives or request a different time window.
