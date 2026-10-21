/**
 * The daemon's WebAuthn relying party: enrollment (`verifyRegistration`) and
 * proof (`verifyAssertion`), as pure functions of what the browser sent,
 * what the daemon expected, and the clock. `node:crypto` and the CBOR
 * reader beside this file only: no dependency (docs/passkeys.md,
 * Verification; claude-pbg4whll:33).
 *
 * What each check is for:
 *
 * - **The challenge** is the daemon's, single-use and recent (the caller
 *   issues and spends it); here it is only compared, in constant time.
 * - **The origin** is the full origin, port included, against the daemon's
 *   exact list. The browser writes it into `clientDataJSON` and the
 *   authenticator signs over that, so a page on any other origin cannot
 *   produce a proof the daemon accepts, however it was patched — which is
 *   what makes the daemon the locus of the block (claude-bu1kt8a5:5, :6).
 * - **The RP ID hash** binds the credential to the daemon's hostname.
 * - **User verified**, or user present alone for a credential whose
 *   hardware attestation verified: possession of an attested key is the
 *   factor, and a PIN typed per act is the shoulder-surfing surface
 *   (decision 8). An unattested credential that cannot verify the user is
 *   refused at enrollment, since it could never prove anything after it.
 * - **The sign count** is enforced only once a credential has reported a
 *   non-zero one: every synced passkey reports 0, forever
 *   (claude-pbg4whll:17).
 *
 * Attestation is the one place the daemon learns what made a credential,
 * and only to decide one thing: whether it may stand in for the presence
 * check at the Mac. So a format this file does not verify is not an error,
 * just "not attested": the credential's own key is still the credential.
 * `packed` and `fido-u2f` are verified, because that is what YubiKeys send;
 * the chain must end at one of the roots the caller passes
 * (`yubico-roots.ts`).
 */

import { X509Certificate, constants, createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { decodeCbor, decodeCborPrefix, type CborValue } from "./cbor.js";

/** COSE algorithms the daemon accepts, in the order it asks for them:
 *  ES256 (every passkey and YubiKey), EdDSA, RS256 (Windows Hello). */
export const COSE_ALG_ES256 = -7;
export const COSE_ALG_EDDSA = -8;
export const COSE_ALG_RS256 = -257;
export const SUPPORTED_ALGS: readonly number[] = [COSE_ALG_ES256, COSE_ALG_EDDSA, COSE_ALG_RS256];

export class WebAuthnError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(reason: string, message: string): never {
  throw new WebAuthnError(reason, message);
}

// ---------------------------------------------------------------------------
// clientDataJSON

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

export function parseClientData(bytes: Uint8Array): ClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("client-data", "clientDataJSON is not JSON");
  }
  const c = parsed as Record<string, unknown>;
  if (!c || typeof c !== "object" || typeof c.type !== "string" || typeof c.challenge !== "string" || typeof c.origin !== "string") {
    fail("client-data", "clientDataJSON lacks type, challenge or origin");
  }
  return { type: c.type, challenge: c.challenge, origin: c.origin, ...(typeof c.crossOrigin === "boolean" ? { crossOrigin: c.crossOrigin } : {}) };
}

/** What the daemon expects of a ceremony it started. */
export interface Expectation {
  /** The challenge it issued, raw bytes. */
  challenge: Uint8Array;
  /** Every origin the daemon answers on, port included. */
  origins: readonly string[];
  rpId: string;
}

function checkClientData(c: ClientData, type: "webauthn.create" | "webauthn.get", expect: Expectation): void {
  if (c.type !== type) fail("type", `clientData.type is ${c.type}, not ${type}`);
  const got = Buffer.from(c.challenge, "base64url");
  const want = Buffer.from(expect.challenge);
  if (got.length !== want.length || !timingSafeEqual(got, want)) fail("challenge", "the challenge is not the one this ceremony was issued");
  if (!expect.origins.includes(c.origin)) fail("origin", `origin ${c.origin} is not one this daemon answers on`);
  if (c.crossOrigin === true) fail("origin", "the ceremony ran in a cross-origin frame");
}

// ---------------------------------------------------------------------------
// authenticatorData

export interface AuthenticatorFlags {
  /** User present: a touch, a tap, a click. */
  up: boolean;
  /** User verified: biometric, PIN or device passcode. */
  uv: boolean;
  /** Backup eligible: a synced passkey, or one that may become one. */
  be: boolean;
  /** Backed up: synced now. */
  bs: boolean;
}

export interface AttestedCredential {
  aaguid: Uint8Array;
  credentialId: Uint8Array;
  /** The COSE_Key bytes, as stored. */
  publicKey: Uint8Array;
}

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: AuthenticatorFlags;
  signCount: number;
  credential: AttestedCredential | null;
}

export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) fail("authenticator-data", "authenticatorData is shorter than 37 bytes");
  const f = bytes[32];
  const flags = { up: !!(f & 0x01), uv: !!(f & 0x04), be: !!(f & 0x08), bs: !!(f & 0x10) };
  const at = !!(f & 0x40);
  const ed = !!(f & 0x80);
  const signCount = Buffer.from(bytes.subarray(33, 37)).readUInt32BE(0);
  let pos = 37;
  let credential: AttestedCredential | null = null;
  if (at) {
    if (bytes.length < pos + 18) fail("authenticator-data", "attested credential data is truncated");
    const aaguid = bytes.slice(pos, pos + 16);
    const idLen = (bytes[pos + 16] << 8) | bytes[pos + 17];
    pos += 18;
    if (idLen > 1023 || bytes.length < pos + idLen) fail("authenticator-data", "credential id is truncated or too long");
    const credentialId = bytes.slice(pos, pos + idLen);
    pos += idLen;
    let end: number;
    try {
      end = decodeCborPrefix(bytes, pos).end;
    } catch (err) {
      fail("authenticator-data", `the credential public key is not CBOR: ${(err as Error).message}`);
    }
    credential = { aaguid, credentialId, publicKey: bytes.slice(pos, end) };
    pos = end;
  }
  if (ed) {
    try {
      pos = decodeCborPrefix(bytes, pos).end;
    } catch {
      fail("authenticator-data", "extensions are not CBOR");
    }
  }
  if (pos !== bytes.length) fail("authenticator-data", "trailing bytes in authenticatorData");
  return { rpIdHash: bytes.slice(0, 32), flags, signCount, credential };
}

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function checkRpIdHash(data: AuthenticatorData, rpId: string): void {
  if (!sha256(Buffer.from(rpId, "utf8")).equals(Buffer.from(data.rpIdHash))) fail("rp-id", `the credential is not for ${rpId}`);
}

// ---------------------------------------------------------------------------
// COSE keys and signatures

function field(map: Map<CborValue, CborValue>, key: number): CborValue {
  return map.get(key);
}

function bytesField(map: Map<CborValue, CborValue>, key: number, len?: number): Buffer {
  const v = field(map, key);
  if (!(v instanceof Uint8Array) || (len !== undefined && v.length !== len)) fail("public-key", `COSE key field ${key} is missing or the wrong size`);
  return Buffer.from(v);
}

/** A stored COSE_Key as a `KeyObject`, and its algorithm. Only the three
 *  algorithms in `SUPPORTED_ALGS`, each with the key type it implies. */
export function coseToPublicKey(cose: Uint8Array): { key: KeyObject; alg: number } {
  let m: CborValue;
  try {
    m = decodeCbor(cose);
  } catch {
    fail("public-key", "the COSE key is not CBOR");
  }
  if (!(m instanceof Map)) fail("public-key", "the COSE key is not a map");
  const kty = field(m, 1);
  const alg = field(m, 3);
  if (typeof alg !== "number" || !SUPPORTED_ALGS.includes(alg)) fail("algorithm", `COSE algorithm ${String(alg)} is not accepted`);
  try {
    if (alg === COSE_ALG_ES256) {
      if (kty !== 2 || field(m, -1) !== 1) fail("public-key", "ES256 needs an EC2 key on P-256");
      const jwk = { kty: "EC", crv: "P-256", x: bytesField(m, -2, 32).toString("base64url"), y: bytesField(m, -3, 32).toString("base64url") };
      return { key: createPublicKey({ key: jwk, format: "jwk" }), alg };
    }
    if (alg === COSE_ALG_EDDSA) {
      if (kty !== 1 || field(m, -1) !== 6) fail("public-key", "EdDSA needs an OKP key on Ed25519");
      const jwk = { kty: "OKP", crv: "Ed25519", x: bytesField(m, -2, 32).toString("base64url") };
      return { key: createPublicKey({ key: jwk, format: "jwk" }), alg };
    }
    if (kty !== 3) fail("public-key", "RS256 needs an RSA key");
    const n = bytesField(m, -1);
    if (n.length < 256) fail("public-key", "RSA keys under 2048 bits are not accepted");
    const jwk = { kty: "RSA", n: n.toString("base64url"), e: bytesField(m, -2).toString("base64url") };
    return { key: createPublicKey({ key: jwk, format: "jwk" }), alg };
  } catch (err) {
    if (err instanceof WebAuthnError) throw err;
    fail("public-key", `the COSE key does not load: ${(err as Error).message}`);
  }
}

function verifySignature(alg: number, key: KeyObject, data: Uint8Array, sig: Uint8Array): boolean {
  try {
    if (alg === COSE_ALG_ES256) return cryptoVerify("sha256", data, { key, dsaEncoding: "der" }, sig);
    if (alg === COSE_ALG_EDDSA) return cryptoVerify(null, data, key, sig);
    if (alg === COSE_ALG_RS256) return cryptoVerify("sha256", data, { key, padding: constants.RSA_PKCS1_PADDING }, sig);
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Attestation

export interface TrustStore {
  /** Anchors: a chain must end at one of these. */
  roots: readonly X509Certificate[];
  /** Untrusted path helpers, for an `x5c` that leaves its intermediates out. */
  intermediates: readonly X509Certificate[];
}

export function trustStore(rootsPem: readonly string[], intermediatesPem: readonly string[] = []): TrustStore {
  return { roots: rootsPem.map((p) => new X509Certificate(p)), intermediates: intermediatesPem.map((p) => new X509Certificate(p)) };
}

/** Whether `now` is inside a certificate's validity. `validFrom`/`validTo`
 *  are strings on every Node this runs on; the Date-valued getters are
 *  Node 23+ (claude-c1f5ef22:36). */
function inValidity(cert: X509Certificate, now: number): boolean {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return from <= now && now <= to;
}

function issuedBy(child: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return child.checkIssued(issuer) && child.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

/** The root a leaf chains to, through the `x5c` it came with and the
 *  store's helpers, or null. Every certificate on the path must be in its
 *  validity, and every one above the leaf a CA. */
export function chainRoot(leaf: X509Certificate, presented: readonly X509Certificate[], store: TrustStore, now: number): X509Certificate | null {
  if (!inValidity(leaf, now)) return null;
  const pool = [...presented, ...store.intermediates];
  let cur = leaf;
  for (let depth = 0; depth < 5; depth++) {
    for (const root of store.roots) if (issuedBy(cur, root) && inValidity(root, now)) return root;
    const next = pool.find((c) => c.ca && c !== cur && issuedBy(cur, c) && inValidity(c, now));
    if (!next) return null;
    cur = next;
  }
  return null;
}

const AAGUID_OID = Buffer.from([0x06, 0x0b, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0xe5, 0x1c, 0x01, 0x01, 0x04]);

/** The `id-fido-gen-ce-aaguid` extension of an attestation certificate, if
 *  it has one: the model the certificate vouches for, which must be the
 *  model the authenticator data names. Read from the DER directly, since
 *  `X509Certificate` exposes no extensions. */
export function certificateAaguid(cert: X509Certificate): Uint8Array | null {
  const der = cert.raw;
  const at = der.indexOf(AAGUID_OID);
  if (at < 0) return null;
  let p = at + AAGUID_OID.length;
  if (der[p] === 0x01) p += 3; // critical BOOLEAN
  // extnValue OCTET STRING { OCTET STRING (16) }
  if (der[p] !== 0x04 || der[p + 2] !== 0x04 || der[p + 3] !== 0x10) return null;
  return Uint8Array.from(der.subarray(p + 4, p + 20));
}

export interface AttestationResult {
  fmt: string;
  /** True only when a certificate chain reached a trusted root. */
  verified: boolean;
  /** The root's subject, for the record. */
  root?: string;
}

function certsOf(v: CborValue): X509Certificate[] {
  if (!Array.isArray(v) || v.length === 0) fail("attestation", "x5c is not a list of certificates");
  return v.map((c) => {
    if (!(c instanceof Uint8Array)) fail("attestation", "x5c holds a non-certificate");
    try {
      return new X509Certificate(Buffer.from(c));
    } catch {
      fail("attestation", "an x5c certificate does not parse");
    }
  });
}

function verifyAttestation(
  fmt: string,
  attStmt: Map<CborValue, CborValue>,
  authData: Uint8Array,
  parsed: AuthenticatorData & { credential: AttestedCredential },
  credKey: { key: KeyObject; alg: number },
  clientDataHash: Buffer,
  store: TrustStore,
  now: number,
): AttestationResult {
  if (fmt === "none") return { fmt, verified: false };
  if (fmt === "packed") {
    const alg = attStmt.get("alg");
    const sig = attStmt.get("sig");
    if (typeof alg !== "number" || !(sig instanceof Uint8Array)) fail("attestation", "packed attestation lacks alg or sig");
    const signed = Buffer.concat([authData, clientDataHash]);
    const x5c = attStmt.get("x5c");
    if (x5c === undefined) {
      // Self attestation: the credential signs for itself, proving only
      // that it holds its own key.
      if (alg !== credKey.alg || !verifySignature(alg, credKey.key, signed, sig)) fail("attestation", "packed self attestation does not verify");
      return { fmt, verified: false };
    }
    const certs = certsOf(x5c);
    const leaf = certs[0];
    if (!SUPPORTED_ALGS.includes(alg) || !verifySignature(alg, leaf.publicKey, signed, sig)) fail("attestation", "packed attestation signature does not verify");
    if (leaf.ca) fail("attestation", "the attestation certificate is a CA");
    if (!/(^|\n)OU=Authenticator Attestation(\n|$)/.test(leaf.subject)) fail("attestation", "the attestation certificate's OU is not \"Authenticator Attestation\"");
    const certAaguid = certificateAaguid(leaf);
    if (certAaguid && !Buffer.from(certAaguid).equals(Buffer.from(parsed.credential.aaguid))) fail("attestation", "the certificate vouches for a different authenticator model");
    const root = chainRoot(leaf, certs.slice(1), store, now);
    return root ? { fmt, verified: true, root: root.subject } : { fmt, verified: false };
  }
  if (fmt === "fido-u2f") {
    const sig = attStmt.get("sig");
    if (!(sig instanceof Uint8Array)) fail("attestation", "fido-u2f attestation lacks sig");
    const certs = certsOf(attStmt.get("x5c"));
    if (certs.length !== 1) fail("attestation", "fido-u2f carries exactly one certificate");
    if (credKey.alg !== COSE_ALG_ES256) fail("attestation", "fido-u2f credentials are ES256");
    const jwk = credKey.key.export({ format: "jwk" }) as { x: string; y: string };
    const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
    const signed = Buffer.concat([Buffer.from([0x00]), parsed.rpIdHash, clientDataHash, parsed.credential.credentialId, point]);
    if (!verifySignature(COSE_ALG_ES256, certs[0].publicKey, signed, sig)) fail("attestation", "fido-u2f attestation signature does not verify");
    const root = chainRoot(certs[0], [], store, now);
    return root ? { fmt, verified: true, root: root.subject } : { fmt, verified: false };
  }
  // apple, android-key, tpm, …: not verified here, so not attested. The
  // credential still enrolls; it just cannot stand in for the presence check.
  return { fmt, verified: false };
}

// ---------------------------------------------------------------------------
// The two ceremonies

export interface RegistrationResponse {
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
}

export interface VerifiedRegistration {
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  alg: number;
  signCount: number;
  aaguid: string;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  attestation: AttestationResult;
}

export function formatAaguid(b: Uint8Array): string {
  const h = Buffer.from(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function verifyRegistration(res: RegistrationResponse, expect: Expectation, store: TrustStore, now: number): VerifiedRegistration {
  checkClientData(parseClientData(res.clientDataJSON), "webauthn.create", expect);
  let att: CborValue;
  try {
    att = decodeCbor(res.attestationObject);
  } catch {
    fail("attestation-object", "attestationObject is not CBOR");
  }
  if (!(att instanceof Map)) fail("attestation-object", "attestationObject is not a map");
  const fmt = att.get("fmt");
  const attStmt = att.get("attStmt");
  const authData = att.get("authData");
  if (typeof fmt !== "string" || !(attStmt instanceof Map) || !(authData instanceof Uint8Array)) fail("attestation-object", "attestationObject lacks fmt, attStmt or authData");
  const parsed = parseAuthenticatorData(authData);
  checkRpIdHash(parsed, expect.rpId);
  if (!parsed.flags.up) fail("user-presence", "the authenticator did not see the user");
  if (!parsed.credential) fail("authenticator-data", "no credential was created");
  const credKey = coseToPublicKey(parsed.credential.publicKey);
  const clientDataHash = sha256(res.clientDataJSON);
  const attestation = verifyAttestation(fmt, attStmt, authData, parsed as AuthenticatorData & { credential: AttestedCredential }, credKey, clientDataHash, store, now);
  if (!parsed.flags.uv && !attestation.verified) {
    fail("user-verification", "this credential neither verified the user nor attested its hardware, so it could never prove the operator");
  }
  return {
    credentialId: parsed.credential.credentialId,
    publicKey: parsed.credential.publicKey,
    alg: credKey.alg,
    signCount: parsed.signCount,
    aaguid: formatAaguid(parsed.credential.aaguid),
    userVerified: parsed.flags.uv,
    backupEligible: parsed.flags.be,
    backedUp: parsed.flags.bs,
    attestation,
  };
}

export interface AssertionResponse {
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
}

/** What the daemon holds about an enrolled credential, for a proof. */
export interface StoredCredential {
  publicKey: Uint8Array;
  signCount: number;
  /** Admitted with verified hardware attestation: touch alone suffices. */
  attested: boolean;
}

export interface VerifiedAssertion {
  signCount: number;
  userVerified: boolean;
  backedUp: boolean;
}

export function verifyAssertion(res: AssertionResponse, cred: StoredCredential, expect: Expectation): VerifiedAssertion {
  checkClientData(parseClientData(res.clientDataJSON), "webauthn.get", expect);
  const parsed = parseAuthenticatorData(res.authenticatorData);
  checkRpIdHash(parsed, expect.rpId);
  if (!parsed.flags.up) fail("user-presence", "the authenticator did not see the user");
  if (!parsed.flags.uv && !cred.attested) fail("user-verification", "this credential must verify the user (Face ID, Touch ID, a PIN)");
  const { key, alg } = coseToPublicKey(cred.publicKey);
  const signed = Buffer.concat([res.authenticatorData, sha256(res.clientDataJSON)]);
  if (!verifySignature(alg, key, signed, res.signature)) fail("signature", "the signature does not verify");
  if ((parsed.signCount !== 0 || cred.signCount !== 0) && parsed.signCount <= cred.signCount) {
    fail("sign-count", "the sign count went backwards: this credential may have been cloned");
  }
  return { signCount: parsed.signCount, userVerified: parsed.flags.uv, backedUp: parsed.flags.bs };
}
