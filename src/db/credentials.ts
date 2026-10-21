/**
 * The `credentials` table: the operator's enrolled passkeys and security
 * keys (docs/passkeys.md, "Many credentials, one operator"). Any live row
 * satisfies the verification gate; none is bound to the token that enrolled
 * it, so revoking a device never revokes a credential (decision 9). Rows are
 * revoked, never deleted.
 *
 * What a row says about how it was admitted (`enrolled_by`) is the record
 * the switch prints before it turns the gate on, so a key nobody remembers
 * enrolling is seen before it can verify anything (claude-vxnhxcg9:25).
 */

import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

export interface CredentialRow {
  id: string;
  credential_id: Buffer;
  rp_id: string;
  public_key: Buffer;
  alg: number;
  transports: string | null;
  aaguid: string | null;
  sign_count: number;
  backup_eligible: number;
  backed_up: number;
  attested: number;
  attestation_fmt: string | null;
  attestation_root: string | null;
  label: string;
  enrolled_at: number;
  enrolled_by: string;
  enrolled_via: string | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** What the Devices view and `brane config verification passkey` show: no
 *  key material. */
export interface CredentialListing {
  id: string;
  label: string;
  rp_id: string;
  aaguid: string | null;
  attested: boolean;
  attestation_root: string | null;
  /** A synced passkey (true), or bound to one authenticator (false). */
  backup_eligible: boolean;
  transports: string[];
  enrolled_at: number;
  enrolled_by: string;
  enrolled_via: string | null;
  last_used_at: number | null;
}

export interface NewCredential {
  credentialId: Uint8Array;
  rpId: string;
  publicKey: Uint8Array;
  alg: number;
  transports: readonly string[];
  aaguid: string;
  signCount: number;
  backupEligible: boolean;
  backedUp: boolean;
  attested: boolean;
  attestationFmt: string;
  attestationRoot: string | null;
  label: string;
  enrolledBy: string;
  enrolledVia: string | null;
}

/** Transports a browser may report; anything else is dropped rather than
 *  stored and handed back to another browser as a hint. */
const KNOWN_TRANSPORTS = new Set(["usb", "nfc", "ble", "smart-card", "hybrid", "internal"]);

export function cleanTransports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((t): t is string => typeof t === "string" && KNOWN_TRANSPORTS.has(t)))];
}

function listing(r: CredentialRow): CredentialListing {
  let transports: string[] = [];
  try {
    transports = cleanTransports(JSON.parse(r.transports ?? "[]"));
  } catch {}
  return {
    id: r.id,
    label: r.label,
    rp_id: r.rp_id,
    aaguid: r.aaguid,
    attested: r.attested === 1,
    attestation_root: r.attestation_root,
    backup_eligible: r.backup_eligible === 1,
    transports,
    enrolled_at: r.enrolled_at,
    enrolled_by: r.enrolled_by,
    enrolled_via: r.enrolled_via,
    last_used_at: r.last_used_at,
  };
}

export class DbCredentialStore {
  constructor(private readonly db: Database.Database) {}

  /** Live credentials for `rpId`, oldest first: the ones that can verify. */
  live(rpId?: string): CredentialRow[] {
    const sql = rpId === undefined
      ? "SELECT * FROM credentials WHERE revoked_at IS NULL ORDER BY enrolled_at"
      : "SELECT * FROM credentials WHERE revoked_at IS NULL AND rp_id = ? ORDER BY enrolled_at";
    return (rpId === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(rpId)) as CredentialRow[];
  }

  list(): CredentialListing[] {
    return this.live().map(listing);
  }

  /** How many live credentials there are, on any RP ID: what `brane config
   *  verification passkey` asks before it lets the gate on. */
  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE revoked_at IS NULL").get() as { n: number }).n;
  }

  /** A live credential by the id the authenticator gave it. */
  byCredentialId(credentialId: Uint8Array): CredentialRow | null {
    return (this.db
      .prepare("SELECT * FROM credentials WHERE credential_id = ? AND revoked_at IS NULL")
      .get(Buffer.from(credentialId)) as CredentialRow | undefined) ?? null;
  }

  /** Whether this credential id was ever enrolled, revoked or not: a
   *  revoked credential is never re-admitted by enrolling it again. */
  known(credentialId: Uint8Array): boolean {
    return this.db.prepare("SELECT 1 FROM credentials WHERE credential_id = ?").get(Buffer.from(credentialId)) !== undefined;
  }

  insert(c: NewCredential, now: number): CredentialListing {
    const id = `cred-${randomBytes(6).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO credentials (id, credential_id, rp_id, public_key, alg, transports, aaguid, sign_count,
           backup_eligible, backed_up, attested, attestation_fmt, attestation_root, label, enrolled_at, enrolled_by, enrolled_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        Buffer.from(c.credentialId),
        c.rpId,
        Buffer.from(c.publicKey),
        c.alg,
        JSON.stringify(cleanTransports(c.transports)),
        c.aaguid,
        c.signCount,
        c.backupEligible ? 1 : 0,
        c.backedUp ? 1 : 0,
        c.attested ? 1 : 0,
        c.attestationFmt,
        c.attestationRoot,
        c.label,
        now,
        c.enrolledBy,
        c.enrolledVia,
      );
    return listing(this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow);
  }

  /** After a proof: the new sign count, the backup state, when. The count
   *  only ever moves forward, in the same statement that checks it, so two
   *  proofs racing with one count cannot both land. */
  recordUse(id: string, signCount: number, backedUp: boolean, now: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE credentials SET sign_count = ?, backed_up = ?, last_used_at = ?
         WHERE id = ? AND revoked_at IS NULL AND (sign_count < ? OR (sign_count = 0 AND ? = 0))`,
      )
      .run(signCount, backedUp ? 1 : 0, now, id, signCount, signCount);
    return r.changes === 1;
  }

  revoke(id: string, now: number): boolean {
    return this.db.prepare("UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes === 1;
  }
}

/** The operator's WebAuthn user handle: random, one per daemon, never an
 *  email or a username (decision 13, claude-82b6w9o3:12). One operator, so
 *  one handle; made the first time a ceremony needs it. */
export function webauthnUserHandle(db: Database.Database): Buffer {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'webauthn.user_handle'").get() as { value: string } | undefined;
  if (row) return Buffer.from(row.value, "base64url");
  const handle = randomBytes(32);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('webauthn.user_handle', ?)").run(handle.toString("base64url"));
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'webauthn.user_handle'").get() as { value: string };
  return Buffer.from(stored.value, "base64url");
}
