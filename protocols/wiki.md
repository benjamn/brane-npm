# /wiki [guidance]

Maintain and query a flat, richly interlinked markdown wiki at `./wiki/`
in the current fold. The wiki is the human operator's second brain for
this project — the agent's job is to *answer from it*, *refresh it
against current reality*, and *flag drift*, but never to decide what it
contains.

## Default is read-only

**`/wiki` without imperative write-intent is a query.** The agent reads
`wiki/*.md`, answers the operator's question as a narration, and does
not modify any files. This is the primary mode — treat writes as rare
and deliberate, not the norm.

Writes happen only when the guidance contains an unambiguous imperative:
`update`, `refresh`, `rewrite`, `apply`, `write`, `fill`, `sync`,
`propagate`, or equivalent. "Tell me about X," "what does the wiki say
about Y," "is the page on Z accurate" — all read mode.

When in doubt about intent, stay in read mode and narrate what you
*would* change. The operator can re-invoke with explicit write guidance.

## The agent does not invent concepts

The failure mode this protocol exists to prevent is the agent deciding
that a new concept deserves a wiki page. When the agent, midway through
writing, notices a sub-idea and spins off `sediment-based-superintelligence.md`
as a companion to `sedimentary-superintelligence.md`, the ontology has
been corrupted from inside — the operator now has two pages for one
concept and no way to tell which is canonical without reading both.

The rule is about *concepts*, not filenames. The operator is the source
of the concept set; the agent fills, refreshes, and cross-links the
pages those concepts get. Filename spelling is an implementation detail
the agent handles (kebab-case slugs, consistent with existing pages),
but the concept itself must come from the operator.

Cases:

- **Operator introduces a concept in imperative guidance** → free to
  create a page for it. The concept can be named directly (`sedimentary
  superintelligence`) or by filename (`sedimentary-superintelligence.md`);
  either form is authorization. Create the file, draft from raw sources,
  apply the page rules. Don't pre-narrate a draft and ask the operator
  to paste — that's too indirect when the authorization is clear.
- **Operator asks a question that mentions a concept with no matching
  page** → read mode. Answer from raw sources. Note the gap in a
  footer, but do not create a page — a concept mentioned in a question
  is not a concept the operator has asked to be added to the wiki.
- **Agent encounters a novel concept while refreshing or answering** →
  no new page. Mention the concept in prose where relevant; if it
  seems to deserve its own page, surface that as a suggestion in the
  narration for the operator to decide.
- **Stub file already exists** (just `# Foo` or a seed line) → refresh
  mode fills it. The stub's existence is the operator's signal that
  this concept belongs in the ontology.
- **Renames and deletions** → propose in narration, never apply on
  disk. These are ontology decisions.

Creating the `wiki/` directory itself is permitted the first time a
page creation is authorized — it's implied by the first authorized
page, not a concept decision of its own.

## Voice and register

Wiki pages are reference material, not essays, advocacy, or marketing
copy. Write in a neutral, descriptive, third-person register — closer
to a Wikipedia article than to a product pitch or a personal manifesto.
The reader should learn what the subject *is* and what has been
*claimed* about it, not be sold on why it matters.

Concrete rules:

1. **Attribute positions; do not assert them.** Anything that reflects
   the operator's (or anyone else's) argument, preference, or
   conjecture should be presented as theirs, not as fact. Use
   "Newman argues that…", "is described as…", "has been proposed as…",
   "is characterized as…" rather than stating the claim flat. Facts
   from code, config, external sources, or reproducible observations
   can be stated directly; opinions cannot.

2. **Cut editorializing phrases.** Words and phrases that assert
   importance or deliver a rhetorical punch without adding information
   don't belong: *load-bearing*, *the joke is*, *keeps X honest*,
   *makes the form work*, *the real play*, *escape velocity is
   literal*, *it's not metaphor — it's*, *what this unlocks*, *designed
   to X*. If the underlying claim is substantive, state it plainly and
   attribute it; if it's decoration, remove it.

3. **Flag metaphors as metaphors.** When an analogy is allusive rather
   than structural, say so. "Newman sometimes calls this *X*, by
   analogy to…" beats asserting the analogy as if it were definitional.
   A metaphor used by the subject's author once in passing should not
   become the page's organizing frame.

4. **Avoid sales-pitch sections.** *Why this matters*, *What this
   unlocks*, and similar sections are advocacy shapes. If the content
   is genuinely informative, it can live as a *Rationale* or
   *Background* section framed descriptively. If it's only advocacy,
   cut it.

5. **Describe, don't defend.** If the subject is a proposal, call it a
   proposal and summarize it. Resist the urge to argue *for* the
   proposal inside the description of it; that's what provenance links
   are for — the reader can follow the citation to see the argument
   as the author made it.

6. **Preserve citations regardless of register.** The tone of the
   prose is independent of provenance requirements. Every non-trivial
   claim still carries its `nid:seq` or file-path citation. Neutral
   voice is not a reason to drop citations; it is a reason to let the
   citations do more of the work.

7. **Don't anthropomorphize the subject into a hero.** Subjects are not
   "bold," "radical," "unlike any other tool" — not even when the
   source material says so. Leave that framing in the cited source.

8. **Don't inflate the operator's epistemic footprint.** Neutral-voice
   attribution creates a specific bias: every "Ben argues…" or "Newman
   proposes…" is a claim that the operator originated the idea. When
   agents write the wiki, it is tempting to attach the operator's name
   to every framing, including syntheses the agent itself generated in
   earlier narrations that the operator merely didn't object to. That
   quietly promotes agent-generated material into operator positions.

   Before attributing a claim to the operator, check its provenance:

   - **Originated in a `human_signal`** → safe to attribute to the
     operator. Example: the operator writes "a trigram is exactly
     three words" → "Newman defines a trigram as…" is correct.
   - **Originated in an agent `narration`, with no operator
     pushback** → do **not** attribute to the operator. Use passive
     construction: "has been proposed…", "a formulation that appears
     in the narrative record…", "is discussed in the archive as…".
     Cite the narration directly; let the reader follow the link and
     see who actually said it.
   - **Agent narration that the operator explicitly affirmed**
     (e.g., the operator replied "yes, exactly" or saved it as
     feedback memory) → attribute to the operator *if* the affirmation
     was specifically about that claim, not about the broader reply.
     Cite both the narration and the affirming signal.
   - **Operator paraphrased an agent's framing back** (e.g., the
     agent proposed "register descent," the operator used the term
     in a later signal) → the term is shared; attribute the *origin*
     to the agent narration and note the operator's uptake if the
     distinction matters.

   When in doubt, prefer passive or archive-anchored attribution
   ("the term appears in the archive as…", "this framing has been
   proposed") over naming the operator. The citation does the heavy
   lifting; the reader can see who actually originated the claim by
   clicking through.

This register applies to **all write modes**: create, refresh, and
targeted edits. Read-mode answers (narrations) have more register
latitude — they are operator-facing conversation, not the wiki — but
the page itself, once written, should read as reference.

## Wiki structure

Flat layout — every page lives directly under `wiki/`, with one
permitted subdirectory, `wiki/shared/`, that is itself flat:

```
wiki/
  index.md          # human-maintained catalog (agent never edits)
  <page-name>.md    # one file per concept/entity/topic — fold-local
  shared/
    index.md        # catalog of the shared pages (agent never edits)
    <page-name>.md  # visible from every fold that can reach this one
```

**Local and shared.** Pages directly under `wiki/` are visible only to
agents working in this fold. Pages under `wiki/shared/` are visible to
every fold: `list_wiki`, `read_wiki`, and `search_wiki` show another
fold only its `shared/` pages, and reading its local page errors with
*"local, not shared"* rather than *not found*. The brane install
directory is a fold too, so brane's own shipped pages are simply that
fold's `shared/`. A page's slug is its path under `wiki/`:
`foo.md` is local, `shared/foo.md` is shared, and a citation
(`slug#anchor`) means the same thing to every reader.

**Which side a page lives on is the operator's call**, exactly like
naming it. The agent never moves a page between `wiki/` and
`wiki/shared/`, in either direction. Keep local pages fluid — they are
where a fold thinks — and treat promotion to `shared/` as publication.

Filenames are kebab-case and stable. Internal links use plain markdown,
**relative to the linking file's directory** — the way GitHub and every
editor render them: from a local page, `[x](x.md)` and
`[y](shared/y.md)`; from a shared page, `[y](y.md)` for a shared
sibling and `[x](../x.md)` for a local page. Do not use `[[wikilink]]`
syntax — it only renders in Obsidian.

A shared page may link to a local one, but that link is a **citation,
not a promise**: a reader in another fold will see the target named and
scoped ("local to fold `personal`, not shared") and cannot open it. So a
shared page must *read* without its local links — the way a narration
must read without the scrollback. Local → shared links are always safe.

Pages should cross-link generously to other existing pages. Every link
target must be a file that currently exists in `wiki/` (or
`wiki/shared/`) — if the natural link target is missing, mention the
concept in prose without linking and add a footer note: *"Could link to
a `<name>.md` page if you create one."*

## Provenance

Non-trivial claims carry an inline citation:

- To a narrative event: `[claude-4c7289d1:42]` (the operator's UI
  auto-linkifies this).
- To a protocol: the slash command itself — `/wiki`, `/LIVE_loop` — which
  the reader linkifies into the protocol document. Never write it as a
  path (`../protocols/wiki.md`): links that escape the wiki dir are
  refused by the reader and render as dead text.
- To a file path: `daemon/server.ts:215` (operator's editor auto-opens).
- To an external source: standard markdown link with URL.

Citations let future `/wiki audit` passes check whether each claim still
holds. A page with no citations is not audit-tractable; flag that in
audit output.

## Modes

### Read mode (default)

Guidance is a question or statement without write-intent verbs.

1. Read `wiki/index.md` if it exists, then any pages it points to that
   seem relevant to the question.
2. If the wiki is thin on the topic, fall back to `narrative_search`
   over past narratives and direct file reads in the fold.
3. Narrate the answer. Cite the wiki pages you used (`[foo](foo.md)`
   links) and the raw sources that filled gaps.
4. If the question is about something with no matching page, say so in
   a footer — do not create the file.
5. **Do not edit any file in `wiki/`.** Not even to "fix a typo while
   you're at it." Read mode is read-only, period.

### Audit mode

Guidance explicitly requests an audit: `/wiki audit`, `/wiki audit foo`,
`/wiki check for drift`, `/wiki what's stale`.

1. Walk the target page(s).
2. For each non-trivial claim with provenance: verify the cited source
   still supports it. If the source is a narrative, sample it with
   `listen` (`wait: false`, narrow `after`/`before`). If a file path,
   read the file.
3. For claims without provenance: flag them as unauditable.
4. For internal links: verify each `[text](name.md)` points to a file
   that exists, resolving relative to the linking file's directory.
   Separately list links from a `shared/` page to a local page — not
   an error, but the reader elsewhere can't follow them, so the page
   must stand without them.
5. Sample recent activity via `narrative_search` — look for topics that
   would belong on an existing page but aren't mentioned there. Call
   this out as *drift*, not as a new-page proposal.
6. Narrate a structured report (see "Audit output" below).
7. **No writes.** Audit is read-only.

### Create mode

Guidance introduces a concept with a creation imperative:
`/wiki seed sedimentary-superintelligence.md`, `/wiki start a page on
the LIVE loop`, `/wiki create a page about the daemon port allocator`.

1. If `wiki/` doesn't exist, create it.
2. Gather material from raw sources for the introduced concept —
   `narrative_search`, `narrative_info`, and direct file reads.
3. Write the page directly. Don't pre-narrate the draft and ask the
   operator to paste it — the operator's introduction of the concept
   is authorization to write. Choose a kebab-case filename consistent
   with existing wiki pages; if the operator named the file, use that
   spelling.
4. Apply the protocol's page rules: flat layout, kebab-case links,
   inline provenance (`nid:seq` or file paths) for every non-trivial
   claim, cross-links to existing wiki pages only.
5. Narrate a brief confirmation with the refresh marker (see below) and
   a one-liner summary of what the page covers.

### Refresh / write mode

Guidance contains an imperative aimed at an existing page: `/wiki
update`, `/wiki refresh foo`, `/wiki rewrite bar to include X`,
`/wiki sync daemon.md with current server code`, `/wiki fill the empty
stub at foo.md`.

Scope the work from the guidance:

- **Whole-wiki refresh** (`/wiki update`, no target): run audit first,
  narrate the drift report, then apply fixes page-by-page, narrating
  each page's delta as you go.
- **Single-page refresh** (`/wiki refresh foo`): load `foo.md`, audit
  it, rewrite sections that have drifted, narrate the diff.
- **Targeted edit** (`/wiki update foo to mention X`): narrow edit
  matching the guidance.

Rules for writes:

1. **Only edit files that already exist.** If the guidance refers to a
   page that doesn't exist and doesn't name a filename imperatively,
   switch to read mode and note the gap. If the guidance *does* name
   a filename imperatively with a creation verb, use create mode.
2. **Never edit `index.md`.** Propose index-line changes in narration
   for the operator to apply by hand. Format:
   ```
   Proposed index.md entry for foo.md:
     - [foo](foo.md) — one-line summary
   ```
3. **Narrate before large rewrites.** If a page will be >50% rewritten
   or more than one page is being changed, narrate the plan first,
   then proceed — the operator can interrupt via signal. Small edits
   (section-level or smaller) can proceed without pre-narration, but
   always narrate what you changed after the fact.
4. **Backlink re-reading after any page edit.** When you rewrite
   `foo.md`, grep `wiki/*.md` for links pointing to `foo.md`. For each
   incoming link, re-read the paragraph surrounding the link and
   verify the prose still accurately describes `foo.md`'s updated
   content. If it no longer does, either fix the linking prose (if the
   fix is mechanical) or flag it in narration for the operator.
5. **Preserve human prose.** If an operator-authored paragraph still
   holds, leave it untouched. Write-mode work is targeted at claims
   that have drifted or stubs that need filling — not stylistic
   rewrites for their own sake.
6. **Keep citations fresh.** Every rewritten paragraph that makes a
   non-trivial claim must carry or retain a citation.

## Reality sources

The wiki reflects "current reality" of the current fold. The agent draws
reality from these sources, in rough order of authority:

1. **Code and config in the fold** — the actual state of the project.
2. **Recent narratives** — discovered via `narrative_search` and
   `narrative_info`. Especially useful for decisions and rationale that
   aren't expressed in code.
3. **The wiki itself** — for topics that depend on prior synthesis
   (e.g., design intent, history). But never cite the wiki as evidence
   for a claim in the wiki — that's circular. Always trace to a
   narrative or file.

When refreshing, work backward from the last `/wiki` refresh timestamp
(grep the wiki or `narrative_search` for `"Wiki refreshed"` — see
"Refresh marker" below). Focus on narratives and code that have changed
since then.

## Audit output

Structure drift reports like this (omit empty sections):

```markdown
**Wiki audit** — {page or "full"} — {timestamp}

### Drifted claims
- `foo.md`: "X does Y" — cited `daemon/server.ts:42` but that line now
  does Z. [suggested rewrite: "X does Z"]

### Unauditable claims
- `bar.md`: "Historically Y was preferred" — no provenance.

### Broken links
- `baz.md` links to `quux.md` which does not exist.

### Stubs
- `empty-page.md` has no content beyond its header.

### Missing coverage
- Recent narrative claude-abc:33 discusses the new memory subsystem at
  length. `memory.md` doesn't mention these changes.

### Suggested cross-links
- `foo.md` paragraph 3 should probably link to `bar.md` (current
  mention is in plain prose).

### Suggested index entries
- (agent never edits index.md; list proposed one-liners here)
```

Refresh output follows the same structure but with an additional
**Applied** section listing the files and sections the agent actually
modified.

## Refresh marker

After any write-mode invocation, narrate a marker line so future
`/wiki` passes can locate the last refresh:

```
**Wiki refreshed** — {timestamp} — {N pages modified} ({guidance})
```

This is the `narrative_search` anchor for "when was the wiki last
synced with reality." Audit mode narrates its own marker:

```
**Wiki audited** — {timestamp} — {N pages checked}
```

## Quick reference

| Intent in guidance | Mode | Touches files? |
|---|---|---|
| Question, "tell me about X" | Read | No |
| `audit`, `check`, `what's stale` | Audit | No |
| `update`, `refresh`, `rewrite`, `apply`, `write`, `fill`, `sync` (existing page) | Refresh | Yes, existing files only |
| `seed`, `create`, `start`, `add` + **operator-introduced concept** | Create | Yes, new file |
| Concept mention in a question, no existing page | Read + footer note | No |

## Wiki access tools

Beyond reading wiki files directly off disk, three MCP tools expose the
wiki as a first-class, provenance-stamped surface — usable from any
fold, reaching both this fold's wiki and the `brane` package wiki:

- **`list_wiki`** — catalog of pages: slug, human-authored description
  (from page frontmatter, else the first prose line), and `source`.
- **`read_wiki`** — fetch a page by slug (or one section via `anchor`),
  with the page's TOC and a `slug` / `slug#anchor` citation.
- **`search_wiki`** — semantic + keyword search over wiki content,
  returning chunk-level `slug#anchor` hits, like `narrative_search` but
  over the wikis. Its index self-syncs on call.

Pages may carry a `description:` (and optional `title:`) in `---`
frontmatter; `list_wiki` surfaces it verbatim (human-authored, never
AI-synthesized). See the [memory](memory.md) protocol for the full
consultation procedure.

## Related protocols

- **[LIVE_loop](LIVE_loop.md)** — the communication loop this runs in.
- **[memory](memory.md)** — `narrative_search` and `search_wiki` are the
  primary tools for reality-sync during refresh.
- **[digest](digest.md)** — time-windowed syntheses; wiki pages can
  reference digests as provenance, and a digest can point at wiki pages
  for concept-level context.
