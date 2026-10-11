// GET /api/files/find: search a file's bytes, all of them, for the hex view.
//
// 🔎 on a hex page used to search the text in the DOM, which knew only the
// pages already loaded, split every string that wrapped a row, and read
// `cffaedfe` as four letters rather than four bytes. This reads the bytes
// themselves, through the same ByteSource the hex page does, so an archive
// member or a `.gz` body is searched as it is shown.
//
// What it returns is bounded by *pages*, not by the file: hits from at most
// the first FIND_PAGE_WINDOW hex pages that contain any. A one-byte query in
// a 2 GB binary stops after a megabyte of hits instead of reading two
// gigabytes to produce hits nobody will visit, and the reader asks for the
// next window if they want it (`from`).

import { HEX_PAGE_BYTES } from "../shared/hex-dump.js";
import { MAX_FIND_MATCHES, isCaseSensitive } from "../shared/find-in-text.js";
import { ReachError, type ByteSource } from "./bytes.js";

/** Distinct hex pages a search window may put hits on. 64 pages is 1 MB: as
 *  much as the hex view will hold at once. */
export const FIND_PAGE_WINDOW = 64;

/** The longest needle, in bytes. */
export const MAX_NEEDLE_BYTES = 256;

/** How long one request may scan before it hands back a `next` offset. */
export const FIND_TIME_BUDGET_MS = 30_000;

/** How often a scan reports how far it has read. */
export const FIND_PROGRESS_MS = 250;

/** Scans running at once, daemon-wide. A new one past this supersedes the
 *  oldest rather than being refused: the likeliest reason there are three is
 *  a reader typing, whose earlier queries nobody is waiting on. */
export const MAX_CONCURRENT_FINDS = 2;

export interface ByteNeedle {
  kind: "text" | "hex";
  bytes: Buffer;
  /** Match ASCII letters in either case (`bytes` is then lowercase). */
  caseless: boolean;
}

/** `cf fa ed fe`, `cffaedfe`, `0xCAFE`: an even run of hex digits, spaces
 *  allowed between bytes. */
const HEX_QUERY = /^\s*(?:0x)?((?:[0-9a-f]{2}\s*)+)$/i;

/** What a query asks for, as bytes. Always its UTF-8 text, smart-case as 🔎 is
 *  everywhere else; and, when it reads as hex, those bytes too — `cafe` is
 *  both the word and 0xCA 0xFE, and the reader gets both. The query is not
 *  trimmed, as in `findMatches`: a trailing space is part of what's asked. */
export function parseByteQuery(query: string): ByteNeedle[] {
  if (!query) return [];
  const needles: ByteNeedle[] = [];
  const caseless = !isCaseSensitive(query);
  const text = Buffer.from(caseless ? asciiLower(query) : query, "utf8");
  needles.push({ kind: "text", bytes: text, caseless });
  const hex = HEX_QUERY.exec(query);
  if (hex) {
    // Never the same bytes as the text: 2n hex digits spell n bytes.
    needles.push({ kind: "hex", bytes: Buffer.from(hex[1].replace(/\s+/g, ""), "hex"), caseless: false });
  }
  return needles;
}

/** Lowercase A–Z only. `toLowerCase` would fold `İ` into two code points and
 *  shift every byte after it. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

function foldAscii(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out[i] = b >= 0x41 && b <= 0x5a ? b | 0x20 : b;
  }
  return out;
}

/** A hit: `[offset, length]` in bytes. */
export type ByteHit = [number, number];

export type FindStop =
  /** Read to the end of the file. */
  | "eof"
  /** The next hit would have been on page FIND_PAGE_WINDOW + 1. */
  | "pages"
  /** MAX_FIND_MATCHES hits. */
  | "hits"
  /** FIND_TIME_BUDGET_MS spent. */
  | "time"
  /** The decompression reach limit, in a compressed body. */
  | "reach"
  /** The client went away, or a newer scan took the slot: an interrupted
   *  search, whose `next` resumes it, never a complete one. */
  | "cancelled";

export type FindEvent =
  | { type: "hits"; hits: ByteHit[] }
  | { type: "progress"; scanned: number }
  | {
      type: "done";
      stop: FindStop;
      /** Where the scan read up to. */
      scanned: number;
      /** Where to resume: the first hit not returned, or where reading
       *  stopped. Null when nothing is left (eof, reach). */
      next: number | null;
    }
  /** The scan failed after the stream opened. */
  | { type: "error"; error: string };

export interface ScanOptions {
  signal?: AbortSignal;
  pageBytes?: number;
  maxPages?: number;
  maxHits?: number;
  budgetMs?: number;
  progressMs?: number;
  now?: () => number;
}

/** Search `source` from `from` for any of `needles`, reporting hits in offset
 *  order. Hits of one needle don't overlap; hits of two needles may.
 *
 *  Order is exact even across the chunks the file is read in: a hit is
 *  reported only once every needle that could start before it has been
 *  seen whole, so the tail of each chunk (one byte short of the longest
 *  needle) waits for the next. That's what lets the page count be a running
 *  count, and `next` a place to resume that skips nothing. */
export async function scanSource(
  source: ByteSource,
  needles: readonly ByteNeedle[],
  from: number,
  emit: (event: FindEvent) => void,
  opts: ScanOptions = {},
): Promise<Extract<FindEvent, { type: "done" }>> {
  const pageBytes = opts.pageBytes ?? HEX_PAGE_BYTES;
  const maxPages = opts.maxPages ?? FIND_PAGE_WINDOW;
  const maxHits = opts.maxHits ?? MAX_FIND_MATCHES;
  const budgetMs = opts.budgetMs ?? FIND_TIME_BUDGET_MS;
  const progressMs = opts.progressMs ?? FIND_PROGRESS_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  let lastProgress = started;

  const done = (stop: FindStop, scanned: number, next: number | null) => {
    const event = { type: "done" as const, stop, scanned, next };
    emit(event);
    return event;
  };
  if (needles.length === 0) return done("eof", from, null);

  const longest = Math.max(...needles.map((n) => n.bytes.length));
  const anyCaseless = needles.some((n) => n.caseless);
  // Per needle, where its next hit may start: the end of its last one.
  const allowed = needles.map(() => from);
  let hitCount = 0;
  let pages = 0;
  let lastPage = -1;

  // `carry` holds the bytes at [base, readTo) not yet ruled out as the start
  // of a hit.
  let carry: Buffer = Buffer.alloc(0);
  let base = from;
  let readTo = from;

  /** Report the hits starting before `limit` in carry+chunk, or stop. */
  const settle = (buf: Buffer, limit: number): Extract<FindEvent, { type: "done" }> | null => {
    const folded = anyCaseless ? foldAscii(buf) : null;
    const found: Array<{ at: number; len: number; n: number }> = [];
    needles.forEach((needle, n) => {
      const hay = needle.caseless ? folded! : buf;
      let i = Math.max(0, allowed[n] - base);
      while (true) {
        const at = hay.indexOf(needle.bytes, i);
        if (at < 0 || base + at >= limit) break;
        found.push({ at: base + at, len: needle.bytes.length, n });
        i = at + needle.bytes.length;
      }
    });
    found.sort((a, b) => a.at - b.at || a.n - b.n);
    const hits: ByteHit[] = [];
    let stop: Extract<FindEvent, { type: "done" }> | null = null;
    for (const f of found) {
      if (f.at < allowed[f.n]) continue;
      const first = Math.floor(f.at / pageBytes);
      const last = Math.floor((f.at + f.len - 1) / pageBytes);
      const added = (last > lastPage ? last - Math.max(first, lastPage + 1) + 1 : 0);
      if (hitCount >= maxHits) {
        stop = { type: "done", stop: "hits", scanned: readTo, next: f.at };
        break;
      }
      if (pages + added > maxPages) {
        stop = { type: "done", stop: "pages", scanned: readTo, next: f.at };
        break;
      }
      pages += added;
      lastPage = Math.max(lastPage, last);
      hitCount++;
      allowed[f.n] = f.at + f.len;
      hits.push([f.at, f.len]);
    }
    if (hits.length) emit({ type: "hits", hits });
    if (stop) emit(stop);
    return stop;
  };

  try {
    for await (const chunk of source.chunks(from)) {
      // Resume where nothing has been ruled out yet: `carry` still holds
      // bytes that may start a hit not reported.
      if (opts.signal?.aborted) return done("cancelled", readTo, base);
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      readTo += chunk.length;
      // A hit starting at or past `limit` might not be whole yet.
      const limit = readTo - (longest - 1);
      const stop = settle(buf, limit);
      if (stop) return stop;
      const keepFrom = Math.max(base, limit);
      carry = buf.subarray(keepFrom - base);
      base = keepFrom;
      const t = now();
      if (t - started >= budgetMs) {
        return done("time", readTo, base);
      }
      if (t - lastProgress >= progressMs) {
        lastProgress = t;
        emit({ type: "progress", scanned: readTo });
      }
    }
  } catch (e) {
    if (!(e instanceof ReachError)) throw e;
    return settle(carry, readTo) ?? done("reach", readTo, null);
  }
  if (opts.signal?.aborted) return done("cancelled", readTo, base);
  return settle(carry, Infinity) ?? done("eof", readTo, null);
}

/** At most MAX_CONCURRENT_FINDS scans at once; admitting one past that
 *  cancels the oldest. */
export class FindSlots {
  private readonly running = new Set<AbortController>();
  constructor(private readonly max = MAX_CONCURRENT_FINDS) {}

  /** A signal for the new scan, and the release to call when it ends. */
  admit(): { signal: AbortSignal; release: () => void } {
    while (this.running.size >= this.max) {
      const oldest = this.running.values().next().value!;
      this.running.delete(oldest);
      oldest.abort();
    }
    const c = new AbortController();
    this.running.add(c);
    return { signal: c.signal, release: () => this.running.delete(c) };
  }

  get size(): number {
    return this.running.size;
  }
}

/** Parse `q`: the query, or why it can't be searched. */
export function parseFindQuery(q: string | null): ByteNeedle[] | { error: string } {
  if (!q) return { error: "q is required" };
  const needles = parseByteQuery(q);
  if (needles.some((n) => n.bytes.length > MAX_NEEDLE_BYTES)) {
    return { error: `The query is longer than ${MAX_NEEDLE_BYTES} bytes` };
  }
  return needles;
}
