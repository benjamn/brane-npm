/**
 * Archived branes: hidden, never removed.
 *
 * A brane is only the `brane_id` its narratives share, so archiving one is a
 * row in `branes` with `archived = 1`. What it hides:
 *
 * - the brane, from `GET /api/branes` unless `archived=1` (the switcher's
 *   "Show N archived" asks for them, with the flag);
 * - its ended narratives, from every listing that names no brane — the app's
 *   All branes, `brane list`, `brane memory log`.
 *
 * Naming the brane (`brane_ids`, the switcher selecting it) still shows all of
 * it, and `list_branes` still returns it, flagged, so an agent can reach it on
 * purpose. A narrative that is still running is never hidden by its brane:
 * archiving one narrative is refused while it runs for the same reason
 * (src/daemon/archive-gate.ts), and an agent may spawn into an archived brane.
 *
 * Two branes cannot be archived: the daemon's home brane, which every spawn
 * without a brane lands in, and the last one not already archived, which
 * would leave All branes empty.
 */
import type Database from "better-sqlite3";

/** The ids of every archived brane. */
export function archivedBraneIds(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT brane_id FROM branes WHERE archived = 1").all() as Array<{ brane_id: string }>;
  return new Set(rows.map((r) => r.brane_id));
}

/** A WHERE clause over `narratives` (unaliased columns) that drops ended
 *  narratives of archived branes, for a listing that names no brane. A
 *  narrative counts as running if its status is not `ended` or its agent is
 *  on the bridge (`connected`, bound as parameters). `alias` qualifies the
 *  columns when the query joins another table. */
export function visibleUnscopedClause(connected: Iterable<string>, alias = ""): { sql: string; params: string[] } {
  const ids = [...connected];
  const a = alias ? `${alias}.` : "";
  const live = ids.length ? ` OR ${a}id IN (${ids.map(() => "?").join(",")})` : "";
  return {
    sql: `(${a}brane_id NOT IN (SELECT brane_id FROM branes WHERE archived = 1) OR ${a}status IS NOT 'ended'${live})`,
    params: ids,
  };
}

/** Why `braneId` cannot be archived, as a status and message, or null when
 *  it can. Unarchiving is refused only for a brane that does not exist. */
export function braneArchiveRefusal(
  db: Database.Database,
  braneId: string,
  archived: boolean,
  homeBraneId: string,
): { status: 400 | 404; error: string } | null {
  const exists = db.prepare("SELECT 1 FROM narratives WHERE brane_id = ? LIMIT 1").get(braneId);
  if (!exists) return { status: 404, error: `No brane ${braneId}` };
  if (!archived) return null;
  if (braneId === homeBraneId) {
    return { status: 400, error: `${braneId} is this daemon's home brane, where every spawn without a brane lands; it can't be archived` };
  }
  const hidden = archivedBraneIds(db);
  const remaining = (db.prepare("SELECT DISTINCT brane_id FROM narratives").all() as Array<{ brane_id: string }>)
    .filter((r) => r.brane_id !== braneId && !hidden.has(r.brane_id));
  if (remaining.length === 0) {
    return { status: 400, error: `${braneId} is the last brane not archived; archiving it would leave nothing to show` };
  }
  return null;
}

/** Archive or unarchive `braneId`, writing its row on first use. */
export function setBraneArchived(db: Database.Database, braneId: string, archived: boolean, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO branes (brane_id, archived, archived_at) VALUES (?, ?, ?)
     ON CONFLICT(brane_id) DO UPDATE SET archived = excluded.archived, archived_at = excluded.archived_at`,
  ).run(braneId, archived ? 1 : 0, archived ? now : null);
}
