/**
 * The ceremonies behind the verification gate (docs/passkeys.md, "The hop"
 * and "Daemon side"): a device asks for an **approval**, the ceremony page on
 * the daemon's own origin redeems it for a **challenge**, runs WebAuthn, and
 * posts the answer back with the approval. Two purposes:
 *
 * - `verify`: an assertion by any enrolled credential advances
 *   `verified_until` on the one token the approval is bound to;
 * - `enroll`: a new credential joins the list.
 *
 * As functions of their dependencies, out of the server's closure so the
 * suite drives them (`src/test/verification-ceremony.test.ts`).
 *
 * Less obvious than it looks:
 *
 * - **The approval is the page's only capability.** The page holds no token
 *   (it may run on another origin than the app), so the approval rides in the
 *   URL fragment, never sent to any server, as a meld token's does. It is
 *   bound at birth to the token that asked, read from that request's
 *   authentication and never from a body, so token A's approval can never
 *   verify token B (claude-vxnhxcg9:25 #3). It is single-use, expires, and
 *   is burned after `MAX_FAILURES` bad answers.
 * - **Several challenges may be outstanding per approval.** The page fetches
 *   the next challenge the moment a tap takes the current one, before the
 *   answer to the first is posted (claude-pbg4whll:31); one slot would make
 *   that prefetch invalidate the answer in flight. Each is still single-use
 *   and short-lived.
 * - **Enrollment asks the Mac unless the hardware vouched for itself.** A
 *   software authenticator sets "user verified" with nobody present, so an
 *   agent acting as this account could enroll its own passkey
 *   (claude-pbg4whll:40, :42). Verified hardware attestation (a YubiKey)
 *   stands in for that check, the top tier the operator asked to keep
 *   (claude-pbg4whll:49, :50; decision 14). Attestation is known only once
 *   the credential exists, so the question is asked at the finish; a
 *   decline leaves an orphan in the authenticator, never a row here. With
 *   the gate on, starting an enrollment is also a fresh-class act, so an
 *   existing credential approves every later one.
 * - **The ask must match the check, per kind.** The verifier demands "user
 *   verified" from every credential without verified hardware attestation
 *   and accepts touch alone from one with it, and WebAuthn takes one
 *   `userVerification` per prompt. So a verification offers one set of
 *   options per kind (`verifyKinds`), sharing the challenge: passkeys ask
 *   `"required"`, attested keys `"discouraged"` (`"preferred"` still
 *   collects a PIN from a key that has one, against decision 8). Asking
 *   `"preferred"` of everything let a third-party passkey provider on the
 *   operator's iPhone (AAGUID `bada5566…`, listed as 1Password's) answer
 *   with touch alone, which the daemon refused three times over until the
 *   operator turned the gate off (claude-oci3rpdp:16, claude-933bjhez:4).
 *   Every unattested credential verified the user at enrollment, so
 *   `"required"` never asks one for something it cannot do.
 * - **Nothing here reads the gate's mode.** A ceremony works with the gate
 *   off, so enrollment and verification can be lived with before anything
 *   is required (decision 15).
 */

import { X509Certificate, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CredentialListing, CredentialRow, DbCredentialStore, NewCredential } from "../db/credentials.js";
import { cleanTransports } from "../db/credentials.js";
import { SUPPORTED_ALGS, WebAuthnError, verifyAssertion, verifyRegistration, type TrustStore } from "../webauthn/verify.js";
import type { RouteAnswer } from "./gated-routes.js";
import { FRESH_WINDOW_MS } from "./verification-gate.js";

export type CeremonyPurpose = "verify" | "enroll";

/** How long an approval lasts: the hop out, a ceremony or two, the hop back. */
export const APPROVAL_TTL_MS = 5 * 60_000;
/** How long one challenge lasts, and the `timeout` the page passes the
 *  browser: long enough to find a key on a keyring. */
export const CHALLENGE_TTL_MS = 2 * 60_000;
/** Outstanding challenges per approval: the one being answered, the one
 *  prefetched behind it, and one to spare for a quick double tap. */
export const MAX_CHALLENGES = 3;
/** Bad answers before an approval is burned. A cancelled prompt never
 *  reaches the daemon, so this counts only answers that failed a check. */
export const MAX_FAILURES = 5;
/** How many approvals may be pending at once, daemon-wide. */
export const MAX_APPROVALS = 64;

export const RP_NAME = "brane";

/** Where the daemon can run a ceremony: its TLS hostname and the origins it
 *  answers on there. Null without TLS: WebAuthn needs a secure context, and
 *  the HTTP fallback can never have one (docs/passkeys.md, "No proof
 *  possible"). */
export interface RelyingParty {
  rpId: string;
  /** The origin the ceremony page is served from, port included. */
  origin: string;
  origins: readonly string[];
}

/** The hostname a PEM certificate is for: its subject's CN (what `tailscale
 *  cert` writes), or null. */
export function certificateHost(pem: Buffer | string): string | null {
  try {
    const cn = new X509Certificate(pem).subject.split("\n").find((l) => l.startsWith("CN="));
    const host = cn?.slice(3).trim().toLowerCase();
    return host && /^[a-z0-9.-]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

interface Approval {
  tokenId: string;
  purpose: CeremonyPurpose;
  expiresAt: number;
  challenges: Array<{ bytes: Buffer; expiresAt: number }>;
  failures: number;
  /** An enrollment's answer is waiting on the Mac: a second answer is refused
   *  until it settles. */
  busy: boolean;
}

export interface CeremonyDeps {
  credentials: Pick<DbCredentialStore, "live" | "byCredentialId" | "known" | "insert" | "recordUse" | "count">;
  /** Advance `verified_until` on a live device token. */
  verifyToken(tokenId: string, opts: { now: number; windowMs: number; freshMs: number; by: string; method: string }): boolean;
  /** Whether `tokenId` is a live device token. */
  isLiveDevice(tokenId: string): boolean;
  /** The window, read from config when the proof lands. */
  windowMs(): number;
  rp(): RelyingParty | null;
  trust: TrustStore;
  userHandle(): Uint8Array;
  /** The presence check at this machine, for an enrollment no hardware
   *  vouched for. Resolves null when approved, else why not. */
  confirmPresence(by: string, signal?: AbortSignal): Promise<RouteAnswer<{ error: string; presence: string }> | null>;
  /** "Safari on iPhone", for labels and the presence log. */
  describeToken(tokenId: string): string | null;
  /** Heard after every successful proof, for the token's own sockets. */
  onVerified?(tokenId: string, verifiedUntil: number): void;
  log?(line: string): void;
  now?(): number;
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const hashApproval = (approval: string) => createHash("sha256").update(approval).digest("base64url");

export class Ceremonies {
  private readonly approvals = new Map<string, Approval>();

  constructor(private readonly deps: CeremonyDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sweep(now: number): void {
    for (const [k, a] of this.approvals) if (a.expiresAt <= now) this.approvals.delete(k);
  }

  /** An approval for `tokenId`, which must be the caller's own token, read
   *  from its request's authentication. */
  begin(tokenId: string, purpose: CeremonyPurpose): RouteAnswer<{ approval: string; url: string; expires_at: number } | { error: string }> {
    if (!this.deps.isLiveDevice(tokenId)) return { status: 403, body: { error: "Only a signed-in device verifies or enrolls; this machine's shell does neither" } };
    const rp = this.deps.rp();
    if (!rp) return { status: 409, body: { error: "This daemon has no TLS certificate, and WebAuthn needs one: it can verify nobody until `tailscale cert` succeeds" } };
    const now = this.now();
    this.sweep(now);
    if (this.approvals.size >= MAX_APPROVALS) return { status: 429, body: { error: "Too many verifications are pending; finish or wait for one" } };
    const approval = randomBytes(32).toString("base64url");
    const expiresAt = now + APPROVAL_TTL_MS;
    this.approvals.set(hashApproval(approval), { tokenId, purpose, expiresAt, challenges: [], failures: 0, busy: false });
    const fragment = new URLSearchParams({ approval, purpose }).toString();
    return { status: 200, body: { approval, url: `${rp.origin}/verify#${fragment}`, expires_at: expiresAt } };
  }

  private lookup(approval: unknown, purpose: CeremonyPurpose, now: number): Approval | RouteAnswer<{ error: string; approval: "expired" }> {
    const gone: RouteAnswer<{ error: string; approval: "expired" }> = {
      status: 410,
      body: { error: "This verification link has expired or was already used; start again from the app", approval: "expired" },
    };
    if (typeof approval !== "string" || approval.length > 128) return gone;
    const a = this.approvals.get(hashApproval(approval));
    if (!a || a.purpose !== purpose) return gone;
    if (a.expiresAt <= now || !this.deps.isLiveDevice(a.tokenId)) {
      this.approvals.delete(hashApproval(approval));
      return gone;
    }
    return a;
  }

  private issueChallenge(a: Approval, now: number): Buffer {
    a.challenges = a.challenges.filter((c) => c.expiresAt > now);
    const bytes = randomBytes(32);
    a.challenges.push({ bytes, expiresAt: Math.min(now + CHALLENGE_TTL_MS, a.expiresAt) });
    if (a.challenges.length > MAX_CHALLENGES) a.challenges.shift();
    return bytes;
  }

  /** Take the challenge the answer names, if it is one this approval issued
   *  and still holds. Single-use: taken whether the answer then passes or
   *  not. */
  private takeChallenge(a: Approval, clientDataJSON: Uint8Array, now: number): Buffer | null {
    let named: Buffer;
    try {
      named = Buffer.from(JSON.parse(Buffer.from(clientDataJSON).toString("utf8")).challenge, "base64url");
    } catch {
      return null;
    }
    const i = a.challenges.findIndex((c) => c.expiresAt > now && c.bytes.length === named.length && timingSafeEqual(c.bytes, named));
    if (i < 0) return null;
    return a.challenges.splice(i, 1)[0].bytes;
  }

  private failed(approval: string, a: Approval, err: unknown, by = ""): RouteAnswer<{ error: string; reason: string }> {
    a.failures++;
    if (a.failures >= MAX_FAILURES) this.approvals.delete(hashApproval(approval));
    const reason = err instanceof WebAuthnError ? err.reason : "failed";
    const message = err instanceof Error ? err.message : String(err);
    this.deps.log?.(`[verification] ${a.purpose} for ${a.tokenId}${by} refused: ${reason}: ${message}`);
    return { status: 400, body: { error: message, reason } };
  }

  /** The options the page passes to `navigator.credentials.get` (verify) or
   *  `.create` (enroll), with a fresh challenge. Binary fields are base64url;
   *  the page decodes them. */
  challenge(approval: unknown, purpose: CeremonyPurpose): RouteAnswer {
    const now = this.now();
    const a = this.lookup(approval, purpose, now);
    if ("status" in a) return a;
    const rp = this.deps.rp();
    if (!rp) return { status: 409, body: { error: "This daemon has lost its TLS certificate" } };
    const challenge = b64u(this.issueChallenge(a, now));
    const live = this.deps.credentials.live(rp.rpId);
    if (purpose === "verify") {
      return {
        status: 200,
        body: {
          purpose,
          publicKey: { challenge, rpId: rp.rpId, timeout: CHALLENGE_TTL_MS, kinds: verifyKinds(live) },
          enrolled: live.length,
        },
      };
    }
    return {
      status: 200,
      body: {
        purpose,
        publicKey: {
          challenge,
          rp: { id: rp.rpId, name: RP_NAME },
          user: { id: b64u(this.deps.userHandle()), name: "operator", displayName: "brane operator" },
          pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: "public-key", alg })),
          timeout: CHALLENGE_TTL_MS,
          attestation: "direct",
          excludeCredentials: live.map(descriptorOf),
        },
        enrolled: live.length,
      },
    };
  }

  /** `POST /api/verify/webauthn`: an assertion, checked against the
   *  credential it names; on success the bound token is verified for the
   *  configured window and fresh for `FRESH_WINDOW_MS`. */
  finishVerify(body: unknown): RouteAnswer {
    const now = this.now();
    const b = (body ?? {}) as { approval?: unknown; credential?: { rawId?: unknown; response?: Record<string, unknown> } };
    const a = this.lookup(b.approval, "verify", now);
    if ("status" in a) return a;
    const approval = b.approval as string;
    const rp = this.deps.rp();
    if (!rp) return { status: 409, body: { error: "This daemon has lost its TLS certificate" } };
    let by = "";
    try {
      const rawId = bytesOf(b.credential?.rawId, "rawId");
      const r = b.credential?.response ?? {};
      const response = {
        clientDataJSON: bytesOf(r.clientDataJSON, "clientDataJSON"),
        authenticatorData: bytesOf(r.authenticatorData, "authenticatorData"),
        signature: bytesOf(r.signature, "signature"),
      };
      const challenge = this.takeChallenge(a, response.clientDataJSON, now);
      if (!challenge) throw new WebAuthnError("challenge", "the challenge is not one this approval holds, or it expired");
      const cred = this.deps.credentials.byCredentialId(rawId);
      if (!cred || cred.rp_id !== rp.rpId) throw new WebAuthnError("credential", "that credential is not enrolled here (or was revoked)");
      by = ` with ${cred.id} (${cred.label})`;
      const verified = verifyAssertion(response, { publicKey: cred.public_key, signCount: cred.sign_count, attested: cred.attested === 1 }, { challenge, origins: rp.origins, rpId: rp.rpId });
      if (!this.deps.credentials.recordUse(cred.id, verified.signCount, verified.backedUp, now)) {
        throw new WebAuthnError("sign-count", "another proof by this credential landed first");
      }
      const windowMs = this.deps.windowMs();
      const method = cred.attested === 1 ? "webauthn:attested" : "webauthn";
      if (!this.deps.verifyToken(a.tokenId, { now, windowMs, freshMs: FRESH_WINDOW_MS, by: cred.id, method })) {
        this.approvals.delete(hashApproval(approval));
        return { status: 410, body: { error: "The device this verification was for has been signed out", approval: "expired" } };
      }
      this.approvals.delete(hashApproval(approval));
      const verifiedUntil = now + (windowMs > 0 ? windowMs : FRESH_WINDOW_MS);
      this.deps.log?.(`[verification] ${a.tokenId} verified by ${cred.id} (${cred.label}) until ${new Date(verifiedUntil).toISOString()}`);
      this.deps.onVerified?.(a.tokenId, verifiedUntil);
      return { status: 200, body: { verified: true, verified_until: verifiedUntil, credential: cred.id } };
    } catch (err) {
      return this.failed(approval, a, err, by);
    }
  }

  /** `POST /api/credentials`: a new credential. Waits on the presence check
   *  at this machine unless its hardware attestation verified. */
  async finishEnroll(body: unknown, signal?: AbortSignal): Promise<RouteAnswer> {
    const now = this.now();
    const b = (body ?? {}) as { approval?: unknown; credential?: { response?: Record<string, unknown> } };
    const a = this.lookup(b.approval, "enroll", now);
    if ("status" in a) return a;
    const approval = b.approval as string;
    if (a.busy) return { status: 409, body: { error: "This enrollment is already waiting on the Mac" } };
    const rp = this.deps.rp();
    if (!rp) return { status: 409, body: { error: "This daemon has lost its TLS certificate" } };
    let reg: ReturnType<typeof verifyRegistration>;
    let transports: string[];
    try {
      const r = b.credential?.response ?? {};
      const response = { clientDataJSON: bytesOf(r.clientDataJSON, "clientDataJSON"), attestationObject: bytesOf(r.attestationObject, "attestationObject") };
      transports = cleanTransports(r.transports);
      const challenge = this.takeChallenge(a, response.clientDataJSON, now);
      if (!challenge) throw new WebAuthnError("challenge", "the challenge is not one this approval holds, or it expired");
      reg = verifyRegistration(response, { challenge, origins: rp.origins, rpId: rp.rpId }, this.deps.trust, now);
      if (this.deps.credentials.known(reg.credentialId)) throw new WebAuthnError("known", "this credential was enrolled before; a revoked credential stays revoked");
    } catch (err) {
      return this.failed(approval, a, err);
    }
    const device = this.deps.describeToken(a.tokenId) ?? "a signed-in device";
    let enrolledBy: string;
    if (reg.attestation.verified) {
      enrolledBy = `attestation: ${reg.attestation.root}`;
    } else {
      a.busy = true;
      let refused: Awaited<ReturnType<CeremonyDeps["confirmPresence"]>>;
      try {
        refused = await this.deps.confirmPresence(device, signal);
      } finally {
        a.busy = false;
      }
      if (refused) return refused;
      enrolledBy = "presence at this machine";
    }
    // The approval may have lapsed, or its device been signed out, while the
    // prompt was up.
    const still = this.lookup(approval, "enroll", this.now());
    if ("status" in still) return still;
    this.approvals.delete(hashApproval(approval));
    const kind = reg.attestation.verified ? "Security key" : reg.backupEligible ? "Passkey" : "Device-bound key";
    const credential: NewCredential = {
      credentialId: reg.credentialId,
      rpId: rp.rpId,
      publicKey: reg.publicKey,
      alg: reg.alg,
      transports,
      aaguid: reg.aaguid,
      signCount: reg.signCount,
      backupEligible: reg.backupEligible,
      backedUp: reg.backedUp,
      attested: reg.attestation.verified,
      attestationFmt: reg.attestation.fmt,
      attestationRoot: reg.attestation.root ?? null,
      label: `${kind} from ${device}`,
      enrolledBy,
      enrolledVia: a.tokenId,
    };
    let listing: CredentialListing;
    try {
      listing = this.deps.credentials.insert(credential, this.now());
    } catch {
      return { status: 409, body: { error: "this credential was enrolled meanwhile" } };
    }
    this.deps.log?.(`[verification] enrolled ${listing.id} (${listing.label}) by ${enrolledBy}`);
    return { status: 200, body: { credential: listing } };
  }

  /** Pending approvals, for the suite. */
  pending(): number {
    return this.approvals.size;
  }
}

export interface CredentialDescriptor {
  type: "public-key";
  id: string;
  transports: string[];
}

/** One way to verify, as the page offers it: a button, and the options its
 *  prompt passes besides the shared challenge. */
export interface VerifyKind {
  kind: "passkey" | "security-key";
  userVerification: "required" | "discouraged";
  allowCredentials: CredentialDescriptor[];
}

/** The kinds a verification offers, each asking exactly what `verifyAssertion`
 *  will check of its credentials: user verification from the unattested ones,
 *  touch alone from those whose hardware attestation verified. Only the kinds
 *  enrolled are offered, passkeys first. */
export function verifyKinds(live: readonly CredentialRow[]): VerifyKind[] {
  const kinds: VerifyKind[] = [];
  const passkeys = live.filter((c) => c.attested !== 1);
  const keys = live.filter((c) => c.attested === 1);
  if (passkeys.length) kinds.push({ kind: "passkey", userVerification: "required", allowCredentials: passkeys.map(descriptorOf) });
  if (keys.length) kinds.push({ kind: "security-key", userVerification: "discouraged", allowCredentials: keys.map(descriptorOf) });
  return kinds;
}

function descriptorOf(c: CredentialRow): CredentialDescriptor {
  return { type: "public-key", id: b64u(c.credential_id), transports: transportsOf(c) };
}

function transportsOf(c: CredentialRow): string[] {
  try {
    return cleanTransports(JSON.parse(c.transports ?? "[]"));
  } catch {
    return [];
  }
}

function bytesOf(v: unknown, name: string): Uint8Array {
  if (typeof v !== "string" || v.length > 64 * 1024) throw new WebAuthnError("malformed", `${name} is missing`);
  return Buffer.from(v, "base64url");
}
