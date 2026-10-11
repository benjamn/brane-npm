# Protocol: memory

Agent memory access through semantic search and cross-narrative context loading.

---

## Overview

Agents have access to a memory system that indexes all past agent
conversations. This enables:

1. **Activity Log** — see what's been worked on recently
2. **Semantic Search** — find relevant past discussions by meaning
3. **Cross-Narrative Loading** — pull context from other sessions
4. **Knowledge Discovery** — build understanding across conversations

All memory features are available both as **MCP tools** (for use within
the LIVE loop) and as **CLI commands** (for operator use from the terminal).

## Activity Log

Browse recently active narratives to understand what's been happening.

### Using MCP (`narrative_info`)

```json
{
  "since": "1d",
  "search": "auth",
  "limit": 10
}
```

Returns structured JSON with narrative metadata, event counts, and
relative timestamps. See the [LIVE_loop](LIVE_loop.md) protocol for
full parameter and response documentation.

### Using the CLI

```bash
brane memory log                        # Last 24 hours (default)
brane memory log --since 1w             # Last week
brane memory log --search "auth"        # Filter by content
brane memory log --status active        # Only active narratives
brane memory log --fold .               # Only this fold
brane memory log --limit 5 --json       # JSON output
```

Duration formats: `30m`, `1h`, `2d`, `1w`.

Example output:
```
● claude-4c7289d1  "Daemon refactor"  3m ago  (42 events)
  Summary: Done: added revive API endpoint
○ claude-8b3ef201  "Expo keyboard"    2h ago  (18 events)
  Summary: Implementing multitouch modifier keys
```

Each row shows:
- **Status indicator** — `●` active, `○` inactive
- **Narrative ID** — the agent session
- **Title** — narrative title or agent type fallback
- **Recency** — time since last event
- **Event count** — total events in the time window
- **Summary** — current narrative summary (if set)

### When to Use

- **Situational awareness** — understand what other agents have been
  working on before starting a new task
- **Find a narrative to resume** — locate a recent session by topic
- **Operator overview** — quick scan of recent activity across all agents

## Semantic Search

### Using MCP (`narrative_search`)

```json
{
  "query": "authentication flow",
  "limit": 10
}
```

Returns results ranked by semantic similarity. Auto-indexes unindexed
events on first call. See the [LIVE_loop](LIVE_loop.md) protocol for
full parameter and response documentation.

### Using the CLI

```bash
brane memory search "<query>" --limit 10
```

Returns results ranked by semantic similarity with IDF filtering to
suppress common phrases.

Example output:
```
1. claude-4c7289d1 (seq 45) - Score: 0.62
   "Checking for embedding model..."
   > brane attach claude-4c7289d1
```

Each result shows:
- **Narrative ID** — the agent session where this was found
- **Sequence number** — position in the conversation
- **Score** — semantic similarity (0-1, higher = more relevant)
- **Content preview** — truncated message content

### Query Syntax

`narrative_search` (and `brane memory search`) accept a small query
grammar on top of plain keywords. Parsing is shared by the keyword
(FTS5) layer and the relevance-scoring layer, so the rules below apply
uniformly.

- **Bare terms.** Whitespace-separated words are ANDed together and
  prefix-matched: `daemon restart` matches content containing a
  `daemon…` token *and* a `restart…` token, in any order. Terms
  shorter than 2 characters are dropped as noise.
- **Quoted phrases.** Wrap a span in quotes to require those tokens
  **adjacent and in order**:
  - `"context compaction"` — matches only where the two words appear
    as a phrase.
  - `"context compaction" recovery` — the phrase AND the prefix term
    `recovery`.

  Phrases compose freely with bare terms. Tokens inside a phrase
  bypass the 2-character minimum (you quoted them deliberately).
- **Recognized quote pairs:**

  | Pair  | Codepoints      | Typical source                 |
  |-------|-----------------|--------------------------------|
  | `"…"` | U+0022 / U+0022 | typed straight quotes          |
  | `“…”` | U+201C / U+201D | iOS/macOS smart-quote autosub  |
  | `‘…’` | U+2018 / U+2019 | smart single quotes            |

  ASCII `'` (U+0027) is **deliberately not** a phrase delimiter, so
  contractions and possessives (`don't`, `it's`, `agent's`) keep
  working as ordinary bare terms.
- **Lenient parsing.** An opening quote with no matching closer is
  read to end-of-input rather than rejected — a trailing `"foo bar`
  still searches for the phrase `foo bar`. There is no escape
  mechanism: the first matching closer always ends a phrase.
- **Scoring.** A quoted-phrase hit in a result's content adds a
  larger relevance boost (`+1.0`) than a bare-term hit (`+0.5`),
  because phrase adjacency is much more discriminating evidence.
  Consequence: phrase-bearing results can score above the nominal
  `0…1` similarity range — treat scores as a *ranking signal*, not
  an absolute probability.

### Search Tips

1. **Start with short phrases** — "authentication" outperforms "how does
   the authentication flow work." Embedding models reward concept density.
2. **Try multiple queries** — search is cheap. Run several single-concept
   searches rather than one compound query.
3. **Add qualifiers incrementally** — if a keyword is too broad, add one
   word at a time.
4. **Quote multi-word phrases for exact matches** — see *Query Syntax*
   above for the full grammar (phrases, smart quotes, the apostrophe
   carve-out, and scoring).

## Cross-Brane Search

A single daemon can host multiple branes — typically the caller's home
brane plus one or more *foreign* branes created by `brane absorb`
when importing conversation history from other LLM providers
(ChatGPT exports, earlier brane instances, etc.). Foreign branes can
contain thousands of absorbed narratives that are highly relevant to
a search but invisible by default.

Both `narrative_search` and `narrative_info` default to **the
caller's own brane only**. To reach absorbed history, you must
explicitly pass `brane_ids`.

### Discovery: `list_branes`

Call `list_branes` (no arguments) to see every brane the daemon
hosts. The response is keyed by brane ID, with a top-level `home`
field naming the caller's own brane:

```json
{
  "home": "brane-f66d2b",
  "brane-f66d2b":          { "narrative_count": 348,  "active_count": 4, "absorbed_count": 1,    "last_activity": 1777649907322 },
  "brane-chatgpt-ad15b7":  { "narrative_count": 1031, "active_count": 0, "absorbed_count": 1000, "last_activity": 1776028258570 },
  "brane-import-3e91c4":   { "narrative_count": 221,  "active_count": 0, "absorbed_count": 219,  "last_activity": 1774143494724 }
}
```

The `absorbed_count` field is the strongest signal that a brane is
worth widening the search to: a brane with hundreds or thousands of
absorbed narratives almost certainly holds prior context the home
brane lacks. See the [LIVE_loop](LIVE_loop.md) protocol for full
`list_branes` documentation.

### Pattern: expand on completeness gaps

When a home-brane search returns thin results — few hits, low
scores, or only narratives that *reference* the topic without
discussing it in depth — re-run the search with `brane_ids` covering
the foreign branes:

```json
{
  "query": "authentication flow",
  "brane_ids": ["brane-f66d2b", "brane-chatgpt-ad15b7", "brane-import-3e91c4"]
}
```

The same `brane_ids` parameter exists on `narrative_info`, useful
when you want to browse recent foreign-brane activity rather than
search for a specific phrase.

### When to widen by default

Widen the search proactively (without waiting for thin results) when
the question is about long-running history or design rationale that
predates the current brane: project origins, prior architectural
decisions, abandoned approaches, or anything explicitly framed as
"have we ever…", "what did we decide about…", or "how did we used
to…". For narrow, current-state questions ("what's the schema right
now?"), the home brane is usually sufficient.

Avoid blindly always passing every brane — foreign branes can be
large and noisy, and a focused home-brane query is often higher
signal. Use `list_branes` to make the choice deliberately.

## Wiki Consultation (Required)

Every memory search must also consult the wiki. Wiki files are a
curated, human-maintained knowledge base distinct from the narrative
event log: the narrative archive (`narrative_search`) and the wiki
(`search_wiki`) are **separate indices**, so searching the archive
alone silently misses anything that has been synthesized into wiki
form. The two reach different sources — `narrative_search` over
narrative events, the wiki tools over the `brane` package wiki (brane's
own vantage point, shipped with the install) plus any per-fold wikis.

The rule is simple: whenever you run `narrative_search` or
`narrative_info`, also consult the wiki for the same topic via the
dedicated wiki tools.

### The wiki tools

| Tool | Reach for it to |
|------|-----------------|
| `list_wiki` | Browse the catalog — page slugs, human-authored descriptions, and the `source` of each (package `brane` vs a per-fold wiki). The cheapest way to see what's covered. |
| `read_wiki` | Fetch a page by `slug` (source auto-resolves when unique), or just one section via `anchor`. Returns the page's TOC and a `slug` / `slug#anchor` citation — the wiki analogue of `nid:seq`. |
| `search_wiki` | Semantic + keyword search over wiki content, returning chunk-level `slug#anchor` hits ranked by relevance — like `narrative_search`, but over the wikis. |

All three default to the package wiki plus the caller's fold; pass
`all: true` to widen to every registered fold's wiki. Every result
carries its `source`, so provenance is always explicit — you can never
mistake brane-canonical content for fold-local content.

### Procedure

1. **Search or browse.** Run `search_wiki` for the topic alongside your
   `narrative_search`; or `list_wiki` to scan the catalog when you want
   the lay of the land. Both are cheap.
2. **Read what matches.** `read_wiki` the hit — whole page, or the
   `anchor` section the search returned.
3. **Treat the wiki as authoritative for its scope.** A wiki page
   exists because the operator curated it — it is a synthesis that
   has been reviewed, not a raw narration. If the wiki contradicts
   what archive search surfaces, prefer the wiki while noting the
   conflict in your answer; drift may be a legitimate finding for a
   future `/wiki audit`.
4. **Cite the wiki when you use it, with its source.** Use the
   `slug` / `slug#anchor` citation `read_wiki`/`search_wiki` return, and
   name the `source` when it isn't the package wiki, the same way
   `nid:seq` citations work for narrative sources.

### Why this is mandatory

The wiki captures syntheses that are expensive to re-derive from raw
narrations: a single wiki page can compress dozens of cross-brane
discussions into one audited paragraph. Skipping it means either
re-deriving the synthesis from scratch (wasting tokens and time) or
answering without it (missing the synthesis entirely and regressing
to whatever the archive search happens to surface). Neither is an
acceptable default.

This mandate applies to:

- Questions about any topic covered in the wiki — always.
- Open-ended questions where the wiki *might* cover the topic — check
  before answering.
- `/memory` invocations that ask for a scan of recent activity — still
  check `wiki/index.md` for context, even though the primary output is
  activity-based.

See also the [`/wiki` protocol](wiki.md) for the rules governing how
the wiki itself is read and written.

## Cross-Narrative Context Loading

Listen on another narrative to load its signal history into your context.

### How It Works

```json
{
  "after": {
    "claude-4c7289d1": 0
  },
  "wait": false
}
```

Use `limit` to paginate through long histories, advancing the cursor to
the highest returned seq each time.

### Use Cases

1. **Resume knowledge** — load context from a previous session
2. **Cross-reference** — see what was discussed in related narratives
3. **Build connections** — explore related discussions

### Example Workflow

Using MCP tools (within LIVE loop):
```
1. Search: narrative_search { "query": "authentication flow" }
   -> Finds claude-4c7289d1 (seq 42)

2. Load context: listen { "after": { "claude-4c7289d1": 0 }, "wait": false }
   -> Receive full signal history

3. Synthesize: context is now in your conversation
   -> Reference, build upon, or continue that work
```

Using CLI (from terminal):
```
1. Search: brane memory search "authentication flow"
   -> Finds claude-4c7289d1 (seq 42)

2. Attach: brane attach claude-4c7289d1
   -> Load context interactively
```

## Technical Details

### Storage

- **Engine**: SQLite with sqlite-vec extension
- **Vectors**: sentence-transformer embeddings (384 dimensions)
- **Index**: vec0 virtual table with cosine distance
- **Filtering**: IDF-based penalty for common content
- **Model cache**: `~/.brane/models/` (downloaded on first use)

### Indexing

```bash
brane memory index
```

Indexing is idempotent and safe to run repeatedly. Only processes new or
changed events.

### What Gets Indexed

- Agent narrations and signals from the SQLite events table
- Each message embedded with surrounding context for better retrieval

## Best Practices

1. **Consult the wiki first** — `search_wiki`/`list_wiki`/`read_wiki`
   reach the wiki, which lives in a separate index from
   `narrative_search`; run them before or alongside an archive search
   or you'll miss anything synthesized into wiki form
2. **Search before asking** — check if a topic was discussed before
3. **Load full context** — don't rely only on search snippets
4. **Cross-reference** — multiple narratives may cover the same topic
5. **Widen across branes when context is incomplete** — `narrative_search`
   and `narrative_info` default to the caller's home brane only. Use
   `list_branes` to discover foreign (absorbed) branes and pass their
   IDs via `brane_ids` whenever home-brane results look thin or the
   question concerns history that predates the home brane (see
   *Cross-Brane Search* above)

### Combining Wiki, Log, Search, and Context Loading

```
1. Wiki: search_wiki { "query": "authentication flow" } (and/or list_wiki)
   -> Establish what has already been synthesized on the topic

2. Browse: narrative_info { "since": "1d" }
   -> Spot claude-4c7289d1 working on auth

3. Deep search: narrative_search { "query": "authentication flow" }
   -> Find specific events across all time

4. Load context: listen on claude-4c7289d1 with cursor 0
   -> Pull full history into your session
```

## Limitations

- Semantic gap — embedding model may not capture all relationships
- No terminal history — only narrations/signals are indexed
- **Wiki is a separate index** — `./wiki/*.md` pages are not part of the
  `narrative_search` index; reach them via `search_wiki`/`list_wiki`/
  `read_wiki` (see *Wiki Consultation* above), never expecting them to
  surface in `narrative_search`
- Indexing runs on demand via `brane memory index` or auto-triggers
  on first `narrative_search` call; the wiki index self-syncs on each
  `search_wiki` call (re-embedding only changed sections)

## Related Protocols

- **[LIVE_loop](LIVE_loop.md)** — core communication loop
- **[wiki](wiki.md)** — the curated, human-maintained knowledge base
  that every memory search must consult alongside the narrative
  archive
