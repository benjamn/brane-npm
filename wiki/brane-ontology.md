# Brane Ontology

The page collects what brane's substrate commits to and refuses,
treated as a worked example of the discipline described in
[premature-ontologies](shared/premature-ontologies.md). The argument made
there is general — *taxonomy promoted to substrate* recurs as a
failure mode across decades of information-system design — and
brane is one project whose design follows from a particular stance
on it. The two pages were originally one; they were separated so the
critique could stand on its own and the brane-specific material
could be expanded without crowding it out.

What follows describes brane's positive bet, the record-keeping
ontology the substrate does carry, the inductive biases that fall
out of it, the distillation model brane uses in place of pipelines,
the concrete refusals it makes at the content layer, the capabilities
it forgoes in exchange, and the wiki itself as an in-tree instance
of the same discipline.

## Brane's bet

Brane's positive thesis, in the operator's reformulation
[claude-c891087f:19]:

> *"Collect sediment, then make the sediment causally active exactly
> when it's useful, but reliably when useful."*

The reformulation has three parts:

1. **The substrate accumulates raw, free-form, attributed records of
   utterances** — the sediment. No typology of work content; no
   pre-extracted facts; no consolidation step. Time order, authorship,
   reference, persistence, retrievability — that is the whole
   substrate ([sedimentary-superintelligence](shared/sedimentary-superintelligence.md),
   [append-only event log](shared/append-only-event-log.md)).
2. **Sediment becomes causally active through retrieval at the moment
   of integration** — runtime relevance, not declared importance.
   What is *about* the current question is decided by the live reader
   integrating the recorded words with the current occasion, not by a
   schema that pre-categorized at write time.
3. **The runtime gets more reliable over time** without the operator
   authoring a content typology. Strength signals from actual past
   acts of integration — the `re` graph, attention, retrieval-
   endorsement — accumulate and bias retrieval ranking. Use shapes the
   gradient; new readers ride the gradient; the substrate gets smarter
   without anyone making meaning claims.

The discipline this implies is the same one
[premature-ontologies](shared/premature-ontologies.md) describes: substrate
over vocabulary; integrationist over language-myth; on-the-fly
volitional distillation by named authors over batch consolidation by
a pipeline; strength accruing from use over strength declared by
category. The negative critiques add up to a single positive proposal:
*a system that gets better at finding what is relevant, without ever
pretending to know what utterances mean*.

The operator's framing of brane's positioning vis-à-vis the broader
"agentic AI" pitch [claude-14616e34:18] places the project in a
different family from systems aiming to remove the user. Brane is
characterized as belonging with *amplification* tools — writing
systems, double-entry bookkeeping, version control, source-code
repositories — substrates that compound human consistency over time
without trying to eliminate the human at the choice-point. The
"agentic AI" pitch wants to remove the user; brane is described as
wanting to make the user's commitments stick. Different category,
different ethics, different failure modes when scaled.

## Brane is not ontologically neutral

Brane refuses *content typology*: no schema for kinds of work, no
slots for goals or hypotheses, no required `act_type` on narrations
— a specific application of the general critique in
[premature-ontologies](shared/premature-ontologies.md). That refusal is
real. It is not, however, the whole story. Brane commits to a
*record-keeping ontology* — a typology of how durable communication
is structured — and the substrate's design follows from those
commitments.

The five primitives proposed in the archive [claude-c891087f:14]
make the record-keeping ontology explicit:

1. **Time order.** Events have a monotonic per-narrative `seq`. Before
   and after are unambiguous.
2. **Authorship.** `source` is server-stamped at append time.
   Unspoofable.
3. **Reference.** Events can point at prior events (`re` arrays,
   same or cross-narrative). Threading without nesting.
4. **Persistence.** Append-only — no DELETE, and an event's
   `content`, `seq`, `source`, and `time` are never mutated after
   append. The record is unrewritable by its author.
5. **Retrievability.** Semantic + keyword search over raw narration
   text. Everything that lands is findable.

These five are not neutral observations about communication. They are
claims about what structure communication records *have*, asserted as
the substrate's invariants. Plenty of communication isn't shaped this
way — gesture, glance, interruption, the unrecoverable phone call —
and brane is silent on all of it. The Harris-flavored note in the
archive anticipates exactly this concern [claude-c891087f:35]:

> *"Yes, brane *is* archive-shaped. It commits to a particular form of
> communication — one where utterances persist and can be
> re-encountered. Plenty of human communication isn't that (gesture,
> glance, interruption, the unrecoverable phone call). brane isn't a
> theory of communication; it's a substrate optimized for the kind of
> integrated activity that benefits from durable shared records.
> Naming that limit honestly — rather than treating archive-shaped
> communication as universal — is the integrationist correction."*

The honest framing is therefore: brane is *less ontologically
committed than typology systems, not free of ontology*. The
discipline described in [premature-ontologies](shared/premature-ontologies.md)
applies at the *content* layer. At the *record-keeping* layer, brane
is opinionated. Treating the record-keeping commitments as universal
would be the same language-myth move that page warns against, just
one floor down.

## Brane's inductive biases, and underexploitation

The substrate's record-keeping ontology produces a set of *inductive
biases* — the term borrowed from machine learning, where it names
the prior assumptions a learning algorithm uses to generalize beyond
its training data ([Wikipedia, "Inductive bias"](https://en.wikipedia.org/wiki/Inductive_bias)).
The strict ML usage refers to a learner; brane is a substrate, not
a learner. The looser usage — increasingly common in cognitive
science and systems design — labels any structural prior that shapes
which behaviors emerge as the system is used. In that sense brane's
defaults are inductive biases: they shape what kinds of generalization
the integrated system (LLM + agents + operator) ends up doing as it
accumulates use.

Brane's biases span three subtypes that the ML literature itself
distinguishes:

- **Hard / architectural** biases are hard-coded constraints; they
  cannot be violated. Append-only is enforced in code — nothing
  deletes events, and the only UPDATE (the memory indexer's `meta`
  backfill) annotates without rewriting; `source` is server-stamped
  from authenticated identity on every agent-written event;
  per-narrative `seq` is monotonic. The
  closest ML analogue is architectural inductive bias such as a
  CNN's translation equivariance — a property of the model's
  topology, not a learned weight.
- **Soft / ranking-prior** biases are defaults that shape scoring
  without forbidding alternatives. None of these are yet active in
  brane; the proposed strength signals (re-graph in-degree, attention
  logging, retrieval-endorsement) would live here.
- **Practice-level / behavioral** biases are defaults that shape what
  authors do, without the substrate enforcing them. Citation via `re`,
  narration over scrollback, operator-owned ontology — these are
  closer to *choice architecture* in the Thaler/Sunstein sense than
  to ML inductive biases, but they belong in the same inventory
  because they shape the inductive landscape of the integrated
  system.

Some of these biases are fully expressed in the current implementation;
others exist as architectural intent without the code or practice
that would activate them (status column current as of August 2026).
Naming both honestly is part of the same discipline that named the
record-keeping ontology above.

| Bias brane encourages | Type | Mechanism | Status |
|---|---|---|---|
| Append-only / no rewrite | Hard | No DELETE; the sole UPDATE (memory indexer) only annotates `meta` | Exploited |
| Server-stamped attribution | Hard | `source` written daemon-side from authenticated identity | Exploited |
| Time order | Hard | Monotonic per-narrative `seq` | Exploited |
| Role-relational typing | Hard | Event types distinguish *who* (or that nobody spoke), never *what* | Exploited |
| Verbal articulation (must narrate to enter substrate) | Hard | `narrate` is the only durable write path | Exploited |
| Sediment over pipeline | Architectural absence | No consolidation step; raw is sovereign | Exploited |
| Citation / provenance | Practice | `re` arrays, `nid:seq` linkification | Partial — schema present, narration practice inconsistent |
| Operator centrality | Practice | Wiki protocol forbids agent-minted concepts | Exploited in wiki; weaker in narration practice |
| Search-driven retrieval | Soft | Embeddings + FTS5 hybrid | Partial — ranking ignores `re` strength, attention, recency |
| Runtime-is-truth | Soft / Practice | Retrieval at integration time | Partial — exploited in search, not yet at prefix layer |
| Cached prefix for binding constraints | Soft | (No mechanism) | **Not exploited** — `meta.commitment` proposal at [claude-c891087f:41] is unbuilt |
| Wiki as causally active in agent runtime | Soft | `search_wiki` / `read_wiki` / `list_wiki` MCP tools over a hybrid wiki index (`src/memory/wiki.ts`) | **Partial** — retrievable on demand since the wiki index landed, but pages still aren't auto-loaded into agent context. The operator's *"the wiki could be much more causally active"* [claude-c891087f:25] still applies to the auto-injection half |
| Strength signals from use | Soft | (No computation) | **Not exploited** — `re` graph in-degree, attention logging, retrieval-endorsement all proposed at [claude-14616e34:20]; none built |
| Cue-rich retrieval | Soft | (No mechanism) | **Not exploited** — within-session re-cueing discussed at [claude-14616e34:28]; unbuilt |

The pattern in the unexploited biases is consistent: the hard
inductive biases are mostly in place (the substrate has the shape it
needs); the soft / ranking-prior biases are mostly *not* yet active
(the runtime layer that would activate them is where the work lies);
the practice-level biases are partially observed but not enforceable.
The cached-prefix commitments layer would make operator decisions
stick at emission time rather than depending on retrieval; the
strength-signals layer would make search ranking absorb patterns of
past integration without anyone declaring importance. Both compound
directly with the brane bet stated above; neither is yet implemented.

The honest summary: brane's design has more inductive biases than it
currently *uses*. Several of the disciplines this page credits to
brane are not yet *enforced* by code — they are practices made easier
by the substrate, not properties guaranteed by it. The compounding the
bet promises is conditional on the runtime layer eventually matching
the substrate's intent.

## On-the-fly volitional distillation

A reframing the operator introduced as sharper than substrate-vs-
vocabulary [claude-c891087f:28]: brane *also* performs distillation —
the substrate is not raw all the way down — but the distillation
happens on the fly, by accountable named authors, rather than as a
batch consolidation step run by a pipeline.

The contrast described in the archive [claude-c891087f:29]:

- **Most "agent memory" projects do batch distillation.** A pipeline
  runs over the corpus, consolidates raw observations into facts /
  patterns / contradictions / hypotheses, and the typology is the
  consolidation target. The author of any individual distilled claim
  is *the pipeline* — no specific actor with a name attached, no
  accountability for *the system thinks X*.
- **Brane does on-the-fly volitional distillation.** Every `narrate`
  call is a distillation of scrollback + immediate context into a
  record an accountable author signs (`source` is server-stamped).
  Every wiki page is a distillation of narratives across time, again
  with an accountable author and a moment of explicit choice. There
  is no batch step, no consolidation pipeline, no machine-decided
  promotion of *this is now a fact*.

The framing positions narrations as the *moment-by-moment* distillation
layer and the wiki as the *standing* distillation layer — both
volitional, both authored by named actors, both produced in the
moment rather than extracted later. The raw event log is sovereign,
but the distillations are not extracted from it after the fact;
they are written *as* the work happens, by the only actor in the
loop with the judgment to decide what is worth distilling now
[claude-c891087f:29].

## How brane is shaped to refuse the move

Brane's substrate-level commitments do not require structured typing of
content [claude-c891087f:14, claude-14616e34:40]:

- **Free-form text.** The `say` field on every narration is markdown
  text; the substrate makes no claim about what kind of utterance it
  is.
- **Role-stamped, not content-typed.** The
  [append-only event log](shared/append-only-event-log.md) carries six
  types: the conversational `narration`, `human_signal`, and
  `agent_signal` distinguish *who said it* (the agent, the operator,
  a foreign agent), while the system events `started`, `restarted`,
  and `binding_rejected` record lifecycle facts nobody "said" —
  rendered everywhere as recessive system lines, not speech. None of
  the six makes any claim about *what kind of thing* was said. `source` is
  server-stamped from the authenticated identity on agent-written
  events, not a client-supplied content category.
- **Opt-in `meta`.** The `meta` JSON object on each event is opt-in and
  free-form in shape. Existing keys (`summary`, `session_id`,
  `session`, `model`) hold attribution-like or session-management
  data, not work typology.
- **No work-content categories anywhere in the schema.** The `events`
  table has no `act_type` column, no `goal_id`, no `decision_kind`.
- **Search over raw, not extraction into typed records.** The
  memory subsystem (`src/memory/`) provides hybrid embedding + FTS5
  retrieval against the raw narration text. There is no consolidation
  pipeline that promotes utterances into typed facts.
- **Operator authors the ontology.** The
  /wiki protocol explicitly forbids the agent
  from inventing concepts: *"the operator is the source of the concept
  set; the agent fills, refreshes, and cross-links the pages those
  concepts get"*. Filename spelling is implementation detail; the
  concept itself must come from the operator. This is the same
  principle ([why-wikis-work](shared/why-wikis-work.md)) applied to the
  layer where typology decisions are most tempting.

### Strength signals as use-aggregation

Where brane needs to surface relative weight across the corpus — for
retrieval ranking, for finding most-cited narrations, for prioritizing
attention — the archive proposes that the signal accrue *from acts of
integration*, not from declared importance [claude-14616e34:20]:

- **The `re` graph.** Back-references already exist in the substrate.
  Weighted in-degree (recency-discounted, transitively traversable)
  yields a strength score per event without any new schema.
- **Operator attention.** UI events — opens, scrolls, signals — logged
  as low-priority `source: "ui"` events lift a graded engagement
  signal from ephemera to substrate.
- **Retrieval-as-endorsement.** Search hits subsequently cited via
  `re` are double evidence: the retriever ranked them high, the reader
  integrated them forward.

The pattern across these signals is that strength accrues from *acts
of integration*, not from declaration. No one says *this idea is
important*; readers return to certain narrations more than others,
and the substrate observes the pattern. The integrationist
characterization is that strength is a *record of past acts*, not a
property of the words [claude-14616e34:20].

A discipline proposed in the same narration: when surfaces present
these scores, the language should stay in the use-pattern register —
*returned to 47 times*, *cited in 12 narrations*, *last touched 3
days ago* — rather than slipping into property-of-idea phrasings —
*importance 0.87*, *high-strength*, *authoritative*. Internally
graded; externally framed as records of acts. The score may be
machine-generated; the surface vocabulary should refuse the
meaning-claim.

The framing proposed in the archive is that brane is *"the system the
Coordinator's critics would have built had they the substrate to build
on"* [claude-14616e34:40] — Searle's typology is a useful lens for
recognizing requests and promises in narrations *after the fact*, while
the substrate stays free-form so no utterance is ever coerced.

## What brane gives up

A discipline of refusal has costs. Brane explicitly forgoes capabilities
that ontology-rich systems offer:

- **Fast structured queries.** Typed-task systems can return
  unblocked work via a fast structured query against a task table
  with a `status` column [claude-c891087f:21]. Brane has no
  equivalent — "what's ready to pick up" is a search over free-form
  narrations, fuzzier and slower. The bet described in the archive
  is that retrieval keeps getting better, while a typology has to be
  right at commitment time; whether that bet survives at high
  workflow volumes is genuinely untested [claude-c891087f:22].
- **Atomic claim semantics.** "Agent X is now working on task Y"
  requires *task* to be a thing with a status that can be transitioned;
  typed-task systems provide atomic-claim semantics directly. Brane
  offers no multi-agent atomic operation analogous to it.
- **Auto-extracted facts.** When an operator wants to know what the
  system "thinks is true" about a topic, brane returns retrieved
  narrations rather than a synthesized fact. Synthesis happens in the
  operator's own reading, or in a wiki page they author. Other
  agent-memory designs invest in LLM-driven consolidation pipelines
  that promote observations into typed facts; brane forgoes that path
  entirely [claude-c891087f:5, claude-c891087f:7].
- **Agent-driven ontology evolution.** Most "agent memory" products
  let agents propose new entity types, relations, schemas. Brane's
  /wiki protocol explicitly forbids it — agents
  fill, refresh, and cross-link, but do not name. Ontology evolves
  only at operator-authorship rate.
- **Schema-checked emission.** Without typed events, there is no
  static check that says *"this narration is missing a required
  field"*. Discipline replaces enforcement.

These are real tradeoffs. The framing proposed in the archive is that
the cost is paid by the operator's discipline, while the benefits
compound across decades and across cognitive patterns the structured
systems can't anticipate [claude-c891087f:26]. Structured systems are
characterized as trading short-term ergonomics for long-term
flexibility; brane is described as making the inverse trade.

## The wiki as a working example

The directory this page lives in — `wiki/*.md` in the brane repo — is
itself an instance of the discipline. There is no schema for what a
page is, no page-type taxonomy, no status states. The directory is a
flat list of kebab-case markdown files with cross-links. Pages can be
added, deleted, or renamed; the operator owns those calls. The
"ontology" is just the set of files that currently exist plus the
links between them — and that ontology is allowed to evolve as
understanding does.

Each page in `wiki/` exists because the operator authorized its
creation through `/wiki seed <name>.md` (or equivalent imperative
guidance). The pages live in the same flat directory as
`sedimentary-superintelligence.md`, `why-tailscale.md`, and the rest;
their internal links point only at pages that already exist. The
disciplines described in [premature-ontologies](shared/premature-ontologies.md)
— operator owns the ontology, agents fill but do not invent,
free-form text, inline provenance — are the rules that produced this
directory.

The wiki protocol's prohibition on agent-invented pages (see
[why-wikis-work](shared/why-wikis-work.md)) is the same shape of move as the
substrate's refusal of work-content event types: the layer where
typology is tempting is exactly the layer where the operator must
remain the author. The wiki demonstrates that the discipline is
livable across time — these pages have grown into a navigable graph
without an LLM ever deciding what should exist.

## Related

- [premature-ontologies](shared/premature-ontologies.md) — the general
  critique this page applies. *Taxonomy promoted to substrate* as a
  recurring failure mode; the integrationist diagnosis; the
  Coordinator/LAP case as a tolerable historical instance; the
  discipline checks for evaluating proposed additions.
- [sedimentary-superintelligence](shared/sedimentary-superintelligence.md) —
  the system-level claim about what an ontology-free substrate
  becomes when accumulated across time. Brane's bet that retrieval
  over raw narrations beats extraction into typed records is the
  positive version of the negative critique.
- [sequestering-the-narrative](shared/sequestering-the-narrative.md) —
  carries the integrationist position about meaning being made each
  time the narrative is re-entered. The same position animates the
  refusal to type utterances at write time.
- [append-only event log](shared/append-only-event-log.md) — the substrate
  shape that holds the role-stamped, free-form, opt-in `meta`
  properties described above.
- /LIVE_loop — the protocol that runs over the
  ontology-free substrate. Narrations are free-form text; the loop's
  contract is about cursor semantics and authorship, not about
  content typing.
- [owning-your-narratives](shared/owning-your-narratives.md) — the
  agent-side practice that takes responsibility for findability and
  reader-orientation without committing to a typology.
- [why-wikis-work](shared/why-wikis-work.md) — the wiki-level analogue of
  the substrate's discipline; the four practices (humans own
  ontology, inline provenance, read-first, backlink refresh) are
  scope-narrowing moves of the same shape.

---

*Candidate future pages this one would link to (ontology call is yours):*
*`commitments.md`, `raw-is-sovereign.md`, `relevance-prediction-stack.md`,*
*`volitional-distillation.md`.*
