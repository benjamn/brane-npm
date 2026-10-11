/**
 * Registering a fold — the one implementation behind `POST /api/folds`,
 * `brane fold`, and `brane absorb --fold`.
 *
 * Two callers, one rule with one switch. A phone on the tailnet must not be
 * able to make `/` or `/etc` a spawn point, so a remote client's folds are
 * confined to the operator's home directory. The operator's own shell is
 * not so limited — `brane fold /Volumes/scratch/project` has always worked —
 * and now that the CLI reaches this through the daemon, "the operator's own
 * shell" has to be recognized on the wire. It is recognized as **loopback**:
 * the CLI always talks to `127.0.0.1` (`buildDaemonBaseUrl`), and nothing
 * outside this machine can. The route decides `confineToHome` from
 * `req.socket.remoteAddress`; this module only applies it.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";
import { fromPortablePath, toPortablePath, getBraneId } from "./db/schema.js";
import { getConfig } from "./commands/config.js";

export interface FoldRow {
  path: string;
  created_at: number;
  last_spawned: number | null;
  brane_id: string | null;
  archived: number | null;
}

/** A registration the daemon refuses. `status` is the HTTP status the route
 *  answers with — 400 for a bad path, 403 for one outside the caller's reach. */
export class FoldRegistrationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message);
  }
}

export interface RegisterFoldOptions {
  /** Refuse paths outside `$HOME` (and `$HOME` itself). True for any client
   *  that is not on loopback. */
  confineToHome: boolean;
  /** Brane to bind the fold to. On an existing fold this *updates* the
   *  binding (`brane fold --brane`, and absorb tagging a fold with the
   *  brane it imports into); on a new one it replaces the default
   *  (`config default.brane` → home brane). */
  braneId?: string;
  /** Injected home directory, for tests. */
  home?: string;
}

/** The pure decision: is `absolute` a path this caller may register? Exported
 *  so the rule can be pinned without a database. Returns the refusal, or
 *  `null` when the path is allowed. */
export function foldPathRefusal(
  absolute: string,
  opts: { confineToHome: boolean; home?: string },
): FoldRegistrationError | null {
  const home = opts.home ?? homedir();
  if (opts.confineToHome) {
    if (absolute !== home && !absolute.startsWith(home + "/")) {
      return new FoldRegistrationError(
        `Folds must live under your home directory (${home})`,
        403,
      );
    }
    if (absolute === home) {
      return new FoldRegistrationError(
        "Refusing to fold your home directory itself; pick a subdirectory",
        403,
      );
    }
  }
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    return new FoldRegistrationError(`Not a directory: ${absolute}`, 400);
  }
  return null;
}

/** Register `rawPath` (absolute or `~/portable`) as a fold. Idempotent:
 *  re-registering an existing fold un-archives it and, when `braneId` is
 *  given, rebinds it; otherwise it is a no-op. Never deletes. */
export function registerFold(
  db: Database.Database,
  rawPath: string,
  opts: RegisterFoldOptions,
): { fold: FoldRow; created: boolean } {
  const absolute = resolve(fromPortablePath(rawPath.trim()));
  const refusal = foldPathRefusal(absolute, opts);
  if (refusal) throw refusal;

  const portable = toPortablePath(absolute);
  const existing = db.prepare("SELECT * FROM folds WHERE path = ?").get(portable) as
    | FoldRow
    | undefined;
  if (existing) {
    if (existing.archived) {
      db.prepare("UPDATE folds SET archived = 0 WHERE path = ?").run(portable);
    }
    if (opts.braneId && opts.braneId !== existing.brane_id) {
      db.prepare("UPDATE folds SET brane_id = ? WHERE path = ?").run(opts.braneId, portable);
    }
  } else {
    const braneId = opts.braneId ?? getConfig("default.brane", db) ?? getBraneId(db);
    db.prepare(
      "INSERT INTO folds (path, created_at, brane_id, archived) VALUES (?, ?, ?, 0)",
    ).run(portable, Date.now(), braneId);
  }
  const fold = db.prepare("SELECT * FROM folds WHERE path = ?").get(portable) as FoldRow;
  return { fold, created: !existing };
}
