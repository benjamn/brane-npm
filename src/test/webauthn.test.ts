/**
 * The daemon's WebAuthn checks (src/webauthn/verify.ts), driven by a
 * software authenticator built from node:crypto keys, plus two registrations
 * a real YubiKey made, so the vendored Yubico roots are exercised by what a
 * key actually sends. Each refusal is a case of its own: a check the suite
 * never sees fail is a check nobody knows still runs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import { CborError, decodeCbor, decodeCborPrefix, encodeCbor, type CborValue } from "../webauthn/cbor.js";
import {
  COSE_ALG_EDDSA,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  WebAuthnError,
  certificateAaguid,
  chainRoot,
  coseToPublicKey,
  trustStore,
  verifyAssertion,
  verifyRegistration,
  type Expectation,
} from "../webauthn/verify.js";
import { YUBICO_FIDO_INTERMEDIATES, YUBICO_FIDO_ROOTS } from "../webauthn/yubico-roots.js";
import { TEST_AAGUID, TEST_INT_PEM, TEST_LEAF_KEY_PEM, TEST_LEAF_PEM, TEST_OTHER_PEM, TEST_ROOT_PEM } from "./fixtures/webauthn-certs.js";

const RP_ID = "mac.tail0000.ts.net";
const ORIGIN = `https://${RP_ID}:47443`;
// After the test PKI was issued (2026-10-17T20:23Z) and before it lapses.
const NOW = Date.UTC(2027, 0, 1);

function expectation(challenge: Uint8Array, over: Partial<Expectation> = {}): Expectation {
  return { challenge, origins: [ORIGIN], rpId: RP_ID, ...over };
}

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function clientData(type: string, challenge: Uint8Array, over: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, challenge: Buffer.from(challenge).toString("base64url"), origin: ORIGIN, crossOrigin: false, ...over }));
}

interface SoftKey {
  alg: number;
  privateKey: KeyObject;
  cose: Uint8Array;
}

function softKey(alg: number = COSE_ALG_ES256): SoftKey {
  if (alg === COSE_ALG_ES256) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = encodeCbor(new Map<CborValue, CborValue>([[1, 2], [3, alg], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    return { alg, privateKey, cose };
  }
  if (alg === COSE_ALG_EDDSA) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const cose = encodeCbor(new Map<CborValue, CborValue>([[1, 1], [3, alg], [-1, 6], [-2, Buffer.from(jwk.x, "base64url")]]));
    return { alg, privateKey, cose };
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const cose = encodeCbor(new Map<CborValue, CborValue>([[1, 3], [3, alg], [-1, Buffer.from(jwk.n, "base64url")], [-2, Buffer.from(jwk.e, "base64url")]]));
  return { alg, privateKey, cose };
}

function signWith(alg: number, key: KeyObject, data: Uint8Array): Uint8Array {
  if (alg === COSE_ALG_EDDSA) return cryptoSign(null, data, key);
  return cryptoSign("sha256", data, key);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

function authData(opts: { rpId?: string; flags: number; signCount?: number; credential?: { aaguid: Uint8Array; id: Uint8Array; cose: Uint8Array } }): Uint8Array {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(opts.signCount ?? 0);
  const parts: Uint8Array[] = [sha256(Buffer.from(opts.rpId ?? RP_ID)), Uint8Array.of(opts.flags), count];
  if (opts.credential) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(opts.credential.id.length);
    parts.push(opts.credential.aaguid, len, opts.credential.id, opts.credential.cose);
  }
  return Buffer.concat(parts);
}

const aaguidBytes = (s: string) => Buffer.from(s.replace(/-/g, ""), "hex");
const ZERO_AAGUID = new Uint8Array(16);

/** A registration as a software authenticator would answer it. */
function register(opts: {
  key?: SoftKey;
  challenge: Uint8Array;
  flags?: number;
  rpId?: string;
  fmt?: "none" | "packed-x5c" | "packed-self";
  x5c?: Uint8Array[];
  attestationKey?: KeyObject;
  aaguid?: Uint8Array;
  client?: Record<string, unknown>;
  type?: string;
}) {
  const key = opts.key ?? softKey();
  const id = randomBytes(32);
  const ad = authData({
    rpId: opts.rpId,
    flags: (opts.flags ?? FLAG_UP | FLAG_UV) | FLAG_AT,
    credential: { aaguid: opts.aaguid ?? ZERO_AAGUID, id, cose: key.cose },
  });
  const cd = clientData(opts.type ?? "webauthn.create", opts.challenge, opts.client);
  const fmt = opts.fmt ?? "none";
  let attStmt = new Map<CborValue, CborValue>();
  if (fmt === "packed-self") {
    attStmt = new Map<CborValue, CborValue>([["alg", key.alg], ["sig", signWith(key.alg, key.privateKey, Buffer.concat([ad, sha256(cd)]))]]);
  } else if (fmt === "packed-x5c") {
    const sig = cryptoSign("sha256", Buffer.concat([ad, sha256(cd)]), opts.attestationKey ?? createPrivateKey(TEST_LEAF_KEY_PEM));
    attStmt = new Map<CborValue, CborValue>([["alg", COSE_ALG_ES256], ["sig", sig], ["x5c", opts.x5c ?? [new X509Certificate(TEST_LEAF_PEM).raw, new X509Certificate(TEST_INT_PEM).raw]]]);
  }
  const attestationObject = encodeCbor(new Map<CborValue, CborValue>([["fmt", fmt.startsWith("packed") ? "packed" : "none"], ["attStmt", attStmt], ["authData", ad]]));
  return { response: { clientDataJSON: cd, attestationObject }, key, id };
}

/** An assertion from `key` over `challenge`. */
function assert_(opts: { key: SoftKey; challenge: Uint8Array; flags?: number; signCount?: number; rpId?: string; client?: Record<string, unknown>; type?: string; signer?: KeyObject }) {
  const ad = authData({ rpId: opts.rpId, flags: opts.flags ?? FLAG_UP | FLAG_UV, signCount: opts.signCount });
  const cd = clientData(opts.type ?? "webauthn.get", opts.challenge, opts.client);
  return { clientDataJSON: cd, authenticatorData: ad, signature: signWith(opts.key.alg, opts.signer ?? opts.key.privateKey, Buffer.concat([ad, sha256(cd)])) };
}

const testStore = trustStore([TEST_ROOT_PEM]);
const yubico = trustStore(YUBICO_FIDO_ROOTS, YUBICO_FIDO_INTERMEDIATES);

function refuses(fn: () => unknown, reason: string): void {
  assert.throws(fn, (err: unknown) => err instanceof WebAuthnError && err.reason === reason, `expected a refusal for ${reason}`);
}

describe("cbor", () => {
  it("round-trips what WebAuthn carries", () => {
    const v = new Map<CborValue, CborValue>([[1, 2], [-3, Uint8Array.of(1, 2, 3)], ["fmt", "packed"], ["a", [1, -1, 300, 70000, true, false, null]]]);
    assert.deepEqual(decodeCbor(encodeCbor(v)), v);
  });

  it("says where an item ends, so the extensions after a COSE key can be found", () => {
    const one = encodeCbor(new Map<CborValue, CborValue>([[1, 2]]));
    const both = Buffer.concat([one, encodeCbor("ext")]);
    assert.equal(decodeCborPrefix(both).end, one.length);
  });

  it("refuses indefinite lengths, trailing bytes, duplicate keys, truncation and deep nesting", () => {
    assert.throws(() => decodeCbor(Uint8Array.of(0x5f, 0xff)), CborError);
    assert.throws(() => decodeCbor(Uint8Array.of(0x01, 0x02)), CborError);
    assert.throws(() => decodeCbor(Uint8Array.of(0xa2, 0x01, 0x01, 0x01, 0x02)), CborError);
    assert.throws(() => decodeCbor(Uint8Array.of(0x58, 0x10, 0x00)), CborError);
    assert.throws(() => decodeCbor(new Uint8Array(40).fill(0x81)), CborError);
  });
});

describe("verifyRegistration", () => {
  const challenge = randomBytes(32);

  it("enrolls an unattested passkey that verified the user, and reports its flags", () => {
    const { response, id, key } = register({ challenge, flags: FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS });
    const r = verifyRegistration(response, expectation(challenge), testStore, NOW);
    assert.deepEqual(Buffer.from(r.credentialId), id);
    assert.deepEqual(Buffer.from(r.publicKey), Buffer.from(key.cose));
    assert.equal(r.alg, COSE_ALG_ES256);
    assert.deepEqual(r.attestation, { fmt: "none", verified: false });
    assert.equal(r.aaguid, "00000000-0000-0000-0000-000000000000");
    assert.equal(r.userVerified, true);
    assert.equal(r.backupEligible, true);
    assert.equal(r.backedUp, true);
  });

  for (const alg of [COSE_ALG_EDDSA, COSE_ALG_RS256]) {
    it(`accepts COSE algorithm ${alg}`, () => {
      const { response } = register({ challenge, key: softKey(alg), fmt: "packed-self" });
      assert.equal(verifyRegistration(response, expectation(challenge), testStore, NOW).alg, alg);
    });
  }

  it("refuses another challenge, another origin, the wrong type, another RP ID and a cross-origin frame", () => {
    refuses(() => verifyRegistration(register({ challenge }).response, expectation(randomBytes(32)), testStore, NOW), "challenge");
    refuses(() => verifyRegistration(register({ challenge, client: { origin: "https://brane.organelle.dev" } }).response, expectation(challenge), testStore, NOW), "origin");
    refuses(() => verifyRegistration(register({ challenge, client: { origin: `https://${RP_ID}` } }).response, expectation(challenge), testStore, NOW), "origin");
    refuses(() => verifyRegistration(register({ challenge, type: "webauthn.get" }).response, expectation(challenge), testStore, NOW), "type");
    refuses(() => verifyRegistration(register({ challenge, rpId: "evil.example" }).response, expectation(challenge), testStore, NOW), "rp-id");
    refuses(() => verifyRegistration(register({ challenge, client: { crossOrigin: true } }).response, expectation(challenge), testStore, NOW), "origin");
  });

  it("refuses a credential made with nobody present", () => {
    refuses(() => verifyRegistration(register({ challenge, flags: FLAG_UV }).response, expectation(challenge), testStore, NOW), "user-presence");
  });

  it("refuses an unattested credential that did not verify the user: it could never prove anything", () => {
    refuses(() => verifyRegistration(register({ challenge, flags: FLAG_UP }).response, expectation(challenge), testStore, NOW), "user-verification");
  });

  it("verifies packed attestation up to a trusted root, and then accepts touch alone", () => {
    const { response } = register({ challenge, flags: FLAG_UP, fmt: "packed-x5c", aaguid: aaguidBytes(TEST_AAGUID) });
    const r = verifyRegistration(response, expectation(challenge), testStore, NOW);
    assert.equal(r.attestation.verified, true);
    assert.match(r.attestation.root ?? "", /Brane Test Attestation Root root/);
    assert.equal(r.aaguid, TEST_AAGUID);
    assert.equal(r.userVerified, false);
  });

  it("finds an intermediate the x5c left out among the store's helpers", () => {
    const { response } = register({ challenge, fmt: "packed-x5c", aaguid: aaguidBytes(TEST_AAGUID), x5c: [new X509Certificate(TEST_LEAF_PEM).raw] });
    assert.equal(verifyRegistration(response, expectation(challenge), testStore, NOW).attestation.verified, false);
    assert.equal(verifyRegistration(response, expectation(challenge), trustStore([TEST_ROOT_PEM], [TEST_INT_PEM]), NOW).attestation.verified, true);
  });

  it("treats a chain to an untrusted root as unattested, not as an error", () => {
    const { response } = register({ challenge, fmt: "packed-x5c", aaguid: aaguidBytes(TEST_AAGUID) });
    assert.deepEqual(verifyRegistration(response, expectation(challenge), trustStore([TEST_OTHER_PEM]), NOW).attestation, { fmt: "packed", verified: false });
  });

  it("an untrusted chain is not attestation, so touch alone is refused", () => {
    const { response } = register({ challenge, flags: FLAG_UP, fmt: "packed-x5c", aaguid: aaguidBytes(TEST_AAGUID) });
    refuses(() => verifyRegistration(response, expectation(challenge), trustStore([TEST_OTHER_PEM]), NOW), "user-verification");
  });

  it("refuses an attestation signature by another key, and a certificate vouching for another model", () => {
    const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    refuses(() => verifyRegistration(register({ challenge, fmt: "packed-x5c", aaguid: aaguidBytes(TEST_AAGUID), attestationKey: stranger }).response, expectation(challenge), testStore, NOW), "attestation");
    refuses(() => verifyRegistration(register({ challenge, fmt: "packed-x5c", aaguid: randomBytes(16) }).response, expectation(challenge), testStore, NOW), "attestation");
  });

  it("counts packed self attestation as unattested", () => {
    const { response } = register({ challenge, fmt: "packed-self" });
    assert.deepEqual(verifyRegistration(response, expectation(challenge), testStore, NOW).attestation, { fmt: "packed", verified: false });
  });

  it("refuses a chain once it has expired", () => {
    const { response } = register({ challenge, fmt: "packed-x5c", aaguid: aaguidBytes(TEST_AAGUID) });
    assert.equal(verifyRegistration(response, expectation(challenge), testStore, Date.UTC(2200, 0, 1)).attestation.verified, false);
  });

  it("reads the AAGUID extension of an attestation certificate", () => {
    assert.equal(Buffer.from(certificateAaguid(new X509Certificate(TEST_LEAF_PEM)) ?? []).toString("hex"), TEST_AAGUID.replace(/-/g, ""));
    assert.equal(certificateAaguid(new X509Certificate(TEST_ROOT_PEM)), null);
  });
});

// Two registrations a real YubiKey made (Firefox, rp "localhost"), from
// py_webauthn's suite (https://github.com/duo-labs/py_webauthn, BSD-3-Clause,
// © Duo Security): what a key actually sends, chained to Yubico's own root.
const YUBIKEY_PACKED = {
  attestationObject:
    "o2NmbXRmcGFja2VkZ2F0dFN0bXSjY2FsZyZjc2lnWEcwRQIhAOfrFlQpbavT6dJeTDJSCDzYSYPjBDHli2-syT2c1IiKAiAx5gQ2z5cHjdQX-jEHTb7JcjfQoVSW8fXszF5ihSgeOGN4NWOBWQLBMIICvTCCAaWgAwIBAgIEKudiYzANBgkqhkiG9w0BAQsFADAuMSwwKgYDVQQDEyNZdWJpY28gVTJGIFJvb3QgQ0EgU2VyaWFsIDQ1NzIwMDYzMTAgFw0xNDA4MDEwMDAwMDBaGA8yMDUwMDkwNDAwMDAwMFowbjELMAkGA1UEBhMCU0UxEjAQBgNVBAoMCVl1YmljbyBBQjEiMCAGA1UECwwZQXV0aGVudGljYXRvciBBdHRlc3RhdGlvbjEnMCUGA1UEAwweWXViaWNvIFUyRiBFRSBTZXJpYWwgNzE5ODA3MDc1MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKgOGXmBD2Z4R_xCqJVRXhL8Jr45rHjsyFykhb1USGozZENOZ3cdovf5Ke8fj2rxi5tJGn_VnW4_6iQzKdIaeP6NsMGowIgYJKwYBBAGCxAoCBBUxLjMuNi4xLjQuMS40MTQ4Mi4xLjEwEwYLKwYBBAGC5RwCAQEEBAMCBDAwIQYLKwYBBAGC5RwBAQQEEgQQbUS6m_bsLkm5MAyP6SDLczAMBgNVHRMBAf8EAjAAMA0GCSqGSIb3DQEBCwUAA4IBAQByV9A83MPhFWmEkNb4DvlbUwcjc9nmRzJjKxHc3HeK7GvVkm0H4XucVDB4jeMvTke0WHb_jFUiApvpOHh5VyMx5ydwFoKKcRs5x0_WwSWL0eTZ5WbVcHkDR9pSNcA_D_5AsUKOBcbpF5nkdVRxaQHuuIuwV4k1iK2IqtMNcU8vL6w21U261xCcWwJ6sMq4zzVO8QCKCQhsoIaWrwz828GDmPzfAjFsJiLJXuYivdHACkeJ5KHMt0mjVLpfJ2BCML7_rgbmvwL7wBW80VHfNdcKmKjkLcpEiPzwcQQhiN_qHV90t-p4iyr5xRSpurlP5zic2hlRkLKxMH2_kRjhqSn4aGF1dGhEYXRhWMRJlg3liA6MaHQ0Fw9kdmBbj-SuuaKGMseZXPO6gx2XY0UAAAA0bUS6m_bsLkm5MAyP6SDLcwBAsyGQPDZRUYdb4m3rdWeyPaIMYlbmydGp1TP_33vE_lqJ3PHNyTd0iKsnKr5WjnCcBzcesZrDEfB_RBLFzU3k46UBAgMmIAEhWCBAX_i3O3DvBnkGq_uLNk_PeAX5WwO_MIxBp0mhX6Lw7yJYIOW-1-Fch829McWvRUYAHTWZTx5IycKSGECL1UzUaK_8",
  clientDataJSON:
    "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiOExCQ2lPWTNxMWNCWkhGQVd0UzRBWlpDaHpHcGh5NjdsSzdJNzB6S2k0eUM3cGdyUTJQY2g3bkFqTGsxd3E5Z3Jlc2hJQXNXMkFqaWJoWGpqSTBUbVEiLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
  challenge: "8LBCiOY3q1cBZHFAWtS4AZZChzGphy67lK7I70zKi4yC7pgrQ2Pch7nAjLk1wq9greshIAsW2AjibhXjjI0TmQ",
};
const YUBIKEY_U2F = {
  attestationObject:
    "o2NmbXRoZmlkby11MmZnYXR0U3RtdKJjc2lnWEcwRQIhAIJO_x-FicMO0XDFwnVfXWyF-Dp7GW7oL43QfZyUjKU0AiAxQBUFu17l9rmKmqAWnHL6F1dDaIu54WYc9Mi_jtdNL2N4NWOBWQLBMIICvTCCAaWgAwIBAgIEKudiYzANBgkqhkiG9w0BAQsFADAuMSwwKgYDVQQDEyNZdWJpY28gVTJGIFJvb3QgQ0EgU2VyaWFsIDQ1NzIwMDYzMTAgFw0xNDA4MDEwMDAwMDBaGA8yMDUwMDkwNDAwMDAwMFowbjELMAkGA1UEBhMCU0UxEjAQBgNVBAoMCVl1YmljbyBBQjEiMCAGA1UECwwZQXV0aGVudGljYXRvciBBdHRlc3RhdGlvbjEnMCUGA1UEAwweWXViaWNvIFUyRiBFRSBTZXJpYWwgNzE5ODA3MDc1MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKgOGXmBD2Z4R_xCqJVRXhL8Jr45rHjsyFykhb1USGozZENOZ3cdovf5Ke8fj2rxi5tJGn_VnW4_6iQzKdIaeP6NsMGowIgYJKwYBBAGCxAoCBBUxLjMuNi4xLjQuMS40MTQ4Mi4xLjEwEwYLKwYBBAGC5RwCAQEEBAMCBDAwIQYLKwYBBAGC5RwBAQQEEgQQbUS6m_bsLkm5MAyP6SDLczAMBgNVHRMBAf8EAjAAMA0GCSqGSIb3DQEBCwUAA4IBAQByV9A83MPhFWmEkNb4DvlbUwcjc9nmRzJjKxHc3HeK7GvVkm0H4XucVDB4jeMvTke0WHb_jFUiApvpOHh5VyMx5ydwFoKKcRs5x0_WwSWL0eTZ5WbVcHkDR9pSNcA_D_5AsUKOBcbpF5nkdVRxaQHuuIuwV4k1iK2IqtMNcU8vL6w21U261xCcWwJ6sMq4zzVO8QCKCQhsoIaWrwz828GDmPzfAjFsJiLJXuYivdHACkeJ5KHMt0mjVLpfJ2BCML7_rgbmvwL7wBW80VHfNdcKmKjkLcpEiPzwcQQhiN_qHV90t-p4iyr5xRSpurlP5zic2hlRkLKxMH2_kRjhqSn4aGF1dGhEYXRhWMRJlg3liA6MaHQ0Fw9kdmBbj-SuuaKGMseZXPO6gx2XY0EAAAAAAAAAAAAAAAAAAAAAAAAAAABAlrjqbPdLbWXTJ2sFIreka9aWd2ED-SDx_VAgBAh4XmCJgjCjudEjoi42pGQd-_Bi6nNPQ3T7-xOEgty2I3m7c6UBAgMmIAEhWCDpQmUwrGnn3mk-T27A6awwL4HJG62Plj8Hz-lL0KltuiJYILwFIu48iEB8Ov6mEAqtCxn3mQOoaGIG4eidiWyLRg05",
  clientDataJSON:
    "eyJjaGFsbGVuZ2UiOiJaSlZObG1Pclh3d2dRa2QxZ0RNbHk4QklpSU1WNElRRERzQ3I2S1BiQ0lIY09aNXdhS0htLU1adHVZNzQ4U0NxZy1OWlZwUnJZRnlGcmMzNmdRb0Z0dyIsImNsaWVudEV4dGVuc2lvbnMiOnt9LCJoYXNoQWxnb3JpdGhtIjoiU0hBLTI1NiIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTAwMCIsInR5cGUiOiJ3ZWJhdXRobi5jcmVhdGUifQ",
  challenge: "ZJVNlmOrXwwgQkd1gDMly8BIiIMV4IQDDsCr6KPbCIHcOZ5waKHm-MZtuY748SCqg-NZVpRrYFyFrc36gQoFtw",
};

function realKey(v: { attestationObject: string; clientDataJSON: string; challenge: string }) {
  return {
    response: { attestationObject: Buffer.from(v.attestationObject, "base64url"), clientDataJSON: Buffer.from(v.clientDataJSON, "base64url") },
    expect: { challenge: Buffer.from(v.challenge, "base64url"), origins: ["http://localhost:5000"], rpId: "localhost" },
  };
}

describe("a real YubiKey against the vendored Yubico roots", () => {
  it("verifies packed attestation to the Yubico U2F root", () => {
    const { response, expect } = realKey(YUBIKEY_PACKED);
    const r = verifyRegistration(response, expect, yubico, NOW);
    assert.deepEqual(r.attestation, { fmt: "packed", verified: true, root: "CN=Yubico U2F Root CA Serial 457200631" });
    assert.equal(r.aaguid, "6d44ba9b-f6ec-2e49-b930-0c8fe920cb73");
  });

  it("verifies fido-u2f attestation, touch alone", () => {
    const { response, expect } = realKey(YUBIKEY_U2F);
    const r = verifyRegistration(response, expect, yubico, NOW);
    assert.equal(r.attestation.verified, true);
    assert.equal(r.userVerified, false);
  });

  it("the same key is unattested under any other root", () => {
    const { response, expect } = realKey(YUBIKEY_PACKED);
    assert.equal(verifyRegistration(response, expect, testStore, NOW).attestation.verified, false);
  });

  it("every vendored intermediate chains to Yubico Attestation Root 1", () => {
    for (const pem of YUBICO_FIDO_INTERMEDIATES) {
      const root = chainRoot(new X509Certificate(pem), [], yubico, NOW);
      assert.equal(root?.subject, "CN=Yubico Attestation Root 1");
    }
  });
});

describe("verifyAssertion", () => {
  const challenge = randomBytes(32);
  const key = softKey();
  const stored = { publicKey: key.cose, signCount: 0, attested: false };

  it("accepts a proof that verified the user", () => {
    const r = verifyAssertion(assert_({ key, challenge }), stored, expectation(challenge));
    assert.deepEqual(r, { signCount: 0, userVerified: true, backedUp: false });
  });

  it("refuses touch alone from an unattested credential, accepts it from an attested one", () => {
    refuses(() => verifyAssertion(assert_({ key, challenge, flags: FLAG_UP }), stored, expectation(challenge)), "user-verification");
    assert.equal(verifyAssertion(assert_({ key, challenge, flags: FLAG_UP }), { ...stored, attested: true }, expectation(challenge)).userVerified, false);
  });

  it("refuses another key's signature, another challenge, another origin, another RP ID, the wrong type", () => {
    const other = softKey();
    refuses(() => verifyAssertion(assert_({ key, challenge, signer: other.privateKey }), stored, expectation(challenge)), "signature");
    refuses(() => verifyAssertion(assert_({ key, challenge }), stored, expectation(randomBytes(32))), "challenge");
    refuses(() => verifyAssertion(assert_({ key, challenge, client: { origin: "https://evil.example" } }), stored, expectation(challenge)), "origin");
    refuses(() => verifyAssertion(assert_({ key, challenge, rpId: "evil.example" }), stored, expectation(challenge)), "rp-id");
    refuses(() => verifyAssertion(assert_({ key, challenge, type: "webauthn.create" }), stored, expectation(challenge)), "type");
    refuses(() => verifyAssertion(assert_({ key, challenge, flags: FLAG_UV }), stored, expectation(challenge)), "user-presence");
  });

  it("ignores a sign count that has only ever been 0, and enforces one that has moved", () => {
    assert.equal(verifyAssertion(assert_({ key, challenge, signCount: 0 }), stored, expectation(challenge)).signCount, 0);
    assert.equal(verifyAssertion(assert_({ key, challenge, signCount: 3 }), stored, expectation(challenge)).signCount, 3);
    assert.equal(verifyAssertion(assert_({ key, challenge, signCount: 6 }), { ...stored, signCount: 5 }, expectation(challenge)).signCount, 6);
    refuses(() => verifyAssertion(assert_({ key, challenge, signCount: 5 }), { ...stored, signCount: 5 }, expectation(challenge)), "sign-count");
    refuses(() => verifyAssertion(assert_({ key, challenge, signCount: 0 }), { ...stored, signCount: 5 }, expectation(challenge)), "sign-count");
  });

  for (const alg of [COSE_ALG_EDDSA, COSE_ALG_RS256]) {
    it(`verifies COSE algorithm ${alg}`, () => {
      const k = softKey(alg);
      assert.equal(verifyAssertion(assert_({ key: k, challenge }), { publicKey: k.cose, signCount: 0, attested: false }, expectation(challenge)).userVerified, true);
    });
  }
});

describe("coseToPublicKey", () => {
  it("refuses algorithms outside the accepted three, and keys that do not match their algorithm", () => {
    refuses(() => coseToPublicKey(encodeCbor(new Map<CborValue, CborValue>([[1, 2], [3, -35]]))), "algorithm");
    refuses(() => coseToPublicKey(encodeCbor(new Map<CborValue, CborValue>([[1, 1], [3, COSE_ALG_ES256], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]))), "public-key");
    refuses(() => coseToPublicKey(encodeCbor(new Map<CborValue, CborValue>([[1, 2], [3, COSE_ALG_ES256], [-1, 1], [-2, new Uint8Array(31)], [-3, new Uint8Array(32)]]))), "public-key");
    refuses(() => coseToPublicKey(Uint8Array.of(0xff)), "public-key");
  });
});
