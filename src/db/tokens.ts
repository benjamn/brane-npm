/**
 * The `tokens` table: the daemon's bearer tokens, by hash only. The ring that
 * reads it — authentication, rotation, and why only hashes — is
 * `src/daemon/token-ring.ts`; this module is the storage and the one-time
 * migration from the plaintext token brane kept before.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  hashToken,
  LEGACY_TOKEN_LABEL,
  UNUSED_TOKEN_LAPSE_MS,
  type TokenKind,
  type TokenRecord,
  type TokenSighting,
  type TokenStore,
} from "../daemon/token-ring.js";

/** A user agent is shown in a devices list and nowhere else; past this it is
 *  noise, and an unbounded header is not something to keep forever. */
const MAX_USER_AGENT_LENGTH = 512;

/** A header or address as it may be stored and shown: control characters
 *  become spaces (a newline in a list is a forged row), capped, or null. */
function cleanSighting(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, max);
  return clean || null;
}

/** An IPv4 peer arrives on a dual-stack socket as `::ffff:100.64.0.1`. */
export function normalizeRemoteAddr(addr: string | null | undefined): string | null {
  const clean = cleanSighting(addr, 64);
  return clean?.startsWith("::ffff:") && clean.includes(".") ? clean.slice("::ffff:".length) : clean;
}

/** The sighting recorded for a connection on the daemon's Unix socket,
 *  which has no address of its own. */
export const UNIX_SOCKET_SIGHTING = "daemon.sock";

/** Whether two sightings are the same place. Loopback is one place however
 *  it is spelled: the MCP bridge dials `localhost` (often `::1`), the CLI
 *  dials `127.0.0.1` or `daemon.sock`, and a token used by both is not a
 *  copy. */
export function samePlace(a: string, b: string): boolean {
  const loopback = (x: string) => x === "::1" || x === UNIX_SOCKET_SIGHTING || /^127\.\d+\.\d+\.\d+$/.test(x);
  return a === b || (loopback(a) && loopback(b));
}

/** A narrative a token launched, as the Devices list shows it. */
export interface LaunchedAgent {
  id: string;
  title: string | null;
  status: string | null;
  agent_type: string | null;
}

/** Record which token's request launched (spawned, ran or revived) a
 *  narrative's process, on the narrative and on the agent token that launch
 *  minted — which is what lets revoking a device cascade to the agents it
 *  started. Best-effort: it labels, and must never fail the launch it
 *  follows. */
export function recordLauncher(db: Database.Database, nid: string, tokenId: string): void {
  try {
    db.prepare("UPDATE narratives SET launched_by = ? WHERE id = ?").run(tokenId, nid);
    db.prepare(
      "UPDATE tokens SET minted_by = ? WHERE kind = 'agent' AND owner_nid = ? AND revoked_at IS NULL AND minted_by IS NULL",
    ).run(tokenId, nid);
  } catch {}
}

/** Mint a narrative's agent token: the credential its session uses for
 *  everything (the MCP bridge, the `brane` CLI in its shell, hooks), handed
 *  to it in the tmux env as `BRANE_NARRATIVE_SECRET`. The daemon keeps only
 *  the hash. Every launch mints a fresh one and revokes the narrative's
 *  previous ones in the same write, so exactly one is live per narrative and
 *  a revoked agent comes back only by being revived. Returns the plaintext,
 *  which the caller puts in the session's env and nowhere else. */
export function mintAgentToken(
  db: Database.Database,
  nid: string,
  now: number = Date.now(),
  mint: () => string = () => randomUUID(),
  /** false: leave the previous token live, for a launch that may still fail —
   *  the caller then calls `settleAgentLaunch` with the outcome. */
  revokePrevious = true,
): string {
  const token = mint();
  db.transaction(() => {
    if (revokePrevious) {
      db.prepare("UPDATE tokens SET revoked_at = ? WHERE kind = 'agent' AND owner_nid = ? AND revoked_at IS NULL").run(now, nid);
    }
    db.prepare(
      `INSERT INTO tokens (id, hash, kind, label, origin, created_at, last_used_at, owner_nid)
       VALUES (?, ?, 'agent', ?, 'minted', ?, ?, ?)`,
    ).run(randomUUID(), hashToken(token), nid, now, now, nid);
  })();
  return token;
}

/** Finish a launch that minted with `revokePrevious = false`. On success the
 *  narrative's other agent tokens are revoked, so one is live; on failure the
 *  new token is, and the previous one stands. Without this split, a revive
 *  that raced another (a double tap) would revoke the running session's
 *  token and then fail to launch — leaving the live agent cut off by a revive
 *  that never happened. */
export function settleAgentLaunch(
  db: Database.Database,
  nid: string,
  token: string,
  launched: boolean,
  now: number = Date.now(),
): void {
  const hash = hashToken(token);
  if (launched) {
    db.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE kind = 'agent' AND owner_nid = ? AND revoked_at IS NULL AND hash != ?",
    ).run(now, nid, hash);
  } else {
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL").run(now, hash);
  }
}

/** The id of `nid`'s live agent token row, if it has one. */
export function liveAgentTokenId(db: Database.Database, nid: string): string | null {
  const row = db
    .prepare("SELECT id FROM tokens WHERE kind = 'agent' AND owner_nid = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(nid) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Whether `secret` is `nid`'s live agent token. What `/ws/mcp` and the hook
 *  route check a narrative claim against, in place of comparing the plaintext
 *  `narratives.bind_token` brane used to keep. */
export function verifyAgentToken(db: Database.Database, nid: string, secret: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM tokens WHERE hash = ? AND kind = 'agent' AND owner_nid = ? AND revoked_at IS NULL")
      .get(hashToken(secret), nid) !== undefined
  );
}

/** Adopt the plaintext bind secret of each narrative in `only` as an agent
 *  token, so sessions launched before agent tokens and still running keep
 *  working: their tmux env holds that secret, and it is now checked by hash.
 *  Only running sessions: a dead or archived narrative's stored secret would
 *  otherwise become a permanent bearer token for a session nobody is running
 *  (367 of them on the first machine this ran on, claude-jrjh1e8w:13 #3).
 *  Omit `only` to adopt every stored secret (tests). Idempotent, and a hash
 *  already known — revoked or not — is never adopted again. The plaintext
 *  column is left as it is; a secret not adopted authenticates nothing. */
export function adoptBindTokens(db: Database.Database, now: number = Date.now(), only?: ReadonlySet<string>): number {
  const rows = (
    db
      .prepare("SELECT id, bind_token FROM narratives WHERE bind_token IS NOT NULL AND bind_token != ''")
      .all() as Array<{ id: string; bind_token: string }>
  ).filter((r) => !only || only.has(r.id));
  const known = db.prepare("SELECT 1 FROM tokens WHERE hash = ?");
  const insert = db.prepare(
    `INSERT INTO tokens (id, hash, kind, label, origin, created_at, last_used_at, owner_nid)
     VALUES (?, ?, 'agent', ?, 'adopted', ?, NULL, ?)`,
  );
  let adopted = 0;
  db.transaction(() => {
    for (const r of rows) {
      const hash = hashToken(r.bind_token);
      if (known.get(hash)) continue;
      insert.run(randomUUID(), hash, r.id, now, r.id);
      adopted++;
    }
  })();
  return adopted;
}

/** One live row, as the Devices list shows it. */
export interface TokenListing {
  id: string;
  kind: TokenKind;
  label: string;
  origin: "minted" | "adopted";
  created_at: number;
  last_used_at: number | null;
  user_agent: string | null;
  remote_addr: string | null;
  /** The most recent request's, refreshed at most once a minute. */
  last_user_agent: string | null;
  last_remote_addr: string | null;
  /** When it was last presented from an address other than the first one:
   *  a copy, or the same device on another network. Sticky, so a copy used
   *  once is still flagged after the real device is back. */
  elsewhere_at: number | null;
  /** The token whose request minted this one (a Meld from another device, or
   *  this machine's `brane meld`), and what that token is. */
  minted_by: string | null;
  /** For an agent token, the narrative it belongs to. */
  owner_nid: string | null;
  minted_by_kind: TokenKind | null;
  minted_by_user_agent: string | null;
  /** A minted device token nobody has presented yet: a meld QR still on
   *  someone's screen. It lapses at `created_at + UNUSED_TOKEN_LAPSE_MS`. */
  unused: boolean;
}

/** `last_used_at` is a "last seen" for a devices list, not an audit log, so a
 *  busy token writes it at most this often rather than on every request. */
const TOUCH_INTERVAL_MS = 60_000;

export { LEGACY_TOKEN_LABEL };

interface TokenRow {
  id: string;
  kind: TokenKind;
  label: string;
  origin: "minted" | "adopted";
  created_at: number;
  last_used_at: number | null;
  user_agent: string | null;
  remote_addr: string | null;
  last_user_agent: string | null;
  last_remote_addr: string | null;
  elsewhere_at: number | null;
  minted_by: string | null;
  owner_nid: string | null;
}

const ROW_COLUMNS =
  "id, kind, label, origin, created_at, last_used_at, user_agent, remote_addr, " +
  "last_user_agent, last_remote_addr, elsewhere_at, minted_by, owner_nid";

/** `ROW_COLUMNS` qualified as `t.`, plus what the minting token is, for the list. */
const LISTING_COLUMNS =
  ROW_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ") +
  ", m.kind AS minted_by_kind, m.user_agent AS minted_by_user_agent";

/** The rows `UNUSED_TOKEN_LAPSE_MS` applies to, as SQL: minted device tokens
 *  never presented. */
const UNUSED_DEVICE = "kind = 'device' AND origin = 'minted' AND last_used_at IS NULL";

export class DbTokenStore implements TokenStore {
  private touched = new Map<string, number>();
  /** Rows presented since this daemon started. A token's first use is what
   *  saves it from lapsing, and the `last_used_at` stamp that records it is
   *  best-effort; this is the in-memory record that cannot fail. */
  private used = new Set<string>();
  /** Rows whose sighting is on disk, so a busy token checks it once per
   *  daemon rather than on every request. */
  private sighted = new Set<string>();
  /** When this daemon last stamped `elsewhere_at`, per row, so a copy in
   *  steady use writes at most once a minute. */
  private elsewhereStamped = new Map<string, number>();

  constructor(private readonly db: Database.Database) {}

  find(hash: string, now: number, seen?: TokenSighting): TokenRecord | null {
    const row = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM tokens WHERE hash = ? AND revoked_at IS NULL`)
      .get(hash) as TokenRow | undefined;
    return row ? this.admit(row, now, seen) : null;
  }

  account(now: number, seen?: TokenSighting): TokenRecord | null {
    const row = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM tokens WHERE kind = 'local' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .get() as TokenRow | undefined;
    return row ? this.admit(row, now, seen) : null;
  }

  /** A live row being used: refuse it if it has lapsed, else stamp its
   *  sighting and last use, and return it. */
  private admit(row: TokenRow, now: number, seen?: TokenSighting): TokenRecord | null {
    if (this.lapsed(row, now)) {
      // Refused whether or not the revoke lands; the sweep retries it.
      try { this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, row.id); } catch {}
      return null;
    }
    this.used.add(row.id);
    if (seen && !this.sighted.has(row.id)) {
      if (row.user_agent !== null || row.remote_addr !== null) this.sighted.add(row.id);
      // Best-effort, like the stamp below; the next request retries it.
      else try { if (this.recordSighting(row.id, seen)) this.sighted.add(row.id); } catch {}
    }
    // The first sighting names the row; the latest, and whether it came from
    // somewhere else, is what shows a copied token. An address is the one
    // thing about a request its sender cannot choose, so it is what's compared.
    const userAgent = seen ? cleanSighting(seen.userAgent, MAX_USER_AGENT_LENGTH) : null;
    const remoteAddr = seen ? normalizeRemoteAddr(seen.remoteAddr) : null;
    const elsewhere = remoteAddr !== null && row.remote_addr !== null && !samePlace(remoteAddr, row.remote_addr);
    const last = this.touched.get(row.id) ?? row.last_used_at ?? 0;
    const lastElsewhere = this.elsewhereStamped.get(row.id) ?? row.elsewhere_at ?? 0;
    if (now - last >= TOUCH_INTERVAL_MS || (elsewhere && now - lastElsewhere >= TOUCH_INTERVAL_MS)) {
      // Best-effort: a "last seen" stamp must never fail the request it rides
      // on (a busy or read-only database, say). The next request retries it.
      try {
        this.db
          .prepare(
            `UPDATE tokens SET last_used_at = ?,
               last_user_agent = COALESCE(?, last_user_agent),
               last_remote_addr = COALESCE(?, last_remote_addr),
               elsewhere_at = CASE WHEN ? THEN ? ELSE elsewhere_at END
             WHERE id = ?`,
          )
          .run(now, userAgent, remoteAddr, elsewhere ? 1 : 0, now, row.id);
        this.touched.set(row.id, now);
        if (elsewhere) this.elsewhereStamped.set(row.id, now);
      } catch {}
    }
    return { id: row.id, kind: row.kind, label: row.label, ...(row.owner_nid ? { ownerNid: row.owner_nid } : {}) };
  }

  /** Whether this hash has *ever* been a token, revoked or not — so a
   *  revoked token presented again at startup is never re-adopted. */
  known(hash: string): boolean {
    return this.db.prepare("SELECT 1 FROM tokens WHERE hash = ?").get(hash) !== undefined;
  }

  insert(
    hash: string,
    kind: TokenKind,
    label: string,
    now: number,
    opts: { used?: boolean; seen?: TokenSighting; mintedBy?: string } = {},
  ): TokenRecord {
    const record = this.write(hash, kind, label, now, "minted");
    if (opts.mintedBy) this.db.prepare("UPDATE tokens SET minted_by = ? WHERE id = ?").run(opts.mintedBy, record.id);
    if (opts.used) {
      this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now, record.id);
      this.used.add(record.id);
      this.touched.set(record.id, now);
    }
    // Best-effort: a rotation's replacement is inserted inside the rotation's
    // transaction, and a label for a list must never be what aborts it.
    if (opts.seen) try { if (this.recordSighting(record.id, opts.seen)) this.sighted.add(record.id); } catch {}
    return record;
  }

  /** Write a row's first sighting, if it has none. Never overwrites one: the
   *  row should keep naming the device that first presented it, not whoever
   *  presents it next. Returns whether anything was written. */
  private recordSighting(id: string, seen: TokenSighting): boolean {
    const userAgent = cleanSighting(seen.userAgent, MAX_USER_AGENT_LENGTH);
    const remoteAddr = normalizeRemoteAddr(seen.remoteAddr);
    if (userAgent === null && remoteAddr === null) return false;
    this.db
      .prepare(
        "UPDATE tokens SET user_agent = ?, remote_addr = ? WHERE id = ? AND user_agent IS NULL AND remote_addr IS NULL",
      )
      .run(userAgent, remoteAddr, id);
    return true;
  }

  /** Every live row, oldest first, for the Devices list. A minted token that
   *  has already lapsed but not yet been swept is left out: it can no longer
   *  authenticate, so it is not a device. */
  list(now: number): TokenListing[] {
    const rows = this.db
      .prepare(
        `SELECT ${LISTING_COLUMNS} FROM tokens t LEFT JOIN tokens m ON m.id = t.minted_by
         WHERE t.revoked_at IS NULL ORDER BY t.created_at, t.id`,
      )
      .all() as Array<TokenRow & Pick<TokenListing, "minted_by_kind" | "minted_by_user_agent">>;
    return rows
      .filter((r) => !this.lapsed(r, now))
      .map((r) => ({ ...r, unused: this.unused(r) }));
  }

  retireDependents(_retired: readonly string[], requesterId: string, replacementId: string, now: number): string[] {
    this.db.prepare("UPDATE tokens SET minted_by = ? WHERE minted_by = ?").run(replacementId, requesterId);
    // Every external whose dialer is no longer live — the rows this rotation
    // retired, and any revoked earlier without its externals (by a store
    // from before that rule, say) — so no rotation leaves one standing.
    const ids = (
      this.db
        .prepare(
          `SELECT t.id FROM tokens t
             JOIN narratives n ON n.id = t.owner_nid
             LEFT JOIN tokens d ON d.id = t.minted_by
           WHERE t.kind = 'agent' AND t.revoked_at IS NULL AND n.agent_type = 'external'
             AND t.minted_by IS NOT NULL AND (d.id IS NULL OR d.revoked_at IS NOT NULL)`,
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    this.revoke(ids, now);
    return ids;
  }

  /** The live agent tokens of external narratives that any of `dialers`
   *  dialed in. An external's token is its dialer's credential in another
   *  form — one `/ws/mcp` dial mints it — so it goes wherever its dialer
   *  goes, without asking (claude-jrjh1e8w:22). */
  externalsOf(dialers: readonly string[]): string[] {
    if (dialers.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT t.id FROM tokens t JOIN narratives n ON n.id = t.owner_nid
           WHERE t.kind = 'agent' AND t.revoked_at IS NULL AND n.agent_type = 'external'
             AND t.minted_by IN (${dialers.map(() => "?").join(", ")})`,
        )
        .all(...dialers) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  /** Every live device row minted by `rootId`, directly or through a chain of
   *  devices, revoked links included (a laptop revoked last week still
   *  connects the phone to the tablet it added) — what a cascading revoke may
   *  take. Never the `keep` row or anything it added by a path that does not
   *  run through `rootId`: that is the requester, and a cascade that reached
   *  it would strand the device doing the revoking. (Not through the root,
   *  because the requester is often an *ancestor*: `brane meld` from this
   *  machine added the phone, and revoking the phone from here must still
   *  take the laptop the phone added.) */
  descendants(rootId: string, keep?: string): string[] {
    const rows = this.db.prepare("SELECT id, kind, minted_by, revoked_at FROM tokens").all() as Array<{
      id: string;
      kind: TokenKind;
      minted_by: string | null;
      revoked_at: number | null;
    }>;
    const children = new Map<string, typeof rows>();
    for (const r of rows) {
      if (r.minted_by === null) continue;
      const list = children.get(r.minted_by) ?? [];
      list.push(r);
      children.set(r.minted_by, list);
    }
    const subtree = (from: string, stopAt?: string): Set<string> => {
      const seen = new Set<string>([from]);
      const queue = [from];
      while (queue.length) {
        for (const c of children.get(queue.shift()!) ?? []) {
          if (c.id === stopAt || seen.has(c.id)) continue;
          seen.add(c.id);
          queue.push(c.id);
        }
      }
      return seen;
    };
    const kept = keep ? subtree(keep, rootId) : new Set<string>();
    const out: string[] = [];
    for (const id of subtree(rootId)) {
      if (id === rootId || kept.has(id)) continue;
      const row = rows.find((r) => r.id === id)!;
      if (row.kind !== "local" && row.revoked_at === null) out.push(id);
    }
    return out;
  }

  /** The narratives each token last launched (spawn, run or revive), not
   *  archived, keyed by token id. */
  launched(): Map<string, LaunchedAgent[]> {
    const rows = this.db
      .prepare(
        `SELECT id, title, status, agent_type, launched_by FROM narratives
         WHERE launched_by IS NOT NULL AND (archived = 0 OR archived IS NULL)
         ORDER BY created_at`,
      )
      .all() as Array<LaunchedAgent & { launched_by: string }>;
    const out = new Map<string, LaunchedAgent[]>();
    for (const { launched_by, ...agent } of rows) {
      const list = out.get(launched_by) ?? [];
      list.push(agent);
      out.set(launched_by, list);
    }
    return out;
  }

  /** One live row by id, or null. */
  get(id: string): TokenListing | null {
    const row = this.db
      .prepare(
        `SELECT ${LISTING_COLUMNS} FROM tokens t LEFT JOIN tokens m ON m.id = t.minted_by
         WHERE t.id = ? AND t.revoked_at IS NULL`,
      )
      .get(id) as (TokenRow & Pick<TokenListing, "minted_by_kind" | "minted_by_user_agent">) | undefined;
    return row ? { ...row, unused: this.unused(row) } : null;
  }

  private unused(row: TokenRow): boolean {
    return row.kind === "device" && row.origin === "minted" && row.last_used_at === null && !this.used.has(row.id);
  }

  private lapsed(row: TokenRow, now: number): boolean {
    return this.unused(row) && now - row.created_at >= UNUSED_TOKEN_LAPSE_MS;
  }

  /** Revoke every minted device token that lapsed unused — the sweep behind
   *  `find`'s own check, so a QR nobody scanned does not linger as a live
   *  row. Returns how many it revoked. */
  lapseUnused(now: number): number {
    const rows = this.db
      .prepare(`SELECT id FROM tokens WHERE ${UNUSED_DEVICE} AND revoked_at IS NULL AND created_at <= ?`)
      .all(now - UNUSED_TOKEN_LAPSE_MS) as Array<{ id: string }>;
    const ids = rows.map((r) => r.id).filter((id) => !this.used.has(id));
    this.revoke(ids, now);
    return ids.length;
  }

  /** Record a token that existed as plaintext before this daemon hashed it —
   *  one that may have been written down somewhere (older daemons logged it). */
  adopt(hash: string, kind: TokenKind, label: string, now: number): TokenRecord {
    return this.write(hash, kind, label, now, "adopted");
  }

  private write(hash: string, kind: TokenKind, label: string, now: number, origin: "minted" | "adopted"): TokenRecord {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO tokens (id, hash, kind, label, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, hash, kind, label, origin, now);
    return { id, kind, label };
  }

  revoke(ids: readonly string[], now: number): void {
    const stmt = this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
    this.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    });
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  live(kind: TokenKind): TokenRecord[] {
    return (
      this.db
        .prepare(`SELECT ${ROW_COLUMNS} FROM tokens WHERE kind = ? AND revoked_at IS NULL ORDER BY created_at`)
        .all(kind) as TokenRow[]
    ).map((row) => ({ id: row.id, kind: row.kind, label: row.label, ...(this.unused(row) ? { unused: true } : {}) }));
  }
}

/** Advice while an adopted token is still live, or null. Daemons before
 *  hashing printed their token into `daemon.log` at every start, and a
 *  `--token` sits in argv and its config, so an adopted token should be
 *  retired: one rotation, from the device in hand or the shell, then re-meld
 *  the others. (Re-melding first would be undone: a rotation revokes every
 *  other device row.) Keyed on `origin`, not the label, so renaming the
 *  device does not silence it. */
export function legacyTokenWarning(db: Database.Database): string | null {
  const live = db
    // Not agent rows: an adopted bind secret dies at its narrative's next
    // revive, and was never something a person could have written down.
    .prepare("SELECT 1 FROM tokens WHERE origin = 'adopted' AND kind != 'agent' AND revoked_at IS NULL")
    .get();
  if (!live) return null;
  return (
    "a token that existed as plaintext before it was hashed is still valid " +
    "(older brane versions printed theirs in daemon.log, and a --token sits in argv and its config). " +
    'Retire it with "Sign out other devices" in the app, or `brane token rotate`, then re-meld your devices.'
  );
}

/** Read `.daemon_token`, the file older branes kept this machine's local
 *  token in, or null if it is absent or empty. Nothing presents it any more;
 *  it is read at daemon start (to retire what it holds, after which the
 *  daemon empties it) and by `brane doctor`. */
export function readTokenFile(path: string): string | null {
  try {
    const token = readFileSync(path, "utf-8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/** What the account row's `hash` column starts with. The rest is a UUID,
 *  only to satisfy the column's UNIQUE. */
export const ACCOUNT_HASH_PREFIX = "no-token:";

/** Whether a `hash` column holds a token's SHA-256, which some presented
 *  token could match — as opposed to the account row's placeholder, which
 *  none can: `hashToken` only ever yields 64 hex digits. */
export function isTokenHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

/** How a token still sitting in `.daemon_token` stands, for `brane doctor`:
 *  `live` when it authenticates (a pre-hashing token adopted as a device
 *  row, until a rotation retires it), `dead` when it does not. The daemon
 *  empties the file at start, so this only arises where it could not. */
export function tokenFileStanding(db: Database.Database, token: string): "live" | "dead" {
  const row = db.prepare("SELECT 1 FROM tokens WHERE hash = ? AND revoked_at IS NULL").get(hashToken(token));
  return row ? "live" : "dead";
}

export interface TokenBootstrap {
  /** What was adopted from plaintext this start, for the log. */
  adopted: string[];
  /** How many `local` rows a token could still open were revoked this
   *  start: the token an older brane kept in `.daemon_token`. */
  retiredLocal: number;
  /** What became of `.daemon_token`: `absent` (or already empty), `emptied`
   *  of the token it held, or the reason it could not be. */
  tokenFile: "absent" | "emptied" | { error: string };
}

/**
 * Bring the token state to "hashes only, and none for this machine" at
 * daemon start. Idempotent: on an already-migrated install it finds the
 * account row and changes nothing.
 *
 * **This machine holds no token.** Its CLI and MCP bridges reach the daemon
 * over `daemon.sock` and present nothing (`authenticateRequest`); what they
 * act as is the one live `local` row, the account row, whose `hash` is a
 * placeholder no token can match (`ACCOUNT_HASH_PREFIX`). Older branes kept
 * a local token in `.daemon_token`, which worked from any address the IP
 * filter admits, so a copy of the file was this machine's shell from
 * elsewhere. Every `local` row a token can open is revoked here, and the
 * file is then emptied, so no token, live or dead, stays on disk. Its hash
 * stays a revoked row, so an older brane started later cannot re-adopt it.
 * The file itself is not removed; `brane doctor` reports the empty leftover
 * for the operator to remove. What any earlier `local` row had minted,
 * dialed in or launched moves to the account row, so a device `brane meld`
 * added last week is still "added by this machine", and the agents `brane
 * spawn` started are still listed under it.
 *
 * Before hashing, one plaintext token lived in both `meta.daemon_token` and
 * `.daemon_token`, and every melded device held it. That token is adopted as
 * a *device* row, so those devices keep working, and the `meta` row is
 * dropped. Its plaintext leaves the file with everything else, so from then
 * on it exists only on the devices that hold it, and dies with the first
 * rotation like any other device token. A `--token` passed on the command line is adopted
 * the same way, labelled as configured. A token whose hash is already known
 * — live or revoked — is never adopted again, so a revoked token cannot come
 * back through a stale file or a stale `--token`.
 */
/** The label of a device row `brane meld --remote` sent as a hash. */
export const REMOTE_MELD_LABEL = "melded remotely";

/** The device-token hashes in `BRANE_DEVICE_TOKEN_SHA256`: comma-separated
 *  lowercase hex SHA-256s. Anything else is dropped, so a malformed secret
 *  adopts nothing rather than an unusable row. */
export function parseTokenHashes(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{64}$/.test(s)))];
}

export function bootstrapTokens(
  db: Database.Database,
  opts: {
    /** `.daemon_token`, read once for what an older brane left in it. */
    tokenFile: string;
    configured?: string;
    /** SHA-256 hashes of device tokens minted elsewhere — `brane meld
     *  --remote` keeps the token on the operator's machine and sends the machine only
     *  this (`BRANE_DEVICE_TOKEN_SHA256`). Each becomes a device row unless
     *  its hash was ever seen, so a revoked one never comes back. */
    configuredHashes?: readonly string[];
    mint?: () => string;
    now?: number;
    /** Narratives whose session is running now, whose bind secrets are
     *  adopted as agent tokens; every other stored secret is left a dead
     *  string. Omitted: none are adopted. */
    liveSessions?: ReadonlySet<string>;
  },
): TokenBootstrap {
  const store = new DbTokenStore(db);
  const mint = opts.mint ?? (() => randomUUID());
  const now = opts.now ?? Date.now();
  const adopted: string[] = [];

  const adopt = (plain: string | null | undefined, label: string) => {
    if (!plain) return;
    const hash = hashToken(plain);
    if (store.known(hash)) return;
    store.adopt(hash, "device", label, now);
    adopted.push(label);
  };

  const fileToken = readTokenFile(opts.tokenFile);

  const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_token'").get() as
    | { value: string }
    | undefined;
  // A plain DELETE leaves the old value in the freed page and in WAL frames
  // until something overwrites them. secure_delete zeroes the page, and the
  // checkpoint below folds the WAL back in and truncates it.
  const secureDelete = db.pragma("secure_delete", { simple: true });
  if (metaRow) db.pragma("secure_delete = ON");
  db.transaction(() => {
    // A file token that is a `local` row is known, so it is not adopted
    // here; it is retired below.
    adopt(fileToken, LEGACY_TOKEN_LABEL);
    adopt(metaRow?.value, LEGACY_TOKEN_LABEL);
    adopt(opts.configured, "configured with --token");
    for (const hash of opts.configuredHashes ?? []) {
      if (store.known(hash)) continue;
      // Minted, not adopted: like any QR, it lapses if nobody scans it.
      store.insert(hash, "device", REMOTE_MELD_LABEL, now);
      adopted.push(REMOTE_MELD_LABEL);
    }
    // The plaintext this replaces. Its hash is now a row, so nothing is lost
    // that any device needs.
    db.prepare("DELETE FROM meta WHERE key = 'daemon_token'").run();
  })();
  if (metaRow) {
    db.pragma(`secure_delete = ${secureDelete ? "ON" : "OFF"}`);
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  }

  // One live `local` row, and no token opens it.
  const retiredLocal = db.transaction(() => {
    const locals = db
      .prepare("SELECT id, hash FROM tokens WHERE kind = 'local' AND revoked_at IS NULL ORDER BY created_at DESC")
      .all() as Array<{ id: string; hash: string }>;
    const withToken = locals.filter((r) => isTokenHash(r.hash)).map((r) => r.id);
    const account =
      locals.find((r) => !isTokenHash(r.hash))?.id ??
      store.insert(`${ACCOUNT_HASH_PREFIX}${mint()}`, "local", "this machine", now).id;
    store.revoke(withToken, now);
    // What any earlier `local` row minted, dialed in or launched is the
    // account's: the rows just retired, and ones revoked before — by a shell
    // rotation on an older brane, which never moved what it had launched, or
    // by an older daemon started in between, which replaces the account row
    // with a token-opened one of its own.
    const earlier = db.prepare("SELECT id FROM tokens WHERE kind = 'local' AND id != ?").all(account) as Array<{ id: string }>;
    const minted = db.prepare("UPDATE tokens SET minted_by = ? WHERE minted_by = ?");
    const launched = db.prepare("UPDATE narratives SET launched_by = ? WHERE launched_by = ?");
    for (const { id } of earlier) {
      minted.run(account, id);
      launched.run(account, id);
    }
    return withToken.length;
  })();
  // Whatever the file held is a row now, so nothing is lost with it: a
  // revoked local token, or a pre-hashing token its devices still hold.
  // Emptied only after the rows are written, and never fatal: a file that
  // cannot be emptied is reported, by the caller and by `brane doctor`.
  let tokenFile: TokenBootstrap["tokenFile"] = "absent";
  if (fileToken) {
    try {
      writeFileSync(opts.tokenFile, "", { mode: 0o600 });
      chmodSync(opts.tokenFile, 0o600);
      tokenFile = "emptied";
    } catch (err) {
      tokenFile = { error: (err as Error).message };
    }
  }

  // Sessions launched before agent tokens hold a plaintext bind secret in
  // their env; adopting each as an agent row keeps them working.
  adoptBindTokens(db, now, opts.liveSessions ?? new Set());

  return { adopted, retiredLocal, tokenFile };
}
