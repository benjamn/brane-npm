/**
 * `GET /api/payloads/:nid/:filename`: how one stored payload becomes a
 * response. Kept out of `server.ts` so the suite can drive it on a file of
 * its own, without a daemon.
 *
 * Every payload is streamed with `Range` support. A video needs it: Safari
 * will not play media at all until a `bytes=0-1` probe comes back as a 206,
 * and seeking anywhere is a range request. Images don't, but one code path
 * for every payload is simpler than two, and costs an image nothing.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Readable } from "node:stream";
import { parseRangeHeader } from "../files/browse.js";
import { attachmentDisposition, servesPayloadInline } from "../shared/payload-inline.js";

export type PayloadResponse =
  | { status: 200 | 206; headers: Record<string, string>; stream: Readable }
  | { status: 404 | 416; error: string; headers?: Record<string, string> };

/** The response for the payload at `filePath`, stored under `filename` (its
 *  path relative to the narrative's payload directory, which names the
 *  type). `range` is the request's `Range` header. A path that is not a
 *  regular file is a 404, as a missing one is. */
export async function payloadResponse(
  filePath: string,
  filename: string,
  range: string | null | undefined,
  mimeTypes: Record<string, string>,
): Promise<PayloadResponse> {
  let size: number;
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return { status: 404, error: "Payload not found" };
    size = st.size;
  } catch {
    return { status: 404, error: "Payload not found" };
  }

  const headers: Record<string, string> = {
    "Content-Type": mimeTypes[extname(filename).toLowerCase()] ?? "application/octet-stream",
    // A payload is written once and never changed, so its URL is immutable.
    // A browser caches the ranges it fetched under the same rule.
    "Cache-Control": "public, max-age=31536000, immutable",
    // A payload URL carries `?token=`. Whatever the browser does with
    // this response, it must not become a *document* on this origin:
    // that puts the token in the address bar, and in the base URL a
    // "Save Page As" rewrites the page's relative links against.
    // Payloads the app does not render are therefore attachments, and the
    // ones it does — images, `.svg` among them, and videos — are
    // sandboxed, which costs nothing (a document CSP does not apply to an
    // `<img>` or `<video>` load) and makes a directly-navigated SVG inert.
    "Content-Security-Policy": "sandbox",
    "Accept-Ranges": "bytes",
  };
  if (!servesPayloadInline(filename)) {
    headers["Content-Disposition"] = attachmentDisposition(basename(filename));
  }

  const window = parseRangeHeader(range, size);
  if (window === "unsatisfiable") {
    return { status: 416, error: "Range not satisfiable", headers: { "Content-Range": `bytes */${size}` } };
  }
  if (window === "ignore") {
    headers["Content-Length"] = String(size);
    return { status: 200, headers, stream: createReadStream(filePath) };
  }
  headers["Content-Length"] = String(window.end - window.start + 1);
  headers["Content-Range"] = `bytes ${window.start}-${window.end}/${size}`;
  return { status: 206, headers, stream: createReadStream(filePath, { start: window.start, end: window.end }) };
}
