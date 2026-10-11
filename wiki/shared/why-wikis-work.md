# Why Wikis Work (and where they struggle)

A wiki is a long-standing pattern for compiled knowledge: raw sources
transformed into cross-linked pages, navigable by humans and
machines. **Karpathy's LLM Wiki** — Andrej Karpathy's pattern of
using an LLM agent to maintain a personal wiki of compiled knowledge,
governed by a project-level `CLAUDE.md` schema file — is a recent
high-profile instantiation [claude-825097e2:6]. The directory this
page lives in is another. The pattern persists because it does a
few things genuinely well — and it fails in predictable ways that,
left unmanaged, can make the wiki worse than the raw material it was
supposed to organize.

## What wikis get right

The honest case for the pattern, drawn largely from the Karpathy
analysis [claude-825097e2:6] and the graph-representation thesis
[claude-825097e2:5]:

- **Knowledge compounds instead of evaporating.** Syntheses land in
  a durable, human-readable form. Every query's output has a home.
  Normal chat-with-docs answers vanish; wiki pages persist, get
  linked into, and accumulate over time [claude-825097e2:6].
- **Grunt-work deflection.** The LLM does the maintenance nobody
  has time for — cross-references, stale-claim detection, index
  updates, orphan detection. This bookkeeping is what gets every
  personal wiki abandoned inside a month; automating it removes
  the dominant failure mode of the human-only version
  [claude-825097e2:6].
- **A navigable graph.** *"Turning raw docs into a wiki is
  essentially a transform into a graph representation of
  knowledge, where hyperlinks between wiki pages are the edges"*
  [claude-825097e2:5]. The graph is legible in a way a corpus of
  prose isn't; relationships become visible as edges.
- **Schema as prompt.** A project-level schema file (Karpathy's
  `CLAUDE.md`, brane's /wiki protocol) is human-legible,
  versionable, and the place where the opinions actually live. You
  can read it, edit it, check it into git, watch it evolve
  [claude-825097e2:6].
- **RAG-bypass.** The LLM reads structured pages directly instead
  of hoping cosine similarity finds the right chunks
  [claude-825097e2:6]. Pre-paying the retrieval work at compile
  time buys clean reads at query time — when it works.
- **Low on-ramp.** A personal wiki is a weekend project, not a
  system. The threshold to adoption is the pattern's most
  underrated property; it converts skeptics because it asks for
  so little upfront [claude-825097e2:25]. Many of the wins above
  are available before any infrastructure investment.

These are real. A wiki over a modest corpus, maintained well, is
better than the corpus alone for most queries most of the time. The
Karpathy pattern's popularity is not misplaced.

## Where wikis struggle

The struggle surfaces all share a shape: *compilation imposes an
ontology, and compilation happens at the wrong moment*
[claude-825097e2:13]. The LLM writes pages out of context, under its
current biases, with no idea what questions will later need
answering. Once committed, the ontology is the substrate the system
operates on. Whatever the compiler got wrong quietly propagates
forever [claude-825097e2:13].

The specific failure modes:

- **[Premature ontology](premature-ontologies.md).** The wiki becomes
  the map, and then the system stops looking at the territory
  [claude-825097e2:13]. The operator's sharper form: the compilation
  step is *"viciously opinionated, blindspotted, and premature"*
  [claude-825097e2:12]. Every future query reads from the wiki, not
  from raw; mistakes accumulate rather than wash out.
- **Category calls that stick.** What counts as a concept page vs a
  passing reference. Which entities deserve their own page. How to
  categorize a borderline claim — is this a `concepts/` page or a
  `sources/` page or a `comparisons/` page? The LLM commits; the
  category sticks. Category calls made early and opinionatedly are
  exactly what you can't take back [claude-825097e2:13].
- **Silent loss.** What gets summarized out is the failure mode no
  lint pass catches — the detail the compiler thought was noise is
  now invisible, and nobody knows it used to be there
  [claude-825097e2:13]. A wiki's silence is not the same as
  absence; it's the absence of any record that the silence is a
  choice.
- **Edges that can't carry their weight.** The graph's edges
  *"don't fully explain the relationship, which must be inferred
  from the context of the link"* [claude-825097e2:5]. Two pages
  linked from seven different paragraphs carry seven different
  relationships — but a graph view collapses them into one edge.
  The graph hides its own imprecision.
- **Per-page canonical identity is the real commitment.** A wiki
  page pretends to be *current best understanding*, which means
  every read treats it as authoritative [claude-825097e2:13]. The
  stable filename and in-place editability are what make a wiki a
  wiki — and they are the same property that loses the full
  evolution of a claim when the page is rewritten
  [claude-825097e2:27].
- **The read-time case is eroding.** The historical rationale for
  pre-compiling structure was that models couldn't do cheap
  multi-hop traversal over raw material. That's no longer true.
  *"Every generation of LM that's better at latent multi-hop
  reasoning is an indictment of wikis and an endorsement of
  indexed-raw"* [claude-825097e2:17]. The premature-ontology cost
  stays constant while the benefit of pre-compilation shrinks.

None of these is fatal on its own. Together, they explain why
ambitious wiki projects so often read, five years in, as a layer
the system has to work around rather than through.

## The brane wiki as a compromise

Brane has narratives, payloads, and a hybrid memory index over the
[append-only event log](append-only-event-log.md). That stack is
the no-wiki answer in full form: raw is sovereign, every query
re-interprets, no schema is ever committed to. The page you're
reading exists, but it exists inside a wiki directory whose
operator explicitly argued for *not* having a wiki layer
[claude-825097e2:13].

The compromise is that wikis can pay for their own struggle
surfaces when four disciplines hold
[claude-51cdebff:3, claude-51cdebff:6, claude-51cdebff:9]:

- **Humans own the ontology.** The agent never creates, renames,
  or deletes pages. Every page is a human-authored stub or a
  pre-existing page; the agent fills, refreshes, cross-links, and
  cites — but it never names. This dissolves the premature-
  ontology and category-call failure modes by construction:
  there is no LLM-minted ontology to be wrong about.
- **Inline provenance.** Every non-trivial claim carries a
  back-reference — a narrative citation (`nid:seq`), a file path
  with a line range, or an external URL. Stale claims become
  traceable, not opaque. A page without citations is unauditable
  and flagged as such in audit output.
- **Read-first, write-on-demand.** Default `/wiki` behavior is a
  query, not a rewrite. The wiki is a read path, not a writing
  project. Writes happen only on explicit imperative guidance.
- **Backlink re-reading and refresh markers.** When a page is
  edited, incoming backlinks are walked and the linking prose is
  re-verified. Every update narrates a `Wiki refreshed —
  <timestamp>` marker so future passes can find the last sync
  point via `narrative_search`. Silent edge-drift becomes visible.

These disciplines don't solve the ontology problem; they *scope*
it. You still have pages, so you still have category calls. But
the pages are human-chosen — narrowing the blast radius — and the
claims inside them are provenance-linked — narrowing the drift
radius. When a wiki page contradicts the narratives, the
narratives win and the page is wrong. The raw substrate is still
where truth lives; the wiki is an opinionated projection of it
[claude-825097e2:13, claude-825097e2:27].

## Granularity, connectivity, mutability

Wikis and narratives sit on the same spectrum along three axes
[claude-825097e2:27]:

| | Wiki page | Brane narration |
|---|---|---|
| Granularity | one facet per page | whole topic or time window in one narration |
| Connectivity | `[foo](foo.md)` between files | `re` back-references (`nid:seq`) |
| Mutability | in-place rewrite | append-only (new narration) |

Granularity and connectivity are style choices — brane can do
fine-grained topic-scoped narrations with rich `re` webs, and a
wiki can have sprawling pages with few links. The axis where the
distinction is not cosmetic is **mutability/identity**
[claude-825097e2:27].

A wiki page has a stable identity — *the* `daemon.md` page, and
editing it is an update to truth. A narrative has no canonical
statement about its subject; there is the set of all statements
about X ordered by relevance, and the reader picks
[claude-825097e2:27]. This is why narratives resist premature
ontology: they don't commit to per-page identity. And why wikis
struggle: they do.

The brane wiki's trick is to be built on top of an append-only
substrate it cannot replace. The wiki page can be wrong without
the record being lost. A page rewrite overwrites the *projection*;
the narratives underneath still carry the history that produced
the wrongness.

## Rules of thumb

- **The wiki is not the read path.** The narratives are. The wiki
  is a navigation layer — useful for orientation, not for truth.
- **When a wiki page disagrees with a narration, the narration
  wins.** Update the page; never retrofit the narrative.
- **Let humans name the pages.** The agent fills; the human
  carves. Agent-minted pages — where the LLM proposes, names, and
  schematizes the wiki's ontology unprompted — is the failure mode
  the Karpathy pattern is most prone to and that this wiki was
  specifically built to dodge [claude-51cdebff:6].
- **Cite provenance inline.** If a claim can't name its source,
  it doesn't belong on the page.
- **Expect to delete pages.** A wiki that never shrinks has
  committed to bad ontology and can't admit it. Deletion is a
  first-class move, not an admission of failure.

## Related

- [premature-ontologies](premature-ontologies.md) — the broader
  failure-mode this page applies to wiki compilation. Every "where
  wikis struggle" item here recurs at other layers (schemas, agent
  memory, knowledge graphs); that page collects the general critique.
- [sedimentary-superintelligence](sedimentary-superintelligence.md)
  — the raw substrate underneath. The wiki is a projection of it;
  the sediment is the thing.
- [append-only event log](append-only-event-log.md) — the
  canonical record. No wiki page has equivalent authority.
- [owning your narratives](owning-your-narratives.md) — the
  narration-side practice that makes the sediment worth drilling.
  Wiki pages don't accumulate into sedimentary superintelligence;
  narrations do.
- /wiki — the operational protocol that
  implements the compromise described on this page.
