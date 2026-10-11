# Cost Ledger

Each narrative card shows a cumulative cost (`narratives.cost_amount` /
`cost_unit`), sampled every 20 s for MCP-connected narratives from the
harness's own usage log — a Claude JSONL, goose's SQLite, a codex rollout.
Those logs belong to the harness, which may purge them, and `--fork-session`
copies a predecessor's messages (ids included) into the successor's file. Both
facts bear on the same question: *who gets credited for a message, and does
the answer survive the file going away?*

`usage_ledger` is the answer. The sampler writes what it read into the ledger
and reads the narrative's total back **from the ledger**, never from the
transcripts directly:

| row kind | key | written by | rule |
|---|---|---|---|
| entry | `<agent>:<message id>` | adapters with `readUsageEntries` (claude) | `INSERT OR IGNORE` — the first narrative to insert a key keeps the credit |
| session high-water | `session:<agent>:<session id>` | every other adapter, via its `readUsage` | `amount = MAX(old, new)` |

The primary key is the dedup. A message fork-copied into a later session, or
into another narrative, is a no-op on insert — and so is re-reading it after
the file that originally held it has been purged, which is what the older
"per-session totals that never decrease" idea got wrong: credit that is
recomputed from whichever files survive *moves*, and a moved credit plus a
frozen total is a double count. High-water rows are right for the harnesses
that never share history between sessions (codex's counter restarts at zero on
resume), because there is nothing there to mis-credit.

Rows are never deleted, and never re-priced implicitly, so between
re-pricings a ledger sum is monotonic by construction. Entry rows carry the
`model` and token counts that priced them — so a deliberate re-pricing is
possible as an explicit operation (see [Re-pricing](#re-pricing)), which is
precisely what a purged transcript would have made impossible. `cost_amount` caches it, under one transition rule: a column
value above the ledger sum is kept, since it was filled pre-ledger from
transcripts that may already be gone. Id-less `<synthetic>` records key on
their file position — unique and stable for an append-only transcript.
Writes are skipped for a session whose transcript signature hasn't changed,
so an idle session still costs one `stat` per tick.

**A session can change under a running process.** Claude's id is assigned
at launch (`--session-id`), but `/clear`, or `/resume` from inside a session,
moves the same process to a new transcript under an id Claude Code mints
itself. The bridge read `CLAUDE_CODE_SESSION_ID` once at startup and `/clear`
doesn't restart MCP servers, so nothing reported it: one narrative's card sat
at $5.52 while $26.97 went unread, and revive would have resumed the
conversation from before the `/clear`. Each live tick therefore runs
`maybeFollowLiveSession`, which asks the adapter's `liveSessionId` and, on a
change, retires the old id into `session_ids` and moves the pointer. Claude's
answer comes from `~/.claude/sessions/<pid>.json` for the pane's own pid
(`src/claude-live-session.ts`), accepted only if its `pid`, `tmux` session,
`cwd` and `startedAt` (no earlier than the latest spawn or revive) all match.
It is a pull from the one process whose record it is, deliberately not a hook
payload or bridge report: everything in the pane inherits the narrative's bind
secret, including a nested `claude -p`, and a subagent or reconnecting bridge
must have no way to move the pointer. A narrative whose pane is already gone
is not followed; its missed session reaches the ledger only if it is added to
`session_ids` and backfilled.

The 20 s sampler covers MCP-connected narratives plus a 120 s **linger** after
a narrative's last bridge closes — a session's final turns are written to the
transcript *after* MCP teardown, and the linger's few extra ticks are what
catch them. The linger set is in-memory, so a disconnect that straddles a
daemon restart is missed; that case — and every session that ended before the
ledger existed — reaches the ledger through **`brane cost backfill`**
(`POST /api/cost/backfill`). It runs in the daemon, like spawn and revive,
because the readers resolve transcripts against the daemon's HOME. It walks
narratives **oldest first**, which is what makes the credit assignment right:
an original must insert its messages before the twin that forked from them.
It is synchronous on the daemon's only thread — a cold pass over this
fold's transcripts is a few seconds — which is fine for a command the
operator runs and the reason it must never be wired to startup. It does
not run session-id discovery — fold+time matching against years of
history could adopt a transcript that was never the narrative's — so only
already-bound sessions are read. `--dry-run` reports the same per-narrative
lines (`readable/bound sessions`, rows and amount it would add, column before
→ after) without writing; a second real run reports 0 changed.

## Re-pricing

`src/cost/pricing.ts` is a substring-keyed table, first match wins, and a
price change reaches the ledger only through **`brane cost reprice`**
(`POST /api/cost/reprice`, `src/cost/reprice.ts`). It re-prices every USD
entry row that has a model and token counts under the current table,
**moves each affected narrative's `cost_amount` by the same delta**, and
broadcasts the new totals. `--dry-run` computes the identical result and
writes nothing. The operator runs it; it is never wired to startup.

| Piece | Where | Does |
|---|---|---|
| `DEFAULT_PRICES` | `src/cost/pricing.ts` | The table. A specific key (`fable-5-1`, `opus-5-5`, `sonnet-5`) sits above its family key, and an entry names its own `cacheRead` when it isn't 0.1× input. Rates last checked against the published pricing page on 2026-09-23 |
| `pricing.json` | `~/.brane/` | Operator overrides, matched **before** the defaults. Appended after them, as they once were, an override for `opus-5-5` could never beat `opus` |
| `LEGACY_PRICES_V1` | `src/cost/pricing.ts` | The table before 2026-09-23, frozen. Never edit it: it describes rows that already exist |
| `recoverCacheWrite1h` | `src/cost/reprice.ts` | The 5-minute / 1-hour split of an old row's `cache_write` |
| `cache_write_1h`, `speed` | `usage_ledger` | Recorded on every new row, so later reprices never have to infer |

Three things are less obvious than they look:

**Old rows lost the cache split, and the amount gives it back.** Rows
written before `cache_write_1h` existed hold 5-minute and 1-hour writes as
one count, and those bill at 1.25× and 2× input. But each amount was
computed by a known table from exactly those tokens, so pricing every write
as 5-minute undershoots it by `0.75 × input × (1-hour tokens)`. A recovered
split is accepted only if it is a whole number of tokens in `[0,
cache_write]` that reproduces the recorded amount. Anything else (a row
priced under an override, say) is reported as unrecoverable and left as
recorded. The first reprice writes the split it recovers. On this machine's
ledger, all 24,075 priced rows recovered.

**The card total moves by the correction; it is not reset to the ledger
sum.** A `cost_amount` above its ledger sum holds pre-ledger cost from
transcripts that may be gone, which is why the sampler keeps it. A reprice
that reset the column would discard that. One that only lowered ledger rows
would change nothing on the card, because the column already sits above the
new sum.

**Fast mode is a multiplier, not a table.** `usage.speed === "fast"` bills
every category at 2× the model's standard rate, with the cache multipliers
on top ($8/$40 on Opus 5.5, $10/$50 on Opus 5 and 4.8). The table can't
express `inference_geo: "us"` (1.1×) or web search ($10 per 1,000). Neither
appears in a transcript here yet.

The first run corrected what three mispriced models had recorded: Fable 5.1
cache reads at 4× the published rate, Opus 5.5 at the general Opus rate,
and Sonnet 5 at Sonnet 4.x's. On a copy of the operator's database that was
4,906 rows over 70 narratives, $4,576.26 → $3,852.50.
