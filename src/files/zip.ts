// Zip, read from its central directory. The directory at the end of the file
// lists every member with its size and where its bytes start, so a listing
// decompresses nothing, and opening a member inflates that member alone.
//
// Nothing here trusts the file: every offset is checked against the file's
// real size before it is read, sizes a member claims are only displayed, and
// a member's body is inflated only as far as a request reaches.

import { MAX_STREAM_REACH, deferredSource, fileSource, readAt, streamSource, type ByteSource } from "./bytes.js";
import { openDecoded } from "./codecs.js";
import type { RawMember } from "./archive-types.js";

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** A central directory past this is refused rather than read into memory. At
 *  ~80 bytes a record it is some 800,000 members. */
const MAX_CENTRAL_DIR = 64 * 1024 * 1024;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;

export class ZipFormatError extends Error {}

export class MemberError extends Error {}

interface Eocd {
  entries: number;
  cdSize: number;
  cdOffset: number;
  /** Bytes prepended before the zip proper (a self-extractor's stub), by which
   *  every recorded offset is short. */
  shift: number;
}

async function findEocd(path: string, size: number): Promise<Eocd> {
  if (size < EOCD_MIN) throw new ZipFormatError("too small to be a zip");
  const tailLen = Math.min(size, EOCD_SEARCH);
  const tailStart = size - tailLen;
  const tail = await readAt(path, tailStart, tailLen);
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = tail.readUInt16LE(i + 20);
    if (i + EOCD_MIN + commentLen > tail.length) continue;
    const eocdPos = tailStart + i;
    let entries = tail.readUInt16LE(i + 10);
    let cdSize = tail.readUInt32LE(i + 12);
    let cdOffset = tail.readUInt32LE(i + 16);
    let recordEnd = eocdPos;
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const z64 = await readZip64(path, eocdPos);
      if (z64) ({ entries, cdSize, cdOffset, recordEnd } = z64);
    }
    // In a well-formed zip the central directory ends where the end record
    // (or its zip64 twin) begins. Past that is a prepended stub.
    const shift = recordEnd - (cdOffset + cdSize);
    if (shift < 0) throw new ZipFormatError("central directory overruns the end record");
    return { entries, cdSize, cdOffset, shift };
  }
  throw new ZipFormatError("no end-of-central-directory record");
}

async function readZip64(path: string, eocdPos: number): Promise<{ entries: number; cdSize: number; cdOffset: number; recordEnd: number } | null> {
  if (eocdPos < 20) return null;
  const loc = await readAt(path, eocdPos - 20, 20);
  if (loc.readUInt32LE(0) !== SIG_EOCD64_LOCATOR) return null;
  const recordEnd = eocdPos - 20;
  // The locator's offset is unshifted too; the record sits just before it.
  const at = recordEnd - 56;
  if (at < 0) throw new ZipFormatError("zip64 record out of range");
  const rec = await readAt(path, at, 56);
  if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new ZipFormatError("bad zip64 end record");
  return {
    entries: safeNumber(rec.readBigUInt64LE(32)),
    cdSize: safeNumber(rec.readBigUInt64LE(40)),
    cdOffset: safeNumber(rec.readBigUInt64LE(48)),
    recordEnd: at,
  };
}

function safeNumber(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError("zip64 field out of range");
  return Number(n);
}

function dosTime(date: number, time: number): number {
  if (date === 0) return 0;
  return new Date(
    (date >> 9) + 1980, ((date >> 5) & 15) - 1, date & 31,
    time >> 11, (time >> 5) & 63, (time & 31) * 2,
  ).getTime();
}

/** Every member of the zip at `path`, in directory order, names undecoded by
 *  any policy — `archive.ts` decides which names are safe to show. */
export async function listZip(path: string, size: number, maxEntries: number): Promise<{ members: RawMember[]; partial: boolean }> {
  const eocd = await findEocd(path, size);
  const { cdSize, shift } = eocd;
  const cdStart = eocd.cdOffset + shift;
  if (cdSize > MAX_CENTRAL_DIR) throw new ZipFormatError("central directory too large");
  if (cdStart + cdSize > size) throw new ZipFormatError("central directory out of range");
  const cd = await readAt(path, cdStart, cdSize);

  const members: RawMember[] = [];
  let partial = false;
  let p = 0;
  while (p + 46 <= cd.length && members.length < eocd.entries) {
    if (members.length >= maxEntries) { partial = true; break; }
    if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipFormatError("bad central directory record");
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const mtimeMs = dosTime(cd.readUInt16LE(p + 14), cd.readUInt16LE(p + 12));
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const extAttr = cd.readUInt32LE(p + 38);
    let localOffset = cd.readUInt32LE(p + 42);
    const nameAt = p + 46;
    const extraAt = nameAt + nameLen;
    const next = extraAt + extraLen + commentLen;
    if (next > cd.length) throw new ZipFormatError("central directory record overruns");
    const name = cd.toString("utf8", nameAt, extraAt);

    // zip64: the fields that overflowed 32 bits appear, in this order, in
    // extra block 0x0001.
    if (usize === 0xffffffff || csize === 0xffffffff || localOffset === 0xffffffff) {
      let e = extraAt;
      const eEnd = extraAt + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let f = e + 4;
          const fEnd = Math.min(e + 4 + len, eEnd);
          const take = (): number => {
            if (f + 8 > fEnd) throw new ZipFormatError("short zip64 extra field");
            const v = safeNumber(cd.readBigUInt64LE(f));
            f += 8;
            return v;
          };
          if (usize === 0xffffffff) usize = take();
          if (csize === 0xffffffff) csize = take();
          if (localOffset === 0xffffffff) localOffset = take();
          break;
        }
        e += 4 + len;
      }
    }

    const unixMode = (madeBy >> 8) === 3 ? extAttr >>> 16 : 0;
    const isDir = name.endsWith("/") || (unixMode & 0o170000) === 0o040000;
    const isLink = (unixMode & 0o170000) === 0o120000;
    const member = zipMember(path, size, {
      localOffset: localOffset + shift, csize, usize, method, encrypted: (flags & 1) !== 0, mtimeMs,
    });
    members.push({
      name,
      kind: isDir ? "dir" : isLink ? "symlink" : "file",
      size: isDir ? null : usize,
      mtimeMs,
      open: member.open,
      readLink: isLink ? member.readLink : undefined,
    });
    p = next;
  }
  return { members, partial };
}

interface ZipEntryInfo {
  localOffset: number;
  csize: number;
  usize: number;
  method: number;
  encrypted: boolean;
  mtimeMs: number;
}

/** Where a member's bytes start: past its local header, whose name and extra
 *  lengths may differ from the central directory's copy. */
async function dataStart(path: string, fileSize: number, e: ZipEntryInfo): Promise<number> {
  if (e.localOffset + 30 > fileSize) throw new MemberError("member header out of range");
  const h = await readAt(path, e.localOffset, 30);
  if (h.length < 30 || h.readUInt32LE(0) !== SIG_LOCAL) throw new MemberError("bad local header");
  const start = e.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  if (start + e.csize > fileSize) throw new MemberError("member data out of range");
  return start;
}

function zipMember(path: string, fileSize: number, e: ZipEntryInfo) {
  const open = (): ByteSource => {
    if (e.encrypted) throw new MemberError("This member is encrypted");
    if (e.method !== 0 && e.method !== 8) {
      throw new MemberError(`Compression method ${e.method} is not supported (only stored and deflate)`);
    }
    // The local header is read on first use, not at listing time: a listing
    // of 50,000 members should cost one read, not 50,001.
    let start: Promise<number> | null = null;
    const where = () => (start ??= dataStart(path, fileSize, e));
    if (e.method === 0) {
      return deferredSource(e.usize, e.mtimeMs, async () => fileSource(path, e.csize, e.mtimeMs, await where()));
    }
    return deferredSource(e.usize, e.mtimeMs, async () => {
      const s = await where();
      return streamSource(
        () => openDecoded(path, "deflate-raw", s, s + Math.max(0, e.csize - 1)),
        e.csize === 0 ? 0 : null,
        e.mtimeMs,
        0,
        MAX_STREAM_REACH,
      );
    });
  };
  const readLink = async (): Promise<string> => {
    const buf = await open().read(0, 4096);
    return buf.toString("utf8");
  };
  return { open, readLink };
}
