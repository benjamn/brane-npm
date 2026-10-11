# Protocol: review

`/review [what]` reads a proposed change — almost always an open pull
request — and tells the operator, in your own narrative, whether it is
safe and good to merge and exactly what would make it better. A review
makes you an advisor to the operator and a collaborator with the
authoring agent; it is **not** a merge gate that acts on its own.

This is a verb you can run, not a role you hold — any agent can be
asked to `/review` a change. A `role: "reviewer"` (or any role string)
carries no special meaning here: nothing auto-binds this protocol by
role. `/review` is invoked by name, like `/digest`.

**Prerequisite:** this protocol uses the LIVE loop's tools and
vocabulary (`listen`, `narrate`, `whoami`, `narrative_search`, etc.).
If you have not already read `protocols/LIVE_loop.md`, read it first;
then return here.

## The cardinal rule

**Review into your narrative first. Never post to GitHub until the
operator tells you to.** Every past session followed the same shape:
you narrate your findings, the operator reads them (and often
discusses or redirects), and only then does the operator say "Post
your relevant feedback in the PR" / "Post all worthwhile feedback." A
review is a conversation with the operator that *may* become a GitHub
comment — not the other way around. Posting unprompted is a protocol
violation.

## Scope

Run this protocol whenever you are asked to review a change. The
trigger is usually terse — `/review #299`, "Review the latest open PR",
"Thoroughly review the latest open PR and propose review comment(s)".
Treat any such signal — whether it names the `/review` verb explicitly
or just asks you to review something — as an invocation of this
protocol.

## Invocation & guidance

The triggering signal is **`/review [what]`** — `[what]` is free text
the operator attaches to the request. Interpret intent generously (the
same spirit as `/digest [guidance]`); `[what]` typically carries one or
more of:

- **Target** — a PR number ("Review PR #300"), "the latest open PR",
  or a description ("the `brane fly` PR"). Resolve it in Phase 1.
- **Depth / focus** — "thoroughly", or a dimension to emphasize
  ("focus on test coverage", "security pass", "just the new commit").
  A focus *narrows* what you lead with; it does not license skipping
  the grounding in Phase 2.
- **Deliverable** — what to do with the result: "propose review
  comment(s)", "just tell me", "post if it's clean". This never
  overrides the cardinal rule — you still narrate first and post only
  on the operator's go-ahead (the deliverable shapes *what* you'd
  post, not *whether* to post unprompted).

**Bare invocation** (no guidance, e.g. "Review the latest open PR")
defaults to: the latest open PR, the full protocol, narrate-first.

## Relationship to the built-in `/review`

The harness ships its own built-in `/review` command — a generic
"expert code reviewer" that pulls the PR (`gh pr view` / `gh pr diff`),
analyzes it (overview, code quality, suggestions, risks), and returns a
sectioned review focused on correctness, project conventions,
performance, test coverage, and security. Those focus areas are a
**subset** of this protocol's review dimensions.

/prelude's "prevent default" rule would normally have this
brane protocol *fully suppress* a same-named built-in. **`/review` is a
deliberate exception: don't entirely prevent-default — delegate to the
built-in command's definition.** Treat its definition as the *baseline
shape* of a review (pull the PR, read the diff, weigh those focus
areas, present in clear sections); this protocol is everything brane
layers on top of that floor.

**Delegate to its definition; do not literally invoke it.** Do *not*
fire the native `/review` slash command. That hands control to a
one-shot reviewer that prints to the terminal — it would break you out
of the LIVE loop and past the cardinal rule (it has no notion of
narrating first or waiting for the operator before posting). Instead,
*fold its definition in*: the built-in tells you the baseline; the rest
of this document tells you how brane wants it done.

On top of that baseline, this protocol:

- **Extends** the built-in's focus areas into the fuller
  review-dimensions section below — test coverage *first*, the
  robustness/safety lenses (blast radius, silent-wrong-data,
  event-loop/concurrency), and the severity taxonomy.
- **Grounds** the analysis — read the files *around* the diff, cite
  `file:line`, run `tsc`/tests, cross-check the producing narrative,
  and self-correct before anything is posted.
- **Overrides its output channel** — the built-in returns a review to
  the terminal; the cardinal rule says narrate into your own narrative
  first and post to GitHub only on the operator's go-ahead. Where the
  two conflict, **this protocol wins.**

## Phase 1 — Establish the target

1. **Identify the PR.** If given a number, use it. If told "the latest
   open PR", resolve it with `gh pr list --state open` /
   `gh pr view <n>`. If the operator says it "just opened", re-check —
   the latest open PR may not be the one you first found (a real past
   miss: a reviewer reviewed a stale PR and was corrected with "Sorry,
   no, the PR just opened").
2. **State your bearings.** A one-line "Reviewing PR #N on branch X in
   `<fold_dir>`" (the fold `whoami` reports) up front lets the operator
   catch a wrong target immediately.
3. **Read the PR as a whole**, not just the head commit: title, body,
   linked issues, the test plan, and the **commit list** — you will
   re-grade against specific SHAs later.

## Phase 2 — Read and verify (ground everything)

Grounding is the single trait the operator rewards most, and
ungrounded guessing is the one they correct hardest ("Stop with the
weak theories. Your guessing is useless without grounding"). Before
you assert anything:

- **Read the actual changed files and the code around them**, not just
  the unified diff. Trace the real control flow; open the file at the
  line you intend to cite.
- **Cite `file:line` for every finding.** "There's a bug somewhere in
  the scroll logic" is not a finding; "`app/list.tsx:1416` removes
  the scroll-position guard" is.
- **Run and report the build/tests** when you can — the project's
  typecheck/build, its test suite, and the PR's CI status — rather than assuming. State what
  you ran and what passed.
- **Cross-check the producing narrative.** Before flagging a design
  choice, `/memory` / `narrative_search` for the narrative that wrote
  the code and check whether your point was already considered. Sort
  your findings into "already addressed by the implementation" vs.
  "still valid", and only carry the still-valid ones forward. The
  operator asks this explicitly: "are any of your points addressed by
  the narrative that produced this code?"
- **Confirm deliberate-looking choices instead of asserting a bug.**
  When something looks wrong but might be intentional, raise it as a
  question rather than a defect. Some come back "Deliberate", and a
  confident false positive costs you credibility.
- **Self-correct before you post, not after.** If a second read shows
  your finding was wrong, retract it in your narrative immediately. A
  past reviewer claimed a shared-state bug, re-read, and corrected to
  "the `copied` state is per-card, no bug" — *before* anything reached
  GitHub. That is the model: a wrong claim must never land on the PR.
- **When the operator hands you a failure hypothesis, disprove it
  against real data** and report the negative result (e.g. "checked the
  schema — there is no `re` column; searched the `extra` JSON, zero
  matches").

## What to look for — review dimensions

Grounding (Phase 2) is *how* to be sure; this is *what* to weigh. A
good review is not a diff proofread — it asks "what could go wrong that
the change, and its tests, don't account for?" Work these dimensions in
roughly this priority order.

### Test coverage (look here first)

Green CI means the existing tests pass — **not** that the change is
adequately covered. For every PR, ask:

- **Is every new path tested?** Each new function, branch,
  early-return, and **error path** should have a test that exercises
  it. An untested `catch` / `return null` / degradation branch is the
  most common gap.
- **Are the boundaries and failure modes covered, not just the happy
  path?** Null/empty/missing input; malformed or corrupt data; the
  dependency-absent case; the "runs twice" (idempotency) case; the
  "same input twice" collision case. The interesting bugs live here.
- **Degradation paths deserve explicit tests.** If the design promises
  "missing X → empty/no-op, never a wrong result", there should be a
  test proving the no-op — that promise is exactly what regresses
  silently.
- **A bug fix ships with a regression test** that fails before the fix
  and passes after. A fix without one is a 🟡 at minimum.
- **Name the specific missing case, not "add more tests."** "No test
  covers the pid-reuse path where a stale registry entry has a
  mismatched cwd" is actionable; "needs more coverage" is noise.
- **Praise testability moves.** Pure logic extracted from IO so it can
  be unit-tested with injected fakes (e.g. a process-tree walk split
  out from the `ps`/filesystem calls) is a ✅ — call it out so the
  pattern spreads.

### Robustness & safety

The "what could go wrong" lens. Trace each new code path for:

- **Graceful degradation vs. wrong-or-crash.** When a dependency is
  missing, slow, or throws, does the code produce an empty/no-op result
  — or a *confidently wrong* one, or an unhandled crash? Empty is fine;
  silently wrong is the worst outcome (see *silent-wrong-data* below).
- **Blast radius of a throw.** When something can throw, ask what dies:
  one row, or the whole pass / the daemon? A `json_extract` over a
  column that *might* hold malformed JSON aborts the entire query — a
  one-row problem with a whole-pass blast radius. Prefer failures that
  skip the bad unit over failures that take down the batch.
- **Event-loop & concurrency.** Synchronous/blocking IO on a
  single-threaded server's main loop (whatever else it serves stalls
  with it); new writers to a shared SQLite DB (WAL is one-writer — watch lock
  contention, set `busy_timeout`); first-load / lazy-init races.
- **Idempotency & re-entrancy.** Safe to run twice? Migrations additive
  and re-runnable? Does a "self-healing" scan re-process the same
  unresolvable rows every pass forever (unbounded work that never
  converges)?
- **Resource bounds.** Unbounded queries, loops, or caches; O(n²)
  re-reads (e.g. re-parsing a whole file per row); no per-pass cap on
  expensive work; no LRU/size bound. Flag silent truncation too — a
  hidden top-N that reads as "covered everything."
- **Silent-wrong-data.** PID reuse, stale caches, content-match
  collisions, ambiguous keys — anything that yields a plausible but
  wrong value instead of an error. Higher-severity than crashes,
  because they don't announce themselves.
- **Data integrity.** Additive over destructive; never delete or
  overwrite; correct attribution of derived data.
- **Security.** Input validation, path traversal, auth on new
  endpoints, and secrets/ids leaking into URLs, logs, or error text.

### Code quality & maintainability

- **Comments explain WHY, not what** — and load-bearing guards say
  *why* they're load-bearing, so a future reader doesn't "simplify"
  them away.
- **Named constants over magic numbers**; **canonical-usage
  consistency** (match the project's own established API/flag forms);
  **no dead code / unused imports**.
- **Reuse over duplication**, and genuine simplification opportunities
  — but **pragmatism for a fast-moving solo project**: don't demand
  abstraction, splitting, or generality the project doesn't need.
  "Could be split, but bundling is pragmatic here" is a valid verdict.

### Severity

Every finding carries a marker, and the blocking call is always
explicit — even when the answer is "none of these block — ship it."

| Marker | Meaning | Blocks merge? |
|--------|---------|---------------|
| 🔴 **Broken** | Wrong / non-functional / will-break on a real path; a bug fix with no regression test; a throw whose blast radius is the whole pass or the daemon | Yes |
| 🟡 **Should-fix** | A real issue safe to land then follow up — an untested risky path, a robustness gap reachable only in uncommon conditions, unbounded-but-currently-small resource use | No (say so) |
| 🟢 **Minor / nit** | Naming, dead code, comment, micro-cleanup; coverage of a path that genuinely can't fail | No |
| ✅ **Strength** | A good decision worth keeping | — |

Prefer **general principles over spot-gotchas** — a rule the author
can reapply beats a one-off nitpick — and hold our own code to a high
bar regardless of external norms ("I don't care if other people's APIs
suck; ours doesn't have to").

## Phase 3 — Structure the review

House style, consistent across past reviews:

- **Scope line first** — diff size and shape: `+361 / -76 across 4
  files, 6 commits. Nicely focused.` Scope the review to the new work
  if earlier commits already landed.
- **What it does** — a neutral one-paragraph summary of the change.
- **Strengths** — specific, genuine praise (e.g. "comments explain WHY,
  not what"; "this guard is load-bearing, not redundant"). Name good
  decisions so they survive.
- **Findings** — a list, each with a severity marker (above), a bold
  one-line title, a `file:line` locator, the consequence, and
  **remediation options** (not just the problem). Give the author a
  path, e.g. "Options: query `tailscale status --json`, or accept a
  `--tailnet` flag."
- **Verdict** — an explicit recommendation **and** an explicit blocking
  call: what (if anything) blocks merge vs. what is a follow-up.
  Isolate "the only concrete bug" from edge cases.

## Phase 4 — Deliver

1. **Narrate the full review to the operator first** (Phase 3 format).
   Set `meta.summary` to e.g. "Reviewed PR #N — <verdict>".
2. **Wait for the operator's call.** They will read it and say what to
   post — sometimes the whole review, sometimes a single finding
   ("Post a comment about preserving brane_ids"). **Filter to what they
   call "worthwhile" / "relevant"**; drop the strengths recap and any
   superseded points when posting unless asked to keep them.
3. **Post as a `COMMENTED` review — never APPROVE or
   REQUEST_CHANGES.** The operator authors these PRs, and GitHub
   forbids self-approval; a COMMENTED review is the correct vehicle
   ("Couldn't approve — it's your own PR. Posted as a regular comment
   instead."). Approval/merge is the operator's decision, not yours.
4. **Return a tappable permalink** to the posted review/comment
   (`…/pull/N#pullrequestreview-…` or `#issuecomment-…`).
5. **The PR comment is also your message to the authoring agent** —
   "Explain all this in the PR for the other agent." Write it so the
   author can act on it directly.
6. **Foreign-narrate approval to the author's narrative when asked.**
   The operator sometimes wants the approval delivered into the
   author's brane narrative as well ("Foreign narrate your approval");
   identify the author (named in the spawn signal, or discoverable via
   the producing narrative) and `narrate` to their `nid`. Do this on
   request, not by default.

## Phase 5 — Re-review loop

Review is iterative. After the author pushes fixes the operator will
say "Verify the follow-up commit", "Review again?", "Look good now?":

- **Re-grade each prior finding against the specific commit SHA** that
  claims to fix it (`Commit 451e73a addresses 🔴 #1 → ✅`), confirming
  the fix actually does what was suggested and is phrased canonically.
- **When time has passed, re-read the PR holistically**, not just the
  newest diff — "review latest commits in the context of the PR as a
  whole."
- **Be ready to justify your evidence base.** The operator will probe
  ("you just reviewed the protocol, so the changes should be apparent?"
  / "did you see the merged changes — I just restarted you").

### Resuming a review after revive or compaction

You may be **revived or compacted mid-review** and asked to "continue"
— re-review, verify a follow-up, or answer a question about a PR you
already looked at. This is a trap: your context may hold a *stale*
snapshot of the code. A past reviewer had read the pre-PR version of a
protocol, was restarted, and confidently spoke as if it had seen the
merged changes — the operator caught it ("did you see the merged
changes — I just restarted you"). Guard against it:

- **Assume your recollection is stale.** Since you last read it, the
  branch may have gained commits, been force-pushed, rebased, or had
  `main` merged in. The code you "remember" reviewing is not
  necessarily the current code.
- **Re-establish state before saying anything.** Follow the LIVE_loop
  compaction-recovery steps — `whoami`, then `listen` with `tail` /
  `after: 0` to re-read **your own prior narrations**: what you already
  reviewed, what findings and verdict you gave, what the operator
  decided. Then `gh pr view <n>` / `git log` to see which commits exist
  **now** versus when you last looked.
- **Re-read the current files; never answer a "did you see X?" from
  memory.** Open the diff and the changed files again, then diff your
  prior findings against the present state: addressed-by-SHA,
  still-open, or newly-introduced.
- **Don't claim freshness you don't have.** If you cannot confirm you
  read the current version, say so and re-read — a wrong "yes, I saw
  it" is exactly the failure this guard exists to prevent.
- **Update `meta.summary`** to reflect that you're resuming a specific
  PR's review. (`agent_session_id` is owned by the daemon and set at
  spawn/revive — `meta.session_id` is no longer read, so don't rely on
  re-stamping it.)

## Adjacent operations

A review session often shades into light git surgery the operator
directs — cherry-picking one safe, unrelated commit to `main`,
rebasing after merge, etc. Do these when asked and narrate exactly what
landed where. Never act on the repository beyond what the operator
requested.

## Golden Rule

Never delete anything — files, branches, records, or comments — to
"clean up" a review. Surface concerns; let the operator (or the
author) act on them. If you believe something must be removed, say so
and explain how the operator could do it. See /prelude.
