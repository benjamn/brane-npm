/** Operator approvals of `home` and `fold` protocol files, pinned to content
 *  (docs/protocols.md#approval). A file outside `brane` is in force only
 *  while a live row holds its path and its current sha256; an edit changes
 *  the hash, and the file is ignored again until the operator approves the
 *  new text. Approving a path revokes its earlier rows. Nothing is deleted. */

import type Database from "better-sqlite3";
import { sha256 } from "../protocols.js";

export interface ProtocolApproval {
  path: string;
  sha256: string;
  content: string;
  approved_at: number;
  approved_by: string;
}

/** The live approval for a path (portable form), if any. */
export function liveApproval(db: Database.Database, path: string): ProtocolApproval | undefined {
  return db
    .prepare(
      "SELECT path, sha256, content, approved_at, approved_by FROM protocol_approvals WHERE path = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get(path) as ProtocolApproval | undefined;
}

/** Every live approval, keyed by path, without the approved text: what a
 *  library scan checks against on every protocol read. */
export function liveApprovals(db: Database.Database): Map<string, Omit<ProtocolApproval, "content">> {
  const rows = db
    .prepare("SELECT path, sha256, approved_at, approved_by FROM protocol_approvals WHERE revoked_at IS NULL ORDER BY id")
    .all() as Array<Omit<ProtocolApproval, "content">>;
  return new Map(rows.map((r) => [r.path, r]));
}

/** Approve `content` at `path`, revoking whatever was approved there before. */
export function approveProtocol(
  db: Database.Database,
  path: string,
  content: string,
  by: string,
  now: number = Date.now(),
): ProtocolApproval {
  const row: ProtocolApproval = { path, sha256: sha256(content), content, approved_at: now, approved_by: by };
  db.transaction(() => {
    db.prepare("UPDATE protocol_approvals SET revoked_at = ? WHERE path = ? AND revoked_at IS NULL").run(now, path);
    db.prepare(
      "INSERT INTO protocol_approvals (path, sha256, content, approved_at, approved_by) VALUES (?, ?, ?, ?, ?)",
    ).run(row.path, row.sha256, row.content, row.approved_at, row.approved_by);
  })();
  return row;
}

/** Withdraw the approval at `path`. Returns whether there was one. */
export function revokeProtocolApproval(db: Database.Database, path: string, now: number = Date.now()): boolean {
  return db.prepare("UPDATE protocol_approvals SET revoked_at = ? WHERE path = ? AND revoked_at IS NULL").run(now, path).changes > 0;
}
