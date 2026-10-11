// A ByteSource is anything the Files view can open: a file in the fold, a
// member of an archive, the decompressed body of a `.gz`. Every renderer —
// text, highlighting, images, the hex view, a raw download — reads through
// this one interface, so a format added here is browsable everywhere at once.

import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

export interface ByteSource {
  /** The size, when it is known without decompressing. A `.gz` body's isn't,
   *  and an archive's claim about a member is only a claim. */
  readonly size: number | null;
  readonly mtimeMs: number;
  /** Up to `length` bytes from `offset`; fewer only at the end. */
  read(offset: number, length: number): Promise<Buffer>;
  /** The whole body as a stream, for a raw download. */
  stream(): Readable;
  /** The body from `from` to its end, in one pass: what a search reads. Unlike
   *  `stream()`, which ends quietly at the reach limit (a download of a bomb
   *  is a gigabyte and done), this throws ReachError there, so a search can
   *  say it stopped short rather than claim it read everything. */
  chunks(from: number): AsyncIterable<Buffer>;
}

/** Bytes a search reads from disk at a time. */
const SCAN_CHUNK_BYTES = 1024 * 1024;

/** A byte range of a file on disk, read by position. */
export function fileSource(path: string, size: number, mtimeMs: number, start = 0): ByteSource {
  return {
    size,
    mtimeMs,
    async read(offset, length) {
      const n = Math.max(0, Math.min(length, size - offset));
      if (n === 0) return Buffer.alloc(0);
      return readAt(path, start + offset, n);
    },
    stream() {
      if (size === 0) return Readable.from([]);
      return createReadStream(path, { start, end: start + size - 1 });
    },
    chunks(from) {
      if (from >= size) return Readable.from([]);
      return createReadStream(path, { start: start + from, end: start + size - 1, highWaterMark: SCAN_CHUNK_BYTES });
    },
  };
}

/** `length` bytes at `position` of a file, fewer only at its end. */
export async function readAt(path: string, position: number, length: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, position + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}

/** How far into a decompressed stream a read may reach. Reaching byte N of a
 *  compressed body means inflating every byte before it, so this bounds the
 *  CPU one request can spend: a page 10 GB into a zip bomb is refused rather
 *  than computed. */
export const MAX_STREAM_REACH = 1024 * 1024 * 1024;

export class ReachError extends Error {
  constructor(limit: number) {
    super(`That is more than ${Math.round(limit / 1024 / 1024)} MB into a compressed stream, further than brane will decompress`);
  }
}

/** Opens a fresh decompressed stream from its start. Every read opens one. */
export type StreamOpener = () => Readable | Promise<Readable>;

/** A body that can only be read front to back, at `start` within what `open`
 *  yields: each read decompresses from the beginning and tears the pipeline
 *  down once it has what it asked for. Nothing past the requested range is
 *  ever produced, and that is the whole defence against a decompression
 *  bomb — output is bounded by the request, never by what the archive claims. */
export function streamSource(
  openStream: StreamOpener,
  size: number | null,
  mtimeMs: number,
  start = 0,
  reach = MAX_STREAM_REACH,
): ByteSource {
  const bound = (offset: number, length: number): number => {
    if (size !== null) length = Math.max(0, Math.min(length, size - offset));
    const end = start + offset + length;
    if (end > reach) {
      if (start + offset >= reach) throw new ReachError(reach);
      length = reach - start - offset;
    }
    return length;
  };
  return {
    size,
    mtimeMs,
    async read(offset, length) {
      const n = bound(offset, length);
      if (n === 0) return Buffer.alloc(0);
      const parts: Buffer[] = [];
      for await (const chunk of sliceStream(openStream, start + offset, n)) parts.push(chunk);
      return Buffer.concat(parts);
    },
    stream() {
      // A download stops at the reach limit too: a bomb member streams a
      // gigabyte and ends, rather than inflating until the client gives up.
      const n = size ?? reach - start;
      return Readable.from(sliceStream(openStream, start, Math.min(n, reach - start)));
    },
    async *chunks(from) {
      const want = size === null ? Infinity : Math.max(0, size - from);
      const room = reach - start - from;
      if (want === 0) return;
      if (room <= 0) throw new ReachError(reach);
      // One byte past the reach limit says whether the body goes on past it.
      const take = Math.min(want, room + 1);
      let got = 0;
      for await (const chunk of sliceStream(openStream, start + from, take)) {
        const keep = Math.min(chunk.length, room - got);
        if (keep > 0) yield keep === chunk.length ? chunk : chunk.subarray(0, keep);
        got += chunk.length;
        if (got > room) throw new ReachError(reach);
      }
    },
  };
}

/** Bytes [start, start + length) of a freshly opened stream, as chunks. The
 *  stream is destroyed when the range is done or the consumer stops early. */
export async function* sliceStream(openStream: StreamOpener, start: number, length: number): AsyncGenerator<Buffer> {
  const stream = await openStream();
  let pos = 0;
  let left = length;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const end = pos + chunk.length;
      if (end > start && left > 0) {
        const from = Math.max(0, start - pos);
        const take = Math.min(chunk.length - from, left);
        yield chunk.subarray(from, from + take);
        left -= take;
      }
      pos = end;
      if (left <= 0) break;
    }
  } finally {
    stream.destroy();
  }
}

/** A source whose real reader needs an async step first (a zip member's local
 *  header). `size` is the archive's claim, shown but never relied on. */
export function deferredSource(size: number | null, mtimeMs: number, make: () => Promise<ByteSource>): ByteSource {
  let inner: Promise<ByteSource> | null = null;
  const get = () => (inner ??= make());
  return {
    size,
    mtimeMs,
    async read(offset, length) {
      return (await get()).read(offset, length);
    },
    stream() {
      return Readable.from((async function* () {
        yield* (await get()).stream() as AsyncIterable<Buffer>;
      })());
    },
    async *chunks(from) {
      yield* (await get()).chunks(from);
    },
  };
}
