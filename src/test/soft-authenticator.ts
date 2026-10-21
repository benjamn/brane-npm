/**
 * A software WebAuthn authenticator for the suite: what a browser would post
 * back to the daemon, built from node:crypto keys, in the JSON shape the
 * ceremony page sends (base64url fields). Not a test file itself.
 */

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign, X509Certificate, type KeyObject } from "node:crypto";
import { encodeCbor, type CborValue } from "../webauthn/cbor.js";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;

export class SoftAuthenticator {
  readonly id = randomBytes(32);
  private readonly privateKey: KeyObject;
  readonly cose: Uint8Array;
  signCount = 0;

  constructor(
    readonly rpId: string,
    readonly origin: string,
    /** Attestation: a leaf certificate chain and its key, or none. */
    private readonly attestation?: { x5c: string[]; keyPem: string; aaguid: string },
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.cose = encodeCbor(new Map<CborValue, CborValue>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  private authData(flags: number, withCredential: boolean): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.signCount);
    const parts: Uint8Array[] = [sha256(Buffer.from(this.rpId)), Uint8Array.of(flags), count];
    if (withCredential) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.id.length);
      const aaguid = this.attestation ? Buffer.from(this.attestation.aaguid.replace(/-/g, ""), "hex") : Buffer.alloc(16);
      parts.push(aaguid, len, this.id, this.cose);
    }
    return Buffer.concat(parts);
  }

  /** `credential.response` for `POST /api/credentials`. */
  create(challenge: string, flags = FLAG_UP | FLAG_UV): { response: Record<string, unknown> } {
    const cd = this.clientData("webauthn.create", challenge);
    const ad = this.authData(flags | FLAG_AT, true);
    let fmt = "none";
    let attStmt = new Map<CborValue, CborValue>();
    if (this.attestation) {
      fmt = "packed";
      const sig = cryptoSign("sha256", Buffer.concat([ad, sha256(cd)]), createPrivateKey(this.attestation.keyPem));
      attStmt = new Map<CborValue, CborValue>([["alg", -7], ["sig", sig], ["x5c", this.attestation.x5c.map((p) => new X509Certificate(p).raw)]]);
    }
    const attestationObject = encodeCbor(new Map<CborValue, CborValue>([["fmt", fmt], ["attStmt", attStmt], ["authData", ad]]));
    return { response: { clientDataJSON: b64u(cd), attestationObject: b64u(attestationObject), transports: ["usb", "bogus"] } };
  }

  /** `credential` for `POST /api/verify/webauthn`. */
  get(challenge: string, flags = FLAG_UP | FLAG_UV): { rawId: string; response: Record<string, unknown> } {
    const cd = this.clientData("webauthn.get", challenge);
    const ad = this.authData(flags, false);
    const signature = cryptoSign("sha256", Buffer.concat([ad, sha256(cd)]), this.privateKey);
    return { rawId: b64u(this.id), response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(signature) } };
  }
}
