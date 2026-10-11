/** The mention ledger: who was addressed, from where, and what became of it.
 *
 *  Two kinds of state share a row, on purpose.
 *
 *  The **mention** — `mentioned_nid`, `src_narrative`, `src_seq`, `author`,
 *  `time` — is derived data. A re-scan of the event log reproduces it exactly,
 *  because `UNIQUE (mentioned_nid, src_narrative, src_seq)` makes a second
 *  insert a no-op. Rebuild freely, but only additively (see the schema
 *  comment: rowids are stable and the row carries state).
 *
 *  **`sent_at` and `seen_at`** are not derived from anything. They record what
 *  passed between the daemon and one agent, which no amount of re-reading the
 *  log can recompute, and they answer two different questions:
 *
 *    `sent_at` — handed over. Governs whether a parked `listen` resolves now,
 *    so a mention wakes an agent exactly once and can't spin.
 *
 *    `seen_at` — demonstrably attended to, evidenced by the agent reading the
 *    narrative the mention was written in. Delivery alone doesn't set it: a
 *    frame can arrive and still go unnoticed — buried in a long result, lost
 *    to compaction, or simply not acted on. So a delivered-but-unread mention
 *    keeps reappearing in the receipt.
 *
 *  Both live on the row rather than as a high-water mark per narrative,
 *  because acknowledgment is per *source*. Reading narrative B says nothing
 *  about a mention written in C, and a scalar watermark over a shared id space
 *  settles every lower id regardless of origin — silently marking unread
 *  mentions read. NULL → timestamp also makes monotonicity structural: there
 *  is no value that could rewind.
 */

import type Database from "better-sqlite3";

/** A mention as it reaches the agent: a pointer, never a copy of the prose.
 *  The agent reads the source narrative with an ordinary cursor if it wants
 *  context — which keeps a cross-brane mention from leaking text, and keeps
 *  the receipt small enough that a storm stays legible. */
export type MentionRow = {
  id: number;
  /** Where the mention was written — the narrative to go read. */
  src: string;
  /** The event within it. `src:seq` is the citable form. */
  seq: number;
  /** Who wrote it: an author nid, or an operator signal's source ("web"
   *  from the app, "local" from this machine's shell). */
  author: string;
  time: number;
  /** Present only when the mention came from another brane. */
  brane_id?: string;
};

export type RecordMentionsInput = {
  mentionedNids: string[];
  srcNarrative: string;
  srcSeq: number;
  author: string;
  time: number;
};

/** Inserts one row per mentioned nid; returns the nids *newly* recorded.
 *
 *  The return value is the rising edge, and callers use it to decide whom to
 *  wake. A re-scan of an event already in the ledger returns `[]` and wakes
 *  nobody, which is what makes a backfill safe to run against live
 *  narratives. */
export function recordMentions(db: Database.Database, input: RecordMentionsInput): string[] {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO mentions (mentioned_nid, src_narrative, src_seq, author, time)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const fresh: string[] = [];
  for (const nid of input.mentionedNids) {
    const info = stmt.run(nid, input.srcNarrative, input.srcSeq, input.author, input.time);
    if (info.changes === 1) fresh.push(nid);
  }
  return fresh;
}

const SELECT_ROWS = `
  SELECT m.id, m.src_narrative AS src, m.src_seq AS seq, m.author, m.time,
         n.brane_id AS src_brane
  FROM mentions m
  LEFT JOIN narratives n ON n.id = m.src_narrative
`;

function toRows(raw: any[], ownBrane: string | undefined): MentionRow[] {
  return raw.map((r) => ({
    id: r.id as number,
    src: r.src as string,
    seq: r.seq as number,
    author: r.author as string,
    time: r.time as number,
    // Stamped only when it differs, so the common case stays quiet and a
    // cross-brane mention is legible rather than spooky.
    ...(r.src_brane && r.src_brane !== ownBrane ? { brane_id: r.src_brane as string } : {}),
  }));
}

/** Whether a mention is waiting that this agent has not been woken for.
 *
 *  This is the listen predicate, and it reads `sent_at` — not `seen_at`. An
 *  unread mention must keep appearing in receipts without re-waking the agent
 *  every time it parks. */
export function hasUnsentMentions(db: Database.Database, nid: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM mentions WHERE mentioned_nid = ? AND sent_at IS NULL LIMIT 1")
      .get(nid) !== undefined
  );
}

/** What the agent is still owed: everything it hasn't demonstrably read.
 *
 *  `total` counts all of them; `rows` is the capped slice actually shown. The
 *  remainder stays owed and surfaces in later receipts — it just doesn't cost
 *  another wake, because `markSent` covers every pending row, not only the
 *  ones displayed. */
export function pendingMentions(
  db: Database.Database,
  nid: string,
  limit: number,
  ownBrane?: string,
): { rows: MentionRow[]; total: number } {
  const { total } = db
    .prepare("SELECT COUNT(*) AS total FROM mentions WHERE mentioned_nid = ? AND seen_at IS NULL")
    .get(nid) as { total: number };
  if (!total) return { rows: [], total: 0 };
  const raw = db
    .prepare(
      `${SELECT_ROWS} WHERE m.mentioned_nid = ? AND m.seen_at IS NULL ORDER BY m.id DESC LIMIT ?`,
    )
    .all(nid, limit) as any[];
  // Newest first out of the query so the cap keeps the most recent; ascending
  // on the way out so the agent reads them in the order they happened.
  return { rows: toRows(raw.reverse(), ownBrane), total };
}

/** Every mention of this narrative, capped — regardless of either mark, and
 *  moving neither.
 *
 *  This is the recovery surface. Delivery is at-most-once (a tool result can
 *  be dropped by a socket that closes mid-flight), so "settled" must never
 *  mean "unreachable". An agent that suspects it missed something, or that has
 *  restarted with no memory of its cursor, reads here. */
export function allMentions(
  db: Database.Database,
  nid: string,
  limit: number,
  ownBrane?: string,
): MentionRow[] {
  const raw = db
    .prepare(`${SELECT_ROWS} WHERE m.mentioned_nid = ? ORDER BY m.id DESC LIMIT ?`)
    .all(nid, limit) as any[];
  return toRows(raw.reverse(), ownBrane);
}

/** Records that everything currently owed has been handed over.
 *
 *  Covers every pending row, including any the receipt's cap left out —
 *  otherwise the uncapped remainder would re-wake the agent the moment it
 *  parked again, which is the storm the cap exists to prevent. */
export function markSent(db: Database.Database, nid: string, now = Date.now()): void {
  db.prepare("UPDATE mentions SET sent_at = ? WHERE mentioned_nid = ? AND sent_at IS NULL").run(
    now,
    nid,
  );
}

/** Which narratives each of these events mentions.
 *
 *  Keyed `"<src>:<seq>"`, and present only for events that mention someone —
 *  an event with no mentions has no entry, so annotating a batch adds nothing
 *  to the common case. Lets a returned event say what it addresses, right
 *  where the agent reads it, rather than only in a separate receipt. */
export function mentionsInEvents(
  db: Database.Database,
  delivered: Record<string, number[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const stmt = db.prepare(
    "SELECT src_seq, mentioned_nid FROM mentions WHERE src_narrative = ? AND src_seq = ?",
  );
  for (const [src, seqs] of Object.entries(delivered)) {
    for (const seq of seqs) {
      for (const row of stmt.all(src, seq) as Array<{ src_seq: number; mentioned_nid: string }>) {
        (out[`${src}:${row.src_seq}`] ??= []).push(row.mentioned_nid);
      }
    }
  }
  return out;
}

/** Marks mentions read because the agent was handed the very events carrying
 *  them — the acknowledgment that cannot be faked.
 *
 *  Interpreting a mention means going and looking at its source, and an agent
 *  does that by naming the narrative in the cursor it already passes to
 *  `listen`/`narrate`:
 *
 *      { "after": { "self": 42, "claude-4c7289d1": 17 } }
 *
 *  So the evidence and the attention are the same act. An explicit ack tool
 *  would be weaker: an agent can call one reflexively without looking, but it
 *  cannot receive a narrative's events without them landing in its context.
 *
 *  `delivered` maps narrative id → the seqs actually returned, **not** the
 *  cursor bound. Those differ: `before` truncates a range, and `tail: N`
 *  returns the last N events while skipping everything in between. Settling on
 *  `seq > after` would mark mentions read that the read never showed — the
 *  silent drop this whole mechanism exists to prevent. Keys arrive already
 *  resolved ("self" → the real nid), and the agent's own narrative is skipped:
 *  reading your own log is not evidence you looked at someone else's.
 *
 *  Returns how many were acknowledged, for logging. */
export function ackMentionsByRead(
  db: Database.Database,
  nid: string,
  delivered: Record<string, number[]>,
  now = Date.now(),
): number {
  const stmt = db.prepare(
    `UPDATE mentions SET seen_at = ?
     WHERE mentioned_nid = ? AND src_narrative = ? AND src_seq = ? AND seen_at IS NULL`,
  );
  let count = 0;
  for (const [src, seqs] of Object.entries(delivered)) {
    if (src === nid) continue;
    for (const seq of seqs) count += stmt.run(now, nid, src, seq).changes;
  }
  return count;
}

/** The explicit escape hatch: "I've seen these and I am not going to read
 *  those narratives."
 *
 *  Without it, a mention an agent has rightly judged irrelevant reappears in
 *  every receipt forever. Deliberately a parameter on `listen` rather than a
 *  fourth tool — one call, no new vocabulary. */
export function dismissMentions(db: Database.Database, nid: string, now = Date.now()): number {
  return db
    .prepare("UPDATE mentions SET seen_at = ? WHERE mentioned_nid = ? AND seen_at IS NULL")
    .run(now, nid).changes;
}
