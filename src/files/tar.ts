// Tar, read as a stream of 512-byte headers with the data between them skipped
// rather than kept. A `.tar` is read from the file directly; a `.tar.gz` (or
// `.br`, `.zst`) from its decoder, which has to run the whole archive through
// once to list it, since compressed tar has no index. The scan is bounded in
// bytes and members, and a member's body is decoded only as far as a request
// reaches (`bytes.ts`).
//
// Understood: ustar (with its name prefix), GNU long names and link names
// (`L`, `K`), pax extended headers (`x`: path, linkpath, size, mtime), and
// base-256 sizes. Everything else is listed as what it is and not opened.

import type { Readable } from "node:stream";
import type { MemberKind, RawMember } from "./archive-types.js";
import type { ByteSource } from "./bytes.js";

const BLOCK = 512;
/** A long name or pax header bigger than this is not a name. */
const MAX_META_BYTES = 64 * 1024;

export class TarFormatError extends Error {}

export interface TarScanLimits {
  maxEntries: number;
  /** Bytes of (decoded) archive the listing may read before stopping. */
  maxScanBytes: number;
}

/** A body at `offset` within the (decoded) archive stream. */
export type TarBodyOpener = (offset: number, size: number, mtimeMs: number) => ByteSource;

interface Pending {
  path?: string;
  linkpath?: string;
  size?: number;
  mtimeMs?: number;
}

function cstr(b: Buffer, start: number, len: number): string {
  const end = b.indexOf(0, start);
  return b.toString("utf8", start, end < 0 || end > start + len ? start + len : end);
}

function octal(b: Buffer, start: number, len: number): number {
  // Base-256: the high bit of the first byte set, big-endian after it.
  if (b[start] & 0x80) {
    let n = b[start] & 0x7f;
    for (let i = 1; i < len; i++) {
      n = n * 256 + b[start + i];
      if (n > Number.MAX_SAFE_INTEGER) throw new TarFormatError("size out of range");
    }
    return n;
  }
  const s = cstr(b, start, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarFormatError(`bad octal field "${s}"`);
  return parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  let stored: number;
  try {
    stored = octal(h, 148, 8);
  } catch {
    return false;
  }
  return sum === stored;
}

function parsePax(body: Buffer, into: Pending): void {
  let p = 0;
  while (p < body.length) {
    const sp = body.indexOf(0x20, p);
    if (sp < 0) break;
    const len = parseInt(body.toString("utf8", p, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || p + len > body.length) break;
    const rec = body.toString("utf8", sp + 1, p + len - 1); // drop the "\n"
    const eq = rec.indexOf("=");
    if (eq > 0) {
      const key = rec.slice(0, eq);
      const value = rec.slice(eq + 1);
      if (key === "path") into.path = value;
      else if (key === "linkpath") into.linkpath = value;
      else if (key === "size" && /^\d+$/.test(value)) into.size = Number(value);
      else if (key === "mtime" && Number.isFinite(Number(value))) into.mtimeMs = Number(value) * 1000;
    }
    p += len;
  }
}

function kindOf(type: string): MemberKind {
  switch (type) {
    case "0": case "\0": case "7": return "file";
    case "5": return "dir";
    case "2": return "symlink";
    case "1": return "hardlink";
    default: return "other";
  }
}

/** Reads `stream` as tar, listing every member. The first header must pass
 *  its checksum, so a file that isn't tar is refused at the first block. */
export async function scanTar(
  stream: Readable,
  openBody: TarBodyOpener,
  limits: TarScanLimits,
): Promise<{ members: RawMember[]; partial: boolean }> {
  const members: RawMember[] = [];
  let partial = false;
  let pending: Pending = {};

  // `buf` holds decoded bytes [pos, pos + buf.length): only ever what the next
  // header or a pending metadata body still needs. Member data is never
  // buffered; chunks that fall wholly inside it are dropped as they arrive.
  let buf: Buffer = Buffer.alloc(0);
  let pos = 0;
  let streamPos = 0;
  /** Where the next header starts. */
  let next = 0;
  /** A metadata body (long name, pax) being collected, and what it is for. */
  let meta: { type: string; size: number; at: number } | null = null;
  let done = false;
  const want = () => (meta ? meta.at : next);

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const chunkStart = streamPos;
      streamPos += chunk.length;
      if (buf.length === 0) {
        if (streamPos <= want()) {
          pos = streamPos;
          if (streamPos > limits.maxScanBytes) { partial = true; done = true; break; }
          continue;
        }
        const from = Math.max(0, want() - chunkStart);
        buf = chunk.subarray(from);
        pos = chunkStart + from;
      } else {
        buf = Buffer.concat([buf, chunk]);
      }
      for (;;) {
        if (meta) {
          const end = meta.at + meta.size;
          if (pos + buf.length < end) break;
          const body = buf.subarray(meta.at - pos, end - pos);
          if (meta.type === "x") parsePax(body, pending);
          else if (meta.type === "L") pending.path = cstr(body, 0, body.length);
          else if (meta.type === "K") pending.linkpath = cstr(body, 0, body.length);
          meta = null;
        }
        if (next > limits.maxScanBytes) { partial = true; done = true; break; }
        if (pos + buf.length < next + BLOCK) break;
        const h = buf.subarray(next - pos, next - pos + BLOCK);
        if (h.every((b) => b === 0)) { done = true; break; }
        if (!checksumOk(h)) {
          if (next === 0) throw new TarFormatError("not a tar archive");
          // A corrupt header mid-archive: what came before it still stands.
          partial = true;
          done = true;
          break;
        }
        const type = String.fromCharCode(h[156]);
        const headerSize = octal(h, 124, 12);
        const dataAt = next + BLOCK;
        const isMeta = type === "x" || type === "L" || type === "K" || type === "g";
        const size = isMeta ? headerSize : pending.size ?? headerSize;
        next = dataAt + Math.ceil(size / BLOCK) * BLOCK;

        if (type === "x" || type === "L" || type === "K") {
          if (size > MAX_META_BYTES) throw new TarFormatError("oversized extended header");
          meta = { type, size, at: dataAt };
        } else if (type === "g") {
          // Global pax header: nothing in it changes what we show.
        } else {
          if (members.length >= limits.maxEntries) { partial = true; done = true; break; }
          const magic = h.toString("latin1", 257, 262);
          const prefix = magic === "ustar" ? cstr(h, 345, 155) : "";
          const base = cstr(h, 0, 100);
          const name = pending.path ?? (prefix ? `${prefix}/${base}` : base);
          const kind = kindOf(type);
          const mtimeMs = pending.mtimeMs ?? octal(h, 136, 12) * 1000;
          const link = pending.linkpath ?? cstr(h, 157, 100);
          members.push({
            name,
            kind,
            size: kind === "file" ? size : null,
            mtimeMs,
            link: kind === "symlink" || kind === "hardlink" ? link : undefined,
            open: kind === "file" ? () => openBody(dataAt, size, mtimeMs) : undefined,
          });
          pending = {};
        }
        const keepFrom = want();
        if (keepFrom >= pos + buf.length) {
          pos += buf.length;
          buf = Buffer.alloc(0);
          break;
        }
        buf = buf.subarray(keepFrom - pos);
        pos = keepFrom;
      }
      if (done) break;
    }
  } finally {
    stream.destroy();
  }
  if (!done) {
    if (members.length === 0) throw new TarFormatError("not a tar archive");
    // Ended inside a member: the archive was cut short.
    if (streamPos < next) partial = true;
  }
  return { members, partial };
}
