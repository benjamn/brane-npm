/**
 * The CBOR WebAuthn needs, and no more: an `attestationObject` and a COSE
 * public key are small definite-length maps of integers, byte strings, text
 * and arrays (CTAP2's canonical encoding, RFC 8949 §4.2). Written here
 * rather than taken from npm, as the passkey spike's verifier was
 * (docs/passkeys.md, Evidence): the daemon checks every proof itself, with
 * no new dependency (claude-pbg4whll:33).
 *
 * Less obvious than it looks:
 *
 * - **`decode` returns where it stopped.** In `authenticatorData` the COSE
 *   key is followed by the extensions map with no length in between, so the
 *   only way to find the extensions is to know how many bytes the key took.
 * - **Indefinite lengths are refused**, as are 64-bit lengths beyond what a
 *   buffer can hold. CTAP2 forbids the former, and an authenticator never
 *   needs the latter; a parser that accepted them would only be more surface.
 * - **Maps decode to `Map`**, never to objects: COSE keys are negative
 *   integers (`-2` is `x`), and an object would turn them into strings.
 * - **Nesting is capped**, so a hostile body cannot recurse the daemon's
 *   stack away.
 */

export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<CborValue, CborValue>;

const MAX_DEPTH = 16;

export class CborError extends Error {}

/** Decode one item at `offset`; returns it and the offset just past it. */
export function decodeCborPrefix(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
  const r = new Reader(bytes, offset);
  const value = r.item(0);
  return { value, end: r.pos };
}

/** Decode exactly one item that fills `bytes`. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const { value, end } = decodeCborPrefix(bytes);
  if (end !== bytes.length) throw new CborError(`${bytes.length - end} trailing bytes after the CBOR item`);
  return value;
}

class Reader {
  constructor(
    private readonly bytes: Uint8Array,
    public pos: number,
  ) {}

  private byte(): number {
    if (this.pos >= this.bytes.length) throw new CborError("CBOR ends early");
    return this.bytes[this.pos++];
  }

  private take(n: number): Uint8Array {
    if (n > this.bytes.length - this.pos) throw new CborError("CBOR ends early");
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** The argument of a head: the length, the integer, or the simple value. */
  private argument(info: number): number | bigint {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) return (this.byte() << 8) | this.byte();
    if (info === 26) {
      const b = this.take(4);
      return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
    }
    if (info === 27) {
      const b = this.take(8);
      let v = 0n;
      for (const x of b) v = (v << 8n) | BigInt(x);
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    if (info === 31) throw new CborError("indefinite-length CBOR is not accepted");
    throw new CborError(`reserved CBOR additional info ${info}`);
  }

  private length(info: number): number {
    const n = this.argument(info);
    if (typeof n === "bigint" || n > this.bytes.length - this.pos) throw new CborError("CBOR length runs past the end");
    return n;
  }

  item(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new CborError("CBOR nests too deeply");
    const head = this.byte();
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0:
        return this.argument(info);
      case 1: {
        const n = this.argument(info);
        return typeof n === "bigint" ? -1n - n : -1 - n;
      }
      case 2:
        return this.take(this.length(info)).slice();
      case 3:
        return new TextDecoder("utf-8", { fatal: true }).decode(this.take(this.length(info)));
      case 4: {
        const n = this.length(info);
        const out: CborValue[] = [];
        for (let i = 0; i < n; i++) out.push(this.item(depth + 1));
        return out;
      }
      case 5: {
        const n = this.length(info);
        const out = new Map<CborValue, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = this.item(depth + 1);
          if (out.has(k)) throw new CborError("duplicate key in a CBOR map");
          out.set(k, this.item(depth + 1));
        }
        return out;
      }
      case 6:
        // A tag: WebAuthn defines none, so read through to the tagged item.
        this.argument(info);
        return this.item(depth + 1);
      default:
        return this.simple(info);
    }
  }

  private simple(info: number): CborValue {
    switch (info) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      case 25: {
        const b = this.take(2);
        return halfToNumber((b[0] << 8) | b[1]);
      }
      case 26:
        return new DataView(this.take(4).slice().buffer).getFloat32(0);
      case 27:
        return new DataView(this.take(8).slice().buffer).getFloat64(0);
      default:
        throw new CborError(`unsupported CBOR simple value ${info}`);
    }
  }
}

function halfToNumber(h: number): number {
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/** Encode, for the suite's authenticators and nothing in the daemon's path:
 *  integers, byte and text strings, arrays, maps, booleans and null. */
export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  write(value, out);
  return Uint8Array.from(out);
}

function head(major: number, n: number, out: number[]): void {
  const m = major << 5;
  if (n < 24) out.push(m | n);
  else if (n < 0x100) out.push(m | 24, n);
  else if (n < 0x10000) out.push(m | 25, n >> 8, n & 0xff);
  else if (n < 0x100000000) out.push(m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  else throw new CborError("encodeCbor: integer too large");
}

function write(v: CborValue, out: number[]): void {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new CborError("encodeCbor: integers only");
    if (v >= 0) head(0, v, out);
    else head(1, -1 - v, out);
  } else if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    head(3, b.length, out);
    out.push(...b);
  } else if (v instanceof Uint8Array) {
    head(2, v.length, out);
    for (const x of v) out.push(x);
  } else if (Array.isArray(v)) {
    head(4, v.length, out);
    for (const x of v) write(x, out);
  } else if (v instanceof Map) {
    head(5, v.size, out);
    for (const [k, x] of v) {
      write(k, out);
      write(x, out);
    }
  } else if (v === false) out.push(0xf4);
  else if (v === true) out.push(0xf5);
  else if (v === null) out.push(0xf6);
  else throw new CborError(`encodeCbor: unsupported value ${String(v)}`);
}
