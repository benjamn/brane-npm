# Memory and Search Ranking

How narrative history is indexed for semantic search, and how hybrid search ranks what it finds.

## Memory System

The memory system provides semantic search across narrative history:

- **Vector embeddings** via `onnxruntime-node` directly (bge-small-en-v1.5, 384-dim) — `embedder.ts` does the four steps brane used from `@huggingface/transformers` (tokenize → ONNX session → masked mean pool → L2 normalize), producing vectors identical to the pipeline it replaced (worst cosine 0.9999996), so existing `memory_vec` rows stay valid. Tokenization is `wordpiece.ts`, a WordPiece port whose ids match transformers.js exactly. The model cache layout (`~/.brane/models/<repo>/<file>`) is unchanged, so existing caches carry over.
- **FTS5 full-text search** for keyword matching
- **Hybrid search** combining both approaches — see [Search Ranking](#search-ranking)
- **Auto-indexing** of new events on first search
- CLI: `brane memory search <query>`, `brane memory log`, `brane memory index`
- MCP: `narrative_search` and `narrative_info` tools

## Search Ranking

`searchHybrid` (`src/memory/storage.ts`) fuses **three ranked arms**, and that it
fuses *ranks* rather than *scores* is the whole design.

| Arm | Query | For |
|---|---|---|
| ALL | `prepareFtsQuery` — FTS5 implicit AND | A remembered fragment. Precise; returns nothing for a question |
| ANY | `prepareFtsAnyQuery` — content terms ORed | A question. Always answers; ranks loosely |
| vector | KNN over `memory_vec` | Rows sharing no terms with the query at all |

Each contributes `weight / (RRF_K + rank)`; the fused total is then multiplied by
how much of the query the row actually contains.

**Scores from different arms are not comparable, and pretending otherwise
inverted the ranking.** The vector arm's number is a cosine — measured across
this archive it spans 0.62–0.73 for *everything*, a band so narrow it barely
orders anything — while the lexical arms' is a squashed bm25 topping out near
0.7 for an excellent hit. Blending those, plus a flat `+0.5` awarded for **any
single** query term appearing, produced the failure this replaced: for
`self-inflicted instance restarted the daemon four times today`, the only chunk
in 43,876 containing all eight terms came back **11th**, behind ten one-line
operator signals ("Restart* daemon", "Daemon is restarted") that each held one
word and sat near the query in embedding space. Over 60 verbatim quotations
pulled from real events, the source ranked first **50%** of the time; under rank
fusion, **90%** (top-10: 85% → 98%).

Four things are less obvious than they look:

**Coverage ranks; it does not gate.** A row is credited for the *fraction* of
query terms it holds — 1-of-8 and 8-of-8 used to score identically. But
qualifying as lexical evidence is a **count** (`MIN_TERM_HITS`), not a fraction,
because a fraction punishes long queries for being long: a narration matching 2
of 8 terms of a paraphrased question is real evidence that a 50% gate discards.

**The ANY arm exists because AND silently disables half the search.** No chunk
contains all thirteen words of a natural-language question, so the strict arm
returns zero candidates exactly when the query is hardest — leaving the vector
arm alone, which on this corpus finds a quotation's own source only a third of
the time. Stopwords are dropped from ANY (ORed, `the` matches most of the
archive) and kept in ALL, where every term is a restriction and narrows for
free.

**The length penalty is gated on lexical evidence, not on `match`.** They differ
for precisely the rows it exists to catch: a two-character chunk sitting close to
the query clears `MIN_SEMANTIC_SCORE`, gets tagged `semantic`, and would sail
past a `!match` guard. Similarity to a very short string is cheap, and is not
evidence that the string answers anything.

**The `weak` floor is relative.** A fused rank has no absolute meaning to
threshold against — it depends on how many arms returned the row and how deep
each went — so the old `score >= 0.35` constant would pass everything or nothing
as `limit` moved. Quoted phrases remain the one filter allowed to return nothing;
every other path still degrades to best-effort guesses rather than a blank page.

`src/test/search-fusion.test.ts` pins each defect as the smallest corpus that
reproduces it, with hand-chosen vectors. Deliberately **not** an aggregate
accuracy figure: the same probe read 52%, 50% and 37% across one afternoon
purely as new events were indexed, so a percentage over the live archive would be
a flaky test. A percentage says something regressed; these say which thing.
