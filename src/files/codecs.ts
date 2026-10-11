// The decompressors the Files view uses, all of them Node's own zlib. No
// archive tool is ever shelled out to: `unzip` and `bsdtar` are C with CVE
// histories, and bsdtar in particular auto-detects dozens of formats nobody
// asked it to parse.

import { createReadStream } from "node:fs";
import { pipeline, type Readable } from "node:stream";
import * as zlib from "node:zlib";

export type Codec = "gzip" | "brotli" | "zstd" | "deflate-raw";

/** zstd arrived in Node 22.15 / 23.8. Below that, `.zst` files are simply
 *  not archives, and open as the binary they are. */
const createZstd = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream })
  .createZstdDecompress;
export const HAS_ZSTD = typeof createZstd === "function";

function decompressor(codec: Codec): NodeJS.ReadWriteStream {
  switch (codec) {
    case "gzip": return zlib.createGunzip();
    case "brotli": return zlib.createBrotliDecompress();
    case "deflate-raw": return zlib.createInflateRaw();
    case "zstd":
      if (!createZstd) throw new Error("zstd is not supported by this Node");
      return createZstd();
  }
}

/** Bytes of `path` (or of bytes [start, end] of it), decoded by `codec` —
 *  or as they are, for null. The pipeline is torn down whole when the returned
 *  stream is destroyed, so a reader that stops early leaves no handle behind. */
export function openDecoded(path: string, codec: Codec | null, start?: number, end?: number): Readable {
  const src = createReadStream(path, start === undefined ? {} : { start, end });
  if (codec === null) return src;
  return pipeline(src, decompressor(codec), () => {}) as unknown as Readable;
}
