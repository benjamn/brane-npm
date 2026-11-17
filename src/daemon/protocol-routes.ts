/**
 * Approving `home` and `fold` protocol files (docs/protocols.md#approval), as
 * functions of the database, the presence gate and who is asking, so the
 * suite can drive them (`src/test/protocol-approval.test.ts`).
 *
 * A file outside `brane` is in force only while the operator has approved
 * its current content. Who may approve:
 *
 * - an **agent** never: the routes are off `AGENT_ROUTES`, and the presence
 *   gate refuses an agent's token unasked besides;
 * - a **device** when the verification gate passes (`approve-protocol`, a
 *   fresh-class act: an approval outlives any window);
 * - **this machine's shell** after the OS's own presence prompt, as for
 *   meld and rotation: a process running as this account is not the
 *   operator, and an agent can reach `daemon.sock` too.
 *
 * The request names the hash of the text the operator was shown; if the
 * file no longer has it, before or after the prompt, nothing is approved.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { askPresence, type Caller, type RouteAnswer } from "./gated-routes.js";
import type { PresenceGate } from "./presence-gate.js";
import { approveProtocol, liveApproval, liveApprovals, revokeProtocolApproval } from "../db/protocol-approvals.js";
import { canonicalDir, loadProtocolLibrary, protocolNamespaces, sha256 } from "../protocols.js";
import { PROTOCOL_NAME_RE, type ProtocolNamespace } from "../shared/protocol-names.js";

/** The body of `POST /api/protocols/approve`: JSON from the CLI, or, when
 *  there is no body, `?path=&sha256=` from the app, whose bodiless request
 *  needs no CORS preflight (docs/request-layer.md). A body wins. */
export function approvalRequest(raw: string, query: URLSearchParams): { body: unknown } | { error: string } {
  if (!raw) return { body: { path: query.get("path"), sha256: query.get("sha256") } };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: "Invalid JSON body" };
  }
}

/** The approval scope for this daemon: home, the built-ins, and every fold
 *  an agent can be in, registered or only recorded on a narrative (a fold
 *  whose registration is gone still shows its pending files in its chats). */
export function approvalScopeFrom(
  db: Database.Database,
  dirs: Omit<ApprovalScope, "folds">,
): ApprovalScope {
  const rows = db
    .prepare("SELECT path FROM folds UNION SELECT fold_path FROM narratives WHERE fold_path IS NOT NULL")
    .all() as Array<{ path: string }>;
  const folds = [...new Set(rows.map((r) => resolve(dirs.fromPortable(r.path))))];
  return { ...dirs, folds };
}

/** Where protocol files may be approved, and how paths are written. */
export interface ApprovalScope {
  /** `~/.brane/protocols`. */
  homeDir: string;
  /** The built-ins, which need no approval. */
  braneDir: string;
  /** Every registered fold, absolute. */
  folds: string[];
  toPortable: (abs: string) => string;
  fromPortable: (portable: string) => string;
}

/** A path that names a protocol file in `home` or in a registered fold's
 *  `.brane/protocols`, or why it doesn't. Only those can be approved: the
 *  table is not a general-purpose allowlist for any file on disk. */
export function approvablePath(
  scope: ApprovalScope,
  raw: unknown,
): { abs: string; portable: string; from: ProtocolNamespace } | { error: string } {
  if (typeof raw !== "string" || raw.length === 0) return { error: "path is required" };
  const abs = resolve(scope.fromPortable(raw));
  const file = basename(abs);
  if (!file.endsWith(".md") || !PROTOCOL_NAME_RE.test(file.slice(0, -".md".length))) {
    return { error: `${raw} is not a protocol file (<name>.md)` };
  }
  const dir = canonicalDir(dirname(abs));
  if (dir === canonicalDir(scope.homeDir)) return { abs, portable: scope.toPortable(abs), from: "home" };
  if (scope.folds.some((f) => canonicalDir(join(f, ".brane", "protocols")) === dir)) {
    return { abs, portable: scope.toPortable(abs), from: "fold" };
  }
  return { error: `${raw} is not in ~/.brane/protocols or a known fold's .brane/protocols` };
}

function readText(abs: string): string | null {
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/** `POST /api/protocols/approve` `{ path, sha256 }`. */
export async function approveProtocolRoute(
  deps: { db: Database.Database; gate: Pick<PresenceGate, "check" | "refuse">; scope: ApprovalScope },
  caller: Caller,
  body: unknown,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<RouteAnswer> {
  const b = (body ?? {}) as { path?: unknown; sha256?: unknown };
  const where = approvablePath(deps.scope, b.path);
  if ("error" in where) return { status: 400, body: { error: where.error } };
  if (typeof b.sha256 !== "string") return { status: 400, body: { error: "sha256 is required: the hash of the text you approve" } };
  const before = readText(where.abs);
  if (before === null) return { status: 404, body: { error: `${where.portable} doesn't exist` } };
  const changed = (current: string) => ({
    status: 409,
    body: { error: `${where.portable} has changed since you read it; read it again before approving`, sha256: current },
  });
  if (sha256(before) !== b.sha256) return changed(sha256(before));

  const refused = await askPresence(deps.gate, "approve-protocol", caller, signal);
  if (refused) return refused;

  // The file could have changed while the prompt was up.
  const after = readText(where.abs);
  if (after === null) return { status: 404, body: { error: `${where.portable} doesn't exist` } };
  if (sha256(after) !== b.sha256) return changed(sha256(after));
  const row = approveProtocol(deps.db, where.portable, after, caller.by, now());
  return { status: 200, body: { path: row.path, sha256: row.sha256, approved_by: row.approved_by } };
}

/** `POST /api/protocols/revoke` `{ path }`: withdraw an approval. The safe
 *  direction, so no presence prompt; still off `AGENT_ROUTES`. */
export function revokeProtocolRoute(deps: { db: Database.Database; scope: ApprovalScope }, body: unknown): RouteAnswer {
  const where = approvablePath(deps.scope, (body as { path?: unknown } | null)?.path);
  if ("error" in where) return { status: 400, body: { error: where.error } };
  return { status: 200, body: { path: where.portable, revoked: revokeProtocolApproval(deps.db, where.portable) } };
}

export interface PendingProtocol {
  from: ProtocolNamespace;
  path: string;
  sha256: string;
  /** What the file holds now: what approving it approves. */
  content: string;
  /** What was approved at this path before, when the file has changed since:
   *  what the app and the CLI diff against. */
  approved_content?: string;
}

/** `GET /api/protocols/pending`: every file in `home` and in each registered
 *  fold awaiting approval, with its text, and every live approval. */
export function protocolApprovalsReport(db: Database.Database, scope: ApprovalScope) {
  const approvals = liveApprovals(db);
  const approved = (abs: string) => approvals.get(scope.toPortable(abs))?.sha256;
  const pending = new Map<string, PendingProtocol>();
  for (const fold of [undefined, ...scope.folds]) {
    const namespaces = protocolNamespaces(fold, scope.homeDir, scope.braneDir, { foldOnlyIfExists: true });
    // A fold without `.brane/protocols` adds nothing to the scan of home.
    if (fold !== undefined && !namespaces.some((n) => n.from === "fold")) continue;
    const lib = loadProtocolLibrary(namespaces, {
      approved,
      display: scope.toPortable,
    });
    for (const i of lib.ignored) {
      const path = scope.toPortable(i.path);
      if (!i.pending || pending.has(path)) continue;
      const content = readText(i.path);
      if (content === null || sha256(content) !== i.pending.sha256) continue;
      const before = i.pending.changed ? liveApproval(db, path)?.content : undefined;
      pending.set(path, { from: i.from, path, sha256: i.pending.sha256, content, ...(before !== undefined ? { approved_content: before } : {}) });
    }
  }
  return {
    pending: [...pending.values()].sort((a, b) => a.path.localeCompare(b.path)),
    approved: [...approvals.values()].map(({ path, sha256, approved_at, approved_by }) => ({ path, sha256, approved_at, approved_by })),
  };
}
