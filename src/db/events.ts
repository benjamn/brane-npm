import type Database from "better-sqlite3";

/**
 * Author-relative pointer into the originating agent's own session log.
 * `id` is the agent session identifier; `offset` pins the specific message
 * within that log (per-adapter scheme — for claude, the assistant message
 * UUID). See protocols/LIVE_loop.md and the AgentAdapter.resolveTrace docs.
 * Always describes the *author* of the message (top-level `source`), never
 * the host narrative — so foreign narrations point at the author's session.
 */
export interface EventSession {
  id: string;
  offset?: string;
}

/**
 * Per-event metadata (the `events.meta` JSON column). Open-ended, but the
 * known keys are typed. `session`/`model` are derived provenance: `session`
 * is captured live by the authoring bridge, `model` is resolved through the
 * pointer by the memory indexer. `session_id`/`summary` are the legacy
 * narrate inputs that update the narrative row (revive/title) — distinct
 * layer, kept for back-compat.
 */
export interface EventMeta {
  summary?: string;
  /** On a `human_signal` from a device under the verification gate: the
   *  proof that let it through, by credential row id (or `oidc:<sub>`),
   *  method and time (docs/passkeys.md, "The record"). Absent with the gate
   *  off, and from this machine's shell, which is never gated. */
  verified?: { by: string; method: string; at: number };
  session_id?: string;
  session?: EventSession;
  model?: string;
  [key: string]: unknown;
}

/** DB row / API event — schema matches the API output directly */
export interface NarrativeEvent {
  seq: number;
  time: number;
  type: string;
  content?: string;
  content_type?: string;
  source?: string;
  re?: Array<number | string>;
  payloads?: string[];
  meta?: EventMeta;
}

/** Raw DB row (re/payloads are JSON strings) */
interface EventRow {
  narrative_id: string;
  seq: number;
  time: number;
  type: string;
  content: string | null;
  content_type: string | null;
  source: string | null;
  re: string | null;
  payloads: string | null;
  meta: string | null;
}

/** Convert a raw DB row to a clean API event (parse JSON, omit nulls) */
function toApiEvent(row: EventRow): NarrativeEvent {
  const evt: NarrativeEvent = {
    seq: row.seq,
    time: row.time,
    type: row.type,
  };
  if (row.content) evt.content = row.content;
  if (row.content_type) evt.content_type = row.content_type;
  if (row.source) evt.source = row.source;
  if (row.re) {
    try { evt.re = JSON.parse(row.re); } catch { /* ignore */ }
  }
  if (row.payloads) {
    try { evt.payloads = JSON.parse(row.payloads); } catch { /* ignore */ }
  }
  if (row.meta) {
    try { evt.meta = JSON.parse(row.meta); } catch { /* ignore */ }
  }
  return evt;
}

export function appendEvent(
  db: Database.Database,
  narrativeId: string,
  type: string,
  opts: {
    content?: string;
    content_type?: string;
    source?: string;
    re?: Array<number | string>;
    payloads?: string[];
    meta?: EventMeta;
  } = {},
): NarrativeEvent {
  const maxSeqRow = db
    .prepare("SELECT MAX(seq) as max_seq FROM events WHERE narrative_id = ?")
    .get(narrativeId) as { max_seq: number | null };

  const seq = (maxSeqRow.max_seq ?? 0) + 1;
  const time = Date.now();
  const re = opts.re && opts.re.length > 0 ? JSON.stringify(opts.re) : null;
  const payloads =
    opts.payloads && opts.payloads.length > 0 ? JSON.stringify(opts.payloads) : null;
  const meta = opts.meta ? JSON.stringify(opts.meta) : null;

  db.prepare(
    `INSERT INTO events (narrative_id, seq, time, type, content, content_type, source, re, payloads, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(narrativeId, seq, time, type, opts.content ?? null, opts.content_type ?? null, opts.source ?? null, re, payloads, meta);

  return toApiEvent({
    narrative_id: narrativeId,
    seq,
    time,
    type,
    content: opts.content ?? null,
    content_type: opts.content_type ?? null,
    source: opts.source ?? null,
    re,
    payloads,
    meta,
  });
}

export function readEventsSince(
  db: Database.Database,
  narrativeId: string,
  sinceSeq: number,
  limit?: number,
): NarrativeEvent[] {
  const sql = limit !== undefined
    ? `SELECT * FROM events WHERE narrative_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
    : `SELECT * FROM events WHERE narrative_id = ? AND seq > ? ORDER BY seq ASC`;
  const params = limit !== undefined
    ? [narrativeId, sinceSeq, limit]
    : [narrativeId, sinceSeq];
  const rows = db.prepare(sql).all(...params) as EventRow[];
  return rows.map(toApiEvent);
}

export function readEventsBefore(
  db: Database.Database,
  narrativeId: string,
  beforeSeq: number,
  limit: number,
): NarrativeEvent[] {
  const rows = db.prepare(
    `SELECT * FROM events WHERE narrative_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
  ).all(narrativeId, beforeSeq, limit) as EventRow[];
  // Reverse to return in ascending seq order
  rows.reverse();
  return rows.map(toApiEvent);
}

/**
 * The events with these exact seqs, ascending — an indexed lookup rather than a
 * scan, for the caller that already knows which rows it wants. `src/export.ts`
 * uses it for an excerpt: exporting two messages out of ten thousand should
 * cost two rows, not ten thousand.
 *
 * Chunked because SQLite bounds the number of bound parameters in one
 * statement, and a selection has no ceiling imposed on it anywhere else.
 */
export function readEventsBySeqs(
  db: Database.Database,
  narrativeId: string,
  seqs: number[],
): NarrativeEvent[] {
  if (seqs.length === 0) return [];
  const CHUNK = 500;
  const rows: EventRow[] = [];
  for (let i = 0; i < seqs.length; i += CHUNK) {
    const chunk = seqs.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(
      ...(db
        .prepare(
          `SELECT * FROM events WHERE narrative_id = ? AND seq IN (${placeholders}) ORDER BY seq ASC`,
        )
        .all(narrativeId, ...chunk) as EventRow[]),
    );
  }
  // Chunks are each ascending; a multi-chunk read has to be sorted as a whole.
  rows.sort((a, b) => a.seq - b.seq);
  return rows.map(toApiEvent);
}

export interface ReadEventsOpts {
  after?: number;
  before?: number;
  tail?: number;
}

/**
 * Flexible event query supporting after (lower bound), before (upper bound),
 * and tail (last N). All bounds are exclusive. Results always in ascending
 * seq order.
 *
 * Combinations:
 * - {} → all events (like after: 0)
 * - { after: N } → events where seq > N
 * - { before: N } → events where seq < N
 * - { after: A, before: B } → events where seq > A AND seq < B
 * - { tail: N } → last N events
 * - { tail: N, before: B } → last N events where seq < B (backward pagination)
 * - { after: A, tail: N } → last N events where seq > A
 * - { after: A, before: B, tail: N } → last N events in range (A, B)
 */
export function readEvents(
  db: Database.Database,
  narrativeId: string,
  opts: ReadEventsOpts,
): NarrativeEvent[] {
  const { after, before, tail } = opts;

  const conditions = ["narrative_id = ?"];
  const params: (string | number)[] = [narrativeId];

  if (after !== undefined && after > 0) {
    conditions.push("seq > ?");
    params.push(after);
  }
  if (before !== undefined) {
    conditions.push("seq < ?");
    params.push(before);
  }

  const where = conditions.join(" AND ");

  if (tail !== undefined) {
    if (tail <= 0) return [];
    // Fetch last N matching rows (DESC), then reverse for ASC order
    const sql = `SELECT * FROM events WHERE ${where} ORDER BY seq DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, tail) as EventRow[];
    rows.reverse();
    return rows.map(toApiEvent);
  }

  const sql = `SELECT * FROM events WHERE ${where} ORDER BY seq ASC`;
  const rows = db.prepare(sql).all(...params) as EventRow[];
  return rows.map(toApiEvent);
}

export function getMinSeq(db: Database.Database, narrativeId: string): number {
  const row = db
    .prepare("SELECT MIN(seq) as min_seq FROM events WHERE narrative_id = ?")
    .get(narrativeId) as { min_seq: number | null };
  return row.min_seq ?? 0;
}

export function getMaxSeq(db: Database.Database, narrativeId: string): number {
  const row = db
    .prepare("SELECT MAX(seq) as max_seq FROM events WHERE narrative_id = ?")
    .get(narrativeId) as { max_seq: number | null };
  return row.max_seq ?? 0;
}
