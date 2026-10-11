import type Database from "better-sqlite3";
import { embedBatch } from "./embeddings.js";
import {
  initMemorySchema,
  getLastIndexedSeq,
  setLastIndexedSeq,
  upsertChunks,
  type EmbeddedChunk,
} from "./storage.js";
import { getAgentAdapter, TRACE_RESOLVABLE_AGENTS, type TraceResolution } from "../agents.js";
import { fromPortablePath } from "../db/schema.js";
import type { EventMeta } from "../db/events.js";

export interface IndexStats {
  narratives_scanned: number;
  narratives_indexed: number;
  chunks_created: number;
  traces_resolved: number;
}

interface EventRow {
  narrative_id: string;
  seq: number;
  time: number;
  type: string;
  content: string | null;
}

/** Max events to embed per batch (memory bound). */
const BATCH_SIZE = 64;

/**
 * Cooperative-scheduling bounds for `resolvePendingTraces`. The resolver runs
 * in-process on the daemon's main thread and each resolution does a blocking
 * transcript read, so a large backfill could otherwise starve narrate/listen/
 * terminal. We yield to the event loop between reads and cap reads per pass;
 * resolvable events beyond the cap roll to the next index tick (resolved rows
 * drop out of the gate, so progress stays monotonic).
 */
const RESOLVE_YIELD_EVERY_READS = 16;
const RESOLVE_YIELD_EVERY_ROWS = 2048;
const MAX_RESOLVES_PER_PASS = 2000;

/** Yield control to the event loop so the daemon can service requests. */
const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

interface PendingTraceRow {
  narrative_id: string;
  seq: number;
  content: string;
  source: string | null;
  meta: string | null;
  // Author-narrative columns, joined in so the resolver needs no follow-up
  // lookup. The author is `events.source` (so foreign narrations attribute to
  // the authoring agent, not the host narrative).
  agent_type: string | null;
  fold_path: string | null;
  agent_session_id: string | null;
}

/**
 * Resolve per-message provenance (meta.session.offset + meta.model) for
 * narration/agent_signal events that don't yet have it. Runs *before*
 * embedding and is gated purely on the *absence* of meta.model — never on
 * the embedding cursor — so it both maintains new events and self-heals
 * (backfills) any historical event still missing the attribution, with no
 * events stranded behind a cursor. Idempotent: a resolved event is skipped
 * forever, and agent session logs are immutable so a value never goes stale.
 *
 * meta.session is *author-relative*: each event's author is its `source`
 * narrative, so we resolve against the author's agent/fold/session — which
 * makes foreign narrations attribute to the authoring agent, not the host.
 */
export async function resolvePendingTraces(
  db: Database.Database,
  signal?: AbortSignal,
  opts: { dryRun?: boolean } = {},
): Promise<number> {
  // No trace-capable agent → nothing is ever resolvable; skip the scan.
  if (TRACE_RESOLVABLE_AGENTS.length === 0) return 0;

  // Push every precondition into SQL so we only materialize rows the resolver
  // could actually act on — instead of pulling the whole unresolved backlog
  // into JS to skip most of it. A row qualifies only when:
  //   - its author agent (events.source → narratives) has a resolveTrace
  //     adapter (foreign narrations attribute to the *author*, not the host),
  //   - meta.model is still absent (gate is absence-of-model, never a cursor,
  //     so the resolver self-heals), and
  //   - a session id is available — either the live-stamped meta.session.id or
  //     the author narrative's agent_session_id fallback. Without one there is
  //     no transcript to read, so such rows are pure waste to materialize.
  // The CASE is ordered so json_extract only runs on valid JSON: it *throws*
  // "malformed JSON" on a corrupt blob, which would otherwise abort the pass.
  // appendEvent only writes valid JSON or NULL, so corrupt rows are reachable
  // only via a direct DB edit — they're skipped, not allowed to take down the
  // whole pass.
  const agentPlaceholders = TRACE_RESOLVABLE_AGENTS.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT e.narrative_id AS narrative_id, e.seq AS seq, e.content AS content,
              e.source AS source, e.meta AS meta,
              n.agent_type AS agent_type, n.fold_path AS fold_path,
              n.agent_session_id AS agent_session_id
       FROM events e
       JOIN narratives n ON n.id = e.source
       WHERE e.type IN ('narration', 'agent_signal')
         AND e.content IS NOT NULL AND e.content != ''
         AND n.agent_type IN (${agentPlaceholders})
         AND n.fold_path IS NOT NULL
         AND CASE
               WHEN e.meta IS NOT NULL AND json_valid(e.meta) = 0 THEN 0
               WHEN e.meta IS NOT NULL AND json_extract(e.meta, '$.model') IS NOT NULL THEN 0
               WHEN e.meta IS NOT NULL AND json_extract(e.meta, '$.session.id') IS NOT NULL THEN 1
               WHEN n.agent_session_id IS NOT NULL THEN 1
               ELSE 0
             END = 1`,
    )
    .all(...TRACE_RESOLVABLE_AGENTS) as PendingTraceRow[];

  // Memoize each author's whole-session trace index so a transcript is read and
  // parsed at most once per pass, however many of its events are pending. A
  // `null` (missing/unreadable session file) is cached too, so a dead session
  // isn't re-read for every one of its events.
  const indexCache = new Map<string, Map<string, TraceResolution> | null>();

  // Phase 1: compute all updates with NO DB write lock held (building a trace
  // index does file IO of the agent's own session log, which can be slow).
  // Yields to the event loop around transcript parses and caps parses per pass
  // so this pass can't starve the daemon's main thread (see bounds above).
  const updates: Array<{ narrative_id: string; seq: number; meta: string }> = [];
  let reads = 0;
  for (let i = 0; i < rows.length; i++) {
    if (signal?.aborted) break;
    // Coarse yield so even a long run of cheap (cache-hit) rows can't block.
    if (i > 0 && i % RESOLVE_YIELD_EVERY_ROWS === 0) await yieldToEventLoop();

    const row = rows[i];
    if (!row.agent_type || !row.fold_path) continue; // SQL-guarded; defensive
    const adapter = getAgentAdapter(row.agent_type);
    if (!adapter.buildTraceIndex) continue; // unsupported agent — leave unset

    const meta: EventMeta = row.meta ? (JSON.parse(row.meta) as EventMeta) : {};
    // Prefer the session id stamped live at write time; fall back to the
    // author narrative's current session (best-effort for pre-capture events).
    const sessionId = meta.session?.id ?? row.agent_session_id ?? undefined;
    if (!sessionId) continue; // SQL-guarded; defensive

    const foldPath = fromPortablePath(row.fold_path);
    // JSON-stringify the pair for an unambiguous key - no separator can collide.
    const cacheKey = JSON.stringify([sessionId, foldPath]);
    let index = indexCache.get(cacheKey);
    if (index === undefined) {
      // Cache miss → parse this transcript once (the expensive op). Bound the
      // parses per pass and yield around them; the rest roll to the next tick.
      // Cheap cache-hit lookups below never consume this budget.
      if (reads >= MAX_RESOLVES_PER_PASS) break;
      index = adapter.buildTraceIndex({ sessionId, foldPath });
      indexCache.set(cacheKey, index);
      reads++;
      if (reads % RESOLVE_YIELD_EVERY_READS === 0) await yieldToEventLoop();
    }
    if (!index) continue; // session file gone/unreadable

    const trace = index.get(row.content);
    if (!trace || (!trace.model && !trace.offset)) continue;

    const offset = trace.offset ?? meta.session?.offset;
    meta.session = offset ? { id: sessionId, offset } : { id: sessionId };
    if (trace.model) meta.model = trace.model;

    updates.push({ narrative_id: row.narrative_id, seq: row.seq, meta: JSON.stringify(meta) });
  }

  if (opts.dryRun || updates.length === 0) return updates.length;

  // Phase 2: apply every update in a single transaction (atomic, minimal WAL
  // churn, short lock window). Purely additive — never touches content.
  const stmt = db.prepare("UPDATE events SET meta = ? WHERE narrative_id = ? AND seq = ?");
  const apply = db.transaction((items: typeof updates) => {
    for (const u of items) stmt.run(u.meta, u.narrative_id, u.seq);
  });
  apply(updates);
  return updates.length;
}

/**
 * Run incremental indexing across all narratives in brane.db.
 *
 * For each narrative, compares max(seq) against last_indexed_seq cursor.
 * Only embeds events with seq > cursor. Idempotent — safe to run repeatedly.
 */
export async function runIndex(
  db: Database.Database,
  rebuild: boolean,
  signal?: AbortSignal,
): Promise<IndexStats> {
  initMemorySchema(db);

  // Resolve per-message model/session provenance before embedding. Gated on
  // absence of meta.model, independent of the embedding cursor (see fn docs).
  const tracesResolved = await resolvePendingTraces(db, signal);

  if (rebuild) {
    db.exec(`
      DELETE FROM memory_chunks;
      DELETE FROM memory_vec;
      DELETE FROM memory_content_df;
      DELETE FROM memory_stats;
      DELETE FROM memory_cursors;
      INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
    `);
  }

  // Find all narratives with events
  const narratives = db
    .prepare(
      `SELECT narrative_id, MAX(seq) as max_seq, COUNT(*) as event_count
       FROM events
       GROUP BY narrative_id`,
    )
    .all() as Array<{ narrative_id: string; max_seq: number; event_count: number }>;

  let narrativesIndexed = 0;
  let totalChunks = 0;

  for (const nar of narratives) {
    if (signal?.aborted) break;
    const lastSeq = getLastIndexedSeq(db, nar.narrative_id);
    if (nar.max_seq <= lastSeq) continue;

    // Fetch unindexed events with textual content
    const events = db
      .prepare(
        `SELECT narrative_id, seq, time, type, content
         FROM events
         WHERE narrative_id = ? AND seq > ? AND content IS NOT NULL AND content != ''
         ORDER BY seq ASC`,
      )
      .all(nar.narrative_id, lastSeq) as EventRow[];

    if (events.length === 0) {
      // No textual events, but advance cursor to avoid re-scanning
      setLastIndexedSeq(db, nar.narrative_id, nar.max_seq);
      continue;
    }

    console.log(
      `[${narrativesIndexed + 1}] Embedding ${nar.narrative_id} (${events.length} events)...`,
    );

    // Process in batches
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      if (signal?.aborted) break;
      const batch = events.slice(i, i + BATCH_SIZE);
      const texts = batch.map((e) => e.content!);
      const vectors = await embedBatch(texts);

      const chunks: EmbeddedChunk[] = batch.map((e, j) => ({
        id: `${e.narrative_id}-${e.seq}`,
        narrative_id: e.narrative_id,
        seq: e.seq,
        content: e.content!,
        time: e.time,
        vector: vectors[j],
      }));

      upsertChunks(db, chunks);
      totalChunks += chunks.length;
    }

    setLastIndexedSeq(db, nar.narrative_id, nar.max_seq);
    narrativesIndexed++;
  }

  return {
    narratives_scanned: narratives.length,
    narratives_indexed: narrativesIndexed,
    chunks_created: totalChunks,
    traces_resolved: tracesResolved,
  };
}

/**
 * Check if any narrative has unindexed events.
 * Cheap check — no embedding, just seq comparisons.
 */
export function hasUnindexedEvents(db: Database.Database): boolean {
  initMemorySchema(db);

  const rows = db
    .prepare(
      `SELECT e.narrative_id, MAX(e.seq) as max_seq
       FROM events e
       LEFT JOIN memory_cursors mc ON mc.narrative_id = e.narrative_id
       WHERE e.seq > COALESCE(mc.last_seq, 0)
       GROUP BY e.narrative_id
       LIMIT 1`,
    )
    .all();

  return rows.length > 0;
}
