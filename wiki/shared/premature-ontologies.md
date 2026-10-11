# Premature Ontologies

A *premature ontology* is a typology committed to before observation
has earned the scope of its categories. The phrase entered this archive
when the operator characterized a proposed schema for "agent memory" —
catalogued tables for facts, relationships, contradictions, hypotheses,
goals, and failures — as *"another premature ontology"*
[claude-c891087f:6]. The page collects what subsequent discussion
clarified about the pattern: where it tends to appear, why it recurs,
and when an ontology is tolerable enough to survive contact with
practice. The brane substrate is the worked example used throughout
the archive to illustrate the discipline of refusal; the project's
specific commitments and the capabilities it forgoes in exchange are
collected on a separate `brane-ontology` page in the brane repository.

## The pattern

The recurring shape, observed across several decades of
information-system design [claude-c891087f:9, claude-c891087f:14,
claude-c891087f:15]:

1. A team surveys the domain they care about and identifies a small
   number of categories that seem to recur.
2. The categories are committed as schema — fields on a record, tables
   in a database, columns in a graph, slot types in a frame.
3. The system requires that future observations be coerced into one or
   more categories at write time. Anything that doesn't fit is either
   forced into the closest match or dropped.
4. Once committed, the schema is the substrate the rest of the system
   operates on. Whatever the original committer got wrong propagates
   through every subsequent query, every extension, every audit.

The recurring move is **taxonomy promoted to substrate**
[claude-c891087f:12] — the same instinct that produced RDF, the Semantic
Web, knowledge graphs, "cognitive architectures" for agents, and most
"agent memory" products. The shared rhetorical pattern: a team surveys
its own workflow, identifies a recurring vocabulary (tasks, goals,
decisions, hypotheses, failures, contradictions, entities, relationships,
capabilities), promotes that vocabulary to schema, and ships the result
as a generic cognitive architecture — when in fact the categories aren't
general at all but a specific team's vocabulary asserted as universal.
The instinct keeps recurring because structured data feels safer than
search; the critique keeps not landing because the cost of building the
structure exceeds the value of having it once retrieval over raw text
gets cheap enough [claude-c891087f:12, claude-c891087f:15]. A useful
translation when reading these pitches: "we built a cognitive
architecture" → "we wrote down our team's task vocabulary as SQL
tables." Then check whether the schema survives in another team's
workflow — usually not.

## The integrationist diagnosis

The archive draws on the integrational linguistics of Roy Harris
([Stanford HCI Group bibliography on language/action and integrational
work](https://web.archive.org/web/20240623221447/https://hci.stanford.edu/winograd/action/language-action-biblio.html),
archived)
to ground the critique philosophically [claude-c891087f:34,
claude-c891087f:35, claude-14616e34:20]. Harris's long argument
against what he called *the language myth* — the idea that
communication is decoding from a fixed shared system whose meanings
are specified in advance — applies directly to ontology projects.

In the framing proposed in the agent narrations, premature ontology is
the language-myth move applied to information systems: the schema
*pretends* the meanings of utterances are decodable from a fixed shared
typology, when in fact each utterance is integrated with its own
occasion and the typology is a designer's guess at what the regularities
will be [claude-c891087f:34]. The integrationist alternative described
in the archive is to keep the substrate ontology-free — utterances are
free-form text, attributed to named authors, ordered in time — and let
each act of reading produce meaning in its own current context, rather
than retrieving a frozen interpretation [claude-c891087f:35].

The wiki page on
[sequestering the narrative](sequestering-the-narrative.md) states the
integrationist position directly:

> *Meaning is made anew each time the narrative is re-entered — not by
> retrieving a frozen interpretation, but by a live reader integrating
> the recorded words with whatever the current occasion calls for.*
> [sequestering-the-narrative.md, citing claude-8cd201d8:18]

The same archive notes a residual tension Harris would flag: even
embedding-based retrieval can slip into language-myth phrasings —
"this matches" or "this is about" — that imply a stable reference
relation between utterances rather than fresh acts of integration
performed by current readers [claude-c891087f:35]. The integrationist
discipline proposed is to keep retrieval framed as *surfacing words
that may be useful to the live reader's current making of meaning*
rather than as *finding what was meant*. Less crisp; more accurate.

## Substrate moves win; vocabulary moves lose

The narrative archive contains several historical instances proposed
as the same shape of move [claude-c891087f:15]:

| Substrate move (won) | Vocabulary move (lost) |
|---|---|
| Turing machine — generic computation | Domain-specific computers |
| Files (opaque byte streams) | Typed records, ISAM, structured storage |
| REST + JSON | CORBA, SOAP, WSDL |
| Embeddings + dense retrieval | Knowledge graphs (typed relations) |
| Append-only event logs | "Cognitive layer" schemas for agent memory |

A recurring instance in the "agent memory" product space is the
**maximalist** case: consolidation tables for facts, relationships,
patterns, contradictions, hypotheses, goals, and failures, plus a
self-referential namespace, populated by an LLM-driven multi-stage
pipeline. That shape is the cleanest example of typology-as-substrate
— the schema *is* the system. A tighter case borrows its core
typology from a vocabulary every team already shares (the issue
tracker): typed events for bugs, tasks, and messages; workflow
primitives like *unblocked work* and *atomic claim*; edges like
*blocks*, *parent-child*, *discovered-from*, *supersedes*. The
issue-tracker shape earns relatively high coverage despite the schema
commitment precisely because the categories were not minted by the
designer [claude-c891087f:5, claude-c891087f:21]. Forks and
downstream extensions of such systems still tend to accrete their own
task-shape categories on top of the shared vocabulary — evidence that
even on the most universal of work taxonomies, idiolectic additions
are the recurring temptation rather than the exception.

A more instructive third pattern: a local-first memory system that
*does* commit to verbatim storage and refuses LLM-driven
consolidation, putting it closer to the substrate-move side of the
table on content. The architectural commitment to raw is unambiguous
— no summarization, no extraction, no paraphrase. But the index layer
is then schematized with a spatial-palace metaphor — *wings* for
people and projects, *rooms* for topics, *drawers* for original
content — and a separate temporal entity-relationship knowledge graph
with validity windows is layered on top. Each "neutral" container
carries a quiet commitment: a wing presupposes the unit of
organization is person-or-project, a room presupposes that topics
chunk cleanly enough to be containerized, a drawer presupposes that
original content fits in slots. Even when consolidation is refused at
the *content* layer, the temptation to schematize at the *index*
layer recurs — and a separate KG layer is the same typed-relations
move that knowledge-graph projects have been losing on for two
decades. This is the cleanest case for the claim that the
substrate-vs-typology choice is not just about whether you summarize:
it shows up at every layer where structure could be imposed, and the
discipline has to refuse it everywhere.

Each substrate winner committed to *less* about what data means
(time order, persistence, bytes, similarity) and *more* about how
records of utterances are kept. Each vocabulary loser committed to
*more* about what the data is *about* — categories of programs,
record types, method names, relation types, kinds of work — and
those commitments aged out as the domain shifted. The framing
proposed in the archive is that retrieval quality keeps improving
on a Moore's-law-ish curve, while the cost of ontology stays
fixed; the substrate move compounds with the curve, the vocabulary
move is priced against last year's retrieval [claude-c891087f:15].

This is one framing of the pattern; alternative framings (e.g., that
ontologies sometimes succeed when they encode regularities of the
human or institutional environment rather than designer preference)
are not engaged with in detail in this archive yet.

## Relevance prediction across timescales

A more general analytical frame proposed in the archive subsumes the
substrate-vs-vocabulary pattern under a single principle: every
cognitive architecture is a stack of relevance predictions across
timescales, and *the only ground-truth relevance is the one made at
integration time* [claude-14616e34:26]. The frame, as stated in the
narration:

| Layer | What it predicts | Update cadence |
|---|---|---|
| LLM weights | Token-level relevance given context | Pretraining (frozen) |
| Embeddings | Semantic neighborhood of corpus items | Re-index when corpus changes |
| Cached prefix | Per-fold/per-session operator priors | Operator decisions |
| Strength scores (`re`, attention) | Use-pattern relevance | Continuous from substrate |
| Retrieval ranking | Per-query relevance | Per-call |
| Agent's act of integration | This emission's actual relevance | This moment |

Each row above the bottom is a frozen guess about what the row below
it will need. Each row pays a different amortization curve, and each
is right exactly to the extent that runtime patterns match the
patterns it was tuned on [claude-14616e34:26].

In this frame, premature ontology is a high-confidence prediction
baked at the wrong layer: a designer claims that *this typology will be
relevant at every future runtime moment*, and pays the schema cost up
front to bake that claim in. The claim is rarely justified — most
typology decisions track the designer's particular conditions, not a
durable property of the domain — and the baking cost compounds while
the runtime patterns drift. Vocabulary moves bake what should have
been deferred; substrate moves bake only what is genuinely stable
across all anticipated runtimes.

## A tolerable ontology: the LAP / Coordinator case

The clearest historical case of an ontology that came closer than most
to being *generic* is the Language/Action Perspective developed at
Stanford HCI by Terry Winograd and Fernando Flores, productized as
**The Coordinator** by Action Technologies in the mid-1980s
([Stanford HCI bibliography](https://web.archive.org/web/20240623221447/https://hci.stanford.edu/winograd/action/language-action-biblio.html),
[Dubberly: The Language/Action Model of Conversation](https://www.dubberly.com/articles/language-action-model.html)).
The Coordinator tracked workplace email under a structured
"conversation for action" protocol — request, promise, performance,
declaration of completion, counter-offer, decline — drawn from
J. L. Austin's and John Searle's speech-act theory.

Four properties made the LAP ontology more tolerable than most
[claude-14616e34:38]:

- **Borrowed, not minted.** The illocutionary types came from Searle's
  work in *Speech Acts* (1969) and *Expression and Meaning* (1979),
  which had absorbed two decades of philological and cross-cultural
  pressure. Winograd and Flores took an ontology that had earned its
  scope rather than inventing one.
- **Speech-act, not work-content.** The categories were *how utterances
  function in coordination* (request, promise, declaration), not *what
  the work is about* (sales, engineering, customer support). One floor
  below the layer where universality usually fails.
- **Role-relational, not subject-categorical.** A request implies
  requester and performer; a promise implies maker and recipient. The
  schema was about the shape of the interaction, not about properties
  of the topic.
- **Small.** Five Searle types, narrowed to four operational moves in
  the conversational protocol.

The Coordinator was nevertheless characterized, in retrospect, as a
brittle product. Lucy Suchman's CSCW critique
[*Do Categories Have Politics?* (1994)](https://www.lancaster.ac.uk/fass/doc_library/sociology/Suchman_categories_1994.pdf)
argues that situated action does not follow a request → promise →
completion protocol cleanly; that real utterances frequently combine
multiple illocutionary functions in a single message; and that
surfacing the categorization to users as required UI labels both
created visible labor and politicized the categories as managerial
monitoring devices. From the paper:

> *"It is not just that the language/action perspective offers a
> simplified model of communication. The model itself prescribes
> categories that recast workplace communication in particular,
> consequential ways."*

Winograd's
[response](https://www.lri.fr/~mbl/ENS/CSCW/2015/papers/Winograd-JCSCW94.pdf)
defends the design intent without disputing the empirical observation.

The general lesson: a typology becomes brittle when it is made
operational at the moment of utterance, which is exactly where
premature ontology hurts most [claude-14616e34:38]. The Coordinator's
ontology was tolerable as a *lens* on conversation; it was brittle
as the *substrate* of a tool. The corollary is to keep speech-act
language in retrieval and prose, never in schema; let the typology
emerge in the language people choose to use, rather than coerce
write-time emissions into pre-specified slots.

## Why the pattern recurs

The archive offers two diagnoses for why the move keeps coming back
despite a long history of similar failures.

### Epistemic greed and laziness

The operator's framing, moderated to refer specifically to *epistemic*
greed and laziness rather than political or economic motives
[claude-14616e34:17, claude-14616e34:45]:

- **Greed** in the *greedy-algorithm* sense: committing to the first
  ontology that locally seems to fit, with no backtracking. Locally
  optimal at the moment of decision; globally suboptimal once the
  domain shifts and the schema can't follow. The cognitive analogue
  of a depth-first search that locks in early branches.
- **Laziness** in the *epistemic* sense: avoiding the harder work of
  staying in uncertainty — refusing to commit a typology until the
  categories have earned their scope through observation. Premature
  commitment is cheaper at decision time than holding the question
  open; the cost shows up later, as drift.

The diagnosis is procedural, not political. Designers under cognitive
load grab the first plausible structure they can map onto and lock it
in; the alternative — staying in free-form representation while
patterns are still being discovered — feels like a deferred decision
when it is in fact the better answer for systems whose domain hasn't
yet stabilized [claude-14616e34:45].

### Structure-feels-safer-than-search

Stated at the engineering level: structured data feels safer than
search; the lesson keeps not landing because the cost of building the
structure exceeds the value of having it, once retrieval over raw text
gets cheap [claude-c891087f:12]. Both diagnoses describe the same
instinct from different angles — one cognitive, one technical.

### The consistency-not-capability backdrop

A broader pattern operates as well. The operator's framing
[claude-14616e34:17, claude-14616e34:18]:

> *"A lot of AI model capability discourse isn't about an ever
> increasing quantity, but an asymptotically shrinking rate of
> inconsistency across ideas, with many hoping naively that if agents
> can just achieve consistency with all environmental constraints,
> human choice won't be required any longer (obviously false but
> greed/laziness perverts intuition)."*

Restated: on this reading, many recent "AI capability" benchmark gains
are better described as coherence gains — longer context, deeper
retrieval, more reasoning steps before drift — than as capability gains. The asymptotically shrinking rate of inconsistency
is the real metric; capability is its publicity outfit
[claude-14616e34:18]. The connection to premature ontology is direct:
ontology projects promise that *if the categories are right,
consistency follows*. That promise is what makes the schema move
attractive even after decades of evidence that the categories are
rarely right; the recurring belief that consistency-by-machinery can
replace human choice is what keeps the ontology trade looking
worthwhile.

The claim that consistency suffices is structurally false on five
fronts [claude-14616e34:18]:

1. **Consistency is always *with what*.** Some constraint set has to
   be specified, and specifying it is value-laden. Two perfectly
   consistent systems can be optimizing irreconcilable goods.
2. **Local consistency does not imply correctness.** A coherent
   system can be coherent with a wrong premise.
3. **Constraints conflict.** Real environments contain trade-offs
   that no consistency procedure can settle without smuggling in
   priorities. The priorities are choices.
4. **The constraint set is contested.** What counts as an
   "environmental constraint" is itself socially constructed and
   re-litigated.
5. **Goodhart applies structurally.** Any consistency target one can
   measure becomes the optimization target; whatever mattered that
   couldn't be measured gets squeezed out.

The seduction recurs because the choosing burden the alternative
imposes is genuinely exhausting — the error is mistaking "I don't
want to choose" for "the choice is unnecessary" [claude-14616e34:18].

## What makes an ontology more tolerable

A discipline distilled across the threads above [claude-14616e34:38,
claude-14616e34:40]:

- **Small.** Few categories, with no ambition to grow. The Coordinator's
  4–5 was tolerable; a nine-table cognitive-structure schema is not.
- **Borrowed.** Categories that have already survived field testing —
  in linguistics, philosophy, an industry standard, an RFC — are
  preferable to categories invented by the system's designer. Earned
  scope beats minted scope.
- **Role-relational, not content-categorical.** Typing *who is doing
  what* (requester, performer, author, source) generalizes; typing
  *what kind of thing this is about* does not.
- **Descriptive, not prescriptive.** Useful as a lens for reading past
  utterances; brittle as a required field at write time.
- **Optional, not coercive.** A category that an utterance can carry
  but is not required to carry has a much smaller blast radius than
  one that gates emission.
- **Multi-illocutionary by default.** Real utterances combine
  functions — a single message may request, apologize, and propose
  terms at once. A schema that demands a single category per utterance
  loses information that a free-form text representation preserves
  [claude-14616e34:38].

Each of these properties trades scope for survivability. The intuition
proposed in the archive is that an ontology that tries to be
*comprehensive* is almost always overreach; an ontology that stays
*minimal and borrowed* sometimes survives.

## Discipline checks

Several heuristic checks have been proposed in the archive for
evaluating whether a proposed addition to a system is structural or
typological [claude-c891087f:30, claude-14616e34:40]:

1. **Observation or opinion?** Programmatic events that record
   *what happened* (a tool ran, a file changed, a test passed) are
   substrate-shaped. Events that record *what kind of thing happened*
   (`bug_found`, `goal_completed`, `decision_made`) are typology
   smuggled in.
2. **Named accountable author, or "the system"?** A `source` field
   that names a specific actor (`tool:claude-code:Edit`,
   `claude-14616e34`) is fine; one set to `system` is the
   pipeline-as-author trap.
3. **Does it require a parent taxonomy?** A new event class that
   only makes sense inside a hierarchy of categories is a typology in
   miniature; refuse it.
4. **Pre-categorize at write time?** If a proposed feature requires
   the writer to label their utterance with a category before the
   utterance can be appended, it is operationalizing a typology in the
   exact place the Coordinator failed.
5. **Visible labor, or politicized categorization?** If the category
   surfaces in the UI as a required choice, users will perceive it
   socially — as friction, as monitoring, as imposition. Suchman's
   1994 critique is the field-tested instance of this failure.
6. **Greedy commitment?** If the proposal is "let's go with this
   typology *for now*" with no plan for how the categories will earn
   their scope through observation, the algorithmic-greed diagnosis
   applies. Free-form text and aggregation-from-use are the
   alternative; both can be deferred until the patterns have shown
   themselves.

## Related

- [why-wikis-work](why-wikis-work.md) — applies the same critique to
  the compilation step that produces wiki pages. The four disciplines
  (humans own ontology, inline provenance, read-first, backlink
  refresh) are scope-narrowing moves of the same shape as the checks
  on this page.
- [sedimentary-superintelligence](sedimentary-superintelligence.md) —
  the system-level claim about what an ontology-free substrate
  becomes when accumulated across time. The bet that retrieval
  over raw narrations beats extraction into typed records is the
  positive version of this page's negative critique.
- [sequestering-the-narrative](sequestering-the-narrative.md) —
  carries the integrationist position about meaning being made each
  time the narrative is re-entered. The same position animates the
  refusal to type utterances at write time.

## External references

- Suchman, Lucy. *Do Categories Have Politics? The Language/Action
  Perspective Reconsidered.* Computer Supported Cooperative Work 2,
  1994
  ([PDF](https://www.lancaster.ac.uk/fass/doc_library/sociology/Suchman_categories_1994.pdf)).
- Winograd, Terry. *Categories, Disciplines, and Social Coordination*
  (response to Suchman). CSCW 2, 1994
  ([PDF](https://www.lri.fr/~mbl/ENS/CSCW/2015/papers/Winograd-JCSCW94.pdf)).
- Winograd & Flores, *Understanding Computers and Cognition* (Ablex,
  1986).
- Searle, John. *Speech Acts: An Essay in the Philosophy of Language*
  (Cambridge, 1969); *Expression and Meaning* (Cambridge, 1979).
- Harris, Roy. *The Language Myth* (Duckworth, 1981); *Signs of
  Writing* (Routledge, 1995); *Integrational Linguistics* (selected
  papers).
- Stanford HCI Group,
  [Language/Action Perspective bibliography](https://web.archive.org/web/20240623221447/https://hci.stanford.edu/winograd/action/language-action-biblio.html)
  (Wayback snapshot, June 2024; the original
  `hci.stanford.edu/winograd/action/language-action-biblio.html` now 404s).
