// GET /api/files, as a function of (fold, path, options) → answer, so the
// whole route can be tested without HTTP. The server does only the lookup of
// the narrative's fold and the writing of what comes back.
//
// Every file — on disk, inside an archive, behind a `.gz` — is served through
// one `respondWithSource`, which is why a format added in `archive.ts` gains
// text, highlighting, images, the hex view and download all at once.

import { readdir, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { detectLanguage, highlight } from "../highlight.js";
import { BINARY_SNIFF_BYTES, HEX_PAGE_BYTES, looksBinary } from "../shared/hex-dump.js";
import { ReachError, fileSource, streamSource, type ByteSource } from "./bytes.js";
import { openDecoded } from "./codecs.js";
import { archiveFormatFor, archiveIndex, normalizeMemberName, type ArchiveFormat, type ArchiveIndex, type ArchiveNode } from "./archive.js";
import { MemberError } from "./zip.js";

/** Text is sent inline up to this size; past it, a notice and a download. */
export const MAX_INLINE = 2 * 1024 * 1024;

export interface DirEntry {
  name: string;
  is_dir: boolean;
  size: number | null;
  mtime: number;
  /** Opens as a folder: a zip- or tar-family archive. */
  archive?: true;
  /** A symbolic or hard link inside an archive, and where it points. */
  link?: string;
}

/** Where a path inside an archive sits. `root` is the archive's own path. */
export interface ArchiveInfo {
  root: string;
  format: string;
  /** Members hidden because their names were unsafe to place. */
  skipped?: number;
  /** The listing stopped at a limit or the archive was cut short. */
  partial?: true;
}

export interface HexPage {
  offset: number;
  /** Base64 of up to HEX_PAGE_BYTES bytes. */
  data: string;
  /** No bytes follow this page. */
  eof: boolean;
}

export type FilesJson =
  | { type: "directory"; path: string; entries: DirEntry[]; archive?: ArchiveInfo }
  | {
      type: "file";
      path: string;
      /** Null when only decompressing would tell (a `.gz` body). */
      size: number | null;
      mtime: number;
      content: string;
      truncated?: boolean;
      binary?: boolean;
      highlight?: unknown;
      hex?: HexPage;
      link?: string;
      /** Why this file can't be shown (encrypted member, unsupported method). */
      notice?: string;
      archive?: ArchiveInfo;
    };

/** The bytes of a raw answer. `size` is the whole body's length when it is
 *  known without decoding (null for a `.gz` body), which is what lets the
 *  server send `Content-Length` and offer ranges. `range` is the window
 *  actually served, inclusive, when the request asked for one. */
export interface RawAnswer {
  stream: Readable;
  contentType: string;
  size: number | null;
  range?: ByteWindow;
}

export interface ByteWindow {
  start: number;
  end: number;
}

export type BrowseResult =
  | { status: number; json: FilesJson | { error: string } }
  | { status: 200 | 206; raw: RawAnswer };

export interface BrowseOptions {
  /** Stream the bytes (an `<img src>`, a download) instead of JSON. */
  raw?: boolean;
  /** The request's `Range` header, honored for raw answers of known size. */
  range?: string | null;
  /** Serve a hex page at this byte offset. */
  offset?: number | null;
  /** Extension → MIME type, for raw responses and to spot images, PDFs and audio. */
  mimeTypes: Record<string, string>;
}

const err = (status: number, error: string): BrowseResult => ({ status, json: { error } });

/** Parse `offset=`: a non-negative safe integer, or undefined when absent. */
export function parseOffsetParam(v: string | null): number | null | undefined {
  if (v === null) return null;
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** One `Range` header against a body of `size` bytes: `bytes=a-b`, `bytes=a-`
 *  or `bytes=-n`, resolved to an inclusive window. A header this doesn't
 *  understand — several ranges, a unit other than bytes, a start past its end
 *  — is `ignore`, and the whole body goes out as if nothing had been asked,
 *  which the spec allows a server. A window that starts past the end is
 *  `unsatisfiable` (416). Ranges are what let a browser seek in media, and
 *  what Safari requires before it will play any: it probes with `bytes=0-1`. */
export function parseRangeHeader(header: string | null | undefined, size: number): ByteWindow | "ignore" | "unsatisfiable" {
  if (!header) return "ignore";
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(header);
  if (!m) return "ignore";
  const [, a, b] = m;
  if (a === "" && b === "") return "ignore";
  if (a === "") {
    // A suffix: the last n bytes.
    const n = Number(b);
    if (!Number.isSafeInteger(n) || n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return "ignore";
  if (start >= size) return "unsatisfiable";
  if (end < start) return "ignore";
  return { start, end };
}

/** The first `count` bytes of `chunks`, and no more: a body claimed to be
 *  `size` bytes is sent as exactly that many, so `Content-Length` and the
 *  bytes agree even when an archive's claim is wrong. Stopping early returns
 *  the iterator, which destroys whatever stream is behind it. */
async function* take(chunks: AsyncIterable<Buffer>, count: number): AsyncIterable<Buffer> {
  let left = count;
  if (left <= 0) return;
  for await (const chunk of chunks) {
    if (chunk.length >= left) {
      yield chunk.subarray(0, left);
      return;
    }
    left -= chunk.length;
    yield chunk;
  }
}

/** The request's path confined to the fold, or why it can't be. */
function confine(foldRoot: string, relParam: string): { target: string; normRel: string } | { status: number; error: string } {
  if (relParam.startsWith("/") || relParam.startsWith("\\")) return { status: 400, error: "Absolute paths not allowed" };
  const cleanRel = relParam.split("#")[0].split("?")[0];
  const target = resolve(foldRoot, cleanRel);
  if (target !== foldRoot && !target.startsWith(foldRoot + "/")) return { status: 400, error: "Path escapes fold" };
  // Echo a NORMALIZED relative path: resolve() already collapsed any
  // `.`/`..`/`//` segments, so the breadcrumb never renders `fold/./blah`.
  return { target, normRel: relative(foldRoot, target) };
}

export async function browseFold(foldRoot: string, relParam: string, opts: BrowseOptions): Promise<BrowseResult> {
  const where = confine(foldRoot, relParam);
  if ("error" in where) return err(where.status, where.error);
  const { target, normRel } = where;

  let st;
  try {
    st = await stat(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
    return browseInsideArchive(foldRoot, normRel, opts);
  }

  if (st.isDirectory()) {
    return { status: 200, json: { type: "directory", path: normRel, entries: await listDirectory(target) } };
  }

  const format = archiveFormatFor(normRel);
  if (format?.kind === "single" && !opts.raw) {
    // A `.gz` opens as what it compresses. `raw` still means the file itself.
    const source = streamSource(() => openDecoded(target, format.codec), null, st.mtimeMs);
    return respondWithSource(source, normRel, format.inner, opts);
  }
  if (format && format.kind !== "single" && !opts.raw && (opts.offset ?? null) === null) {
    try {
      const index = await archiveIndex(target, format);
      return archiveDirectory(index, "", normRel, archiveInfo(normRel, format, index));
    } catch {
      // Not what its name says: show it as the file it is.
    }
  }
  return respondWithSource(fileSource(target, st.size, st.mtimeMs), normRel, normRel, opts);
}

async function listDirectory(dir: string): Promise<DirEntry[]> {
  const names = await readdir(dir);
  const entries = await Promise.all(
    names
      .filter((n) => !n.startsWith(".")) // hide dotfiles by default
      .map(async (name): Promise<DirEntry | null> => {
        try {
          const child = await stat(resolve(dir, name));
          const isDir = child.isDirectory();
          const fmt = isDir ? null : archiveFormatFor(name);
          return {
            name,
            is_dir: isDir,
            size: isDir ? null : child.size,
            mtime: child.mtimeMs,
            ...(fmt && fmt.kind !== "single" ? { archive: true as const } : {}),
          };
        } catch {
          return null;
        }
      }),
  );
  return sortEntries(entries.filter((e): e is DirEntry => e !== null));
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function archiveInfo(root: string, format: ArchiveFormat, index: ArchiveIndex): ArchiveInfo {
  return {
    root,
    format: format.label,
    ...(index.skipped ? { skipped: index.skipped } : {}),
    ...(index.partial ? { partial: true as const } : {}),
  };
}

function archiveDirectory(index: ArchiveIndex, inner: string, normRel: string, info: ArchiveInfo): BrowseResult {
  const kids = index.children.get(inner);
  if (!kids) return err(404, "Not found");
  const entries: DirEntry[] = [];
  for (const node of kids.values()) {
    // Dotfiles are hidden as they are in the fold — which also keeps macOS's
    // `._name` AppleDouble twins out of every tarball made on a Mac.
    if (node.name.startsWith(".")) continue;
    const isDir = node.kind === "dir";
    entries.push({
      name: node.name,
      is_dir: isDir,
      size: isDir ? null : node.size,
      mtime: node.mtimeMs,
      ...(node.member?.link ? { link: node.member.link } : {}),
    });
  }
  return { status: 200, json: { type: "directory", path: normRel, entries: sortEntries(entries), archive: info } };
}

/** `normRel` doesn't exist on disk. If a prefix of it is an archive, the rest
 *  names a member. Archives do not nest: a member that is itself a zip opens
 *  as its bytes. */
async function browseInsideArchive(foldRoot: string, normRel: string, opts: BrowseOptions): Promise<BrowseResult> {
  const found = await locateMember(foldRoot, normRel);
  if (!found) return err(404, "Not found");
  const { index, node, inner, info } = found;
  return browseMember(index, node, inner, normRel, info, opts);
}

/** The archive member `normRel` names, when a prefix of it is an archive. */
async function locateMember(foldRoot: string, normRel: string): Promise<{ index: ArchiveIndex; node: ArchiveNode; inner: string; info: ArchiveInfo } | null> {
  const segs = normRel.split("/");
  for (let i = segs.length - 1; i >= 1; i--) {
    const prefix = segs.slice(0, i).join("/");
    const format = archiveFormatFor(prefix);
    let st;
    try {
      st = await stat(resolve(foldRoot, prefix));
    } catch {
      continue;
    }
    if (!st.isFile() || !format || format.kind === "single") return null;
    let index: ArchiveIndex;
    try {
      index = await archiveIndex(resolve(foldRoot, prefix), format);
    } catch {
      return null;
    }
    const inner = segs.slice(i).join("/");
    const node = index.nodes.get(inner);
    return node ? { index, node, inner, info: archiveInfo(prefix, format, index) } : null;
  }
  return null;
}

/** A tar hard link names an earlier member of the same archive; that one
 *  lookup is as far as it goes. */
function hardlinkTarget(index: ArchiveIndex, node: ArchiveNode): ArchiveNode | undefined {
  const to = node.member?.link;
  const resolved = to === undefined ? undefined : index.nodes.get(normalizeMemberName(to) ?? "\0");
  return resolved?.kind === "file" ? resolved : undefined;
}

/** The bytes the hex view shows for `relParam` — a file, an archive member,
 *  a `.gz` body — for a search to read. A search reads what the view reads,
 *  or its hits would name offsets the view has never heard of. */
export async function openFoldSource(foldRoot: string, relParam: string): Promise<ByteSource | { status: number; error: string }> {
  const where = confine(foldRoot, relParam);
  if ("error" in where) return where;
  const { target, normRel } = where;
  let st;
  try {
    st = await stat(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
    const found = await locateMember(foldRoot, normRel);
    if (!found) return { status: 404, error: "Not found" };
    const node = found.node.kind === "hardlink" ? hardlinkTarget(found.index, found.node) : found.node;
    if (node?.kind !== "file" || !node.member?.open) return { status: 400, error: "Not a file with contents" };
    try {
      return node.member.open();
    } catch (e) {
      if (e instanceof MemberError) return { status: 400, error: e.message };
      throw e;
    }
  }
  if (!st.isFile()) return { status: 400, error: "Not a file" };
  const format = archiveFormatFor(normRel);
  if (format?.kind === "single") return streamSource(() => openDecoded(target, format.codec), null, st.mtimeMs);
  return fileSource(target, st.size, st.mtimeMs);
}

async function browseMember(
  index: ArchiveIndex,
  node: ArchiveNode,
  inner: string,
  normRel: string,
  info: ArchiveInfo,
  opts: BrowseOptions,
): Promise<BrowseResult> {
  if (node.kind === "dir") return archiveDirectory(index, inner, normRel, info);
  const plain = (extra: Partial<Extract<FilesJson, { type: "file" }>>): BrowseResult => ({
    status: 200,
    json: { type: "file", path: normRel, size: node.size, mtime: node.mtimeMs, content: "", archive: info, ...extra },
  });

  let target: ArchiveNode = node;
  if (node.kind === "symlink") {
    // Shown, never followed: a link's target is the archive author's claim
    // about a filesystem that doesn't exist here.
    let link = node.member?.link;
    if (link === undefined && node.member?.readLink) {
      link = await node.member.readLink().catch(() => undefined);
    }
    return plain({ size: 0, link: link ?? "" });
  }
  if (node.kind === "hardlink") {
    const resolved = hardlinkTarget(index, node);
    if (!resolved) return plain({ size: 0, link: node.member?.link ?? "" });
    target = resolved;
  }
  if (target.kind !== "file" || !target.member?.open) {
    return plain({ notice: "A special file (device, FIFO or similar), which has no contents to show" });
  }
  let source: ByteSource;
  try {
    source = target.member.open();
  } catch (e) {
    if (e instanceof MemberError) return plain({ notice: e.message });
    throw e;
  }
  const res = await respondWithSource(source, normRel, inner, opts);
  if ("json" in res && res.status === 200 && res.json && (res.json as FilesJson).type === "file") {
    (res.json as Extract<FilesJson, { type: "file" }>).archive = info;
  }
  return res;
}

/** The one place a file's bytes become a response. `name` decides the MIME
 *  type and the highlighter; it differs from `normRel` for a `.gz` body. */
export async function respondWithSource(
  source: ByteSource,
  normRel: string,
  name: string,
  opts: BrowseOptions,
): Promise<BrowseResult> {
  const mime = opts.mimeTypes[extname(name).toLowerCase()];
  const base = { type: "file" as const, path: normRel, size: source.size, mtime: source.mtimeMs };

  if (opts.raw) {
    const contentType = mime ?? "application/octet-stream";
    const size = source.size;
    // Unknown size (a `.gz` body): the whole thing, chunked, as before.
    if (size === null) return { status: 200, raw: { stream: source.stream(), contentType, size } };
    const window = parseRangeHeader(opts.range, size);
    if (window === "unsatisfiable") return err(416, "Range not satisfiable");
    if (window === "ignore") {
      return { status: 200, raw: { stream: Readable.from(take(source.stream(), size)), contentType, size } };
    }
    // `chunks(start)` rather than `stream()`: it is the one way to begin
    // mid-body, for a file and an archive member alike.
    const stream = Readable.from(take(source.chunks(window.start), window.end - window.start + 1));
    return { status: 206, raw: { stream, contentType, size, range: window } };
  }

  const offset = opts.offset ?? null;
  if (offset !== null) return hexPage(source, base, offset);

  // Images, PDFs, fonts and audio render from a raw URL; the JSON only says so.
  const rendersFromRaw = mime?.startsWith("image/") || mime?.startsWith("audio/") || mime === "application/pdf" || mime === "font/woff" || mime === "font/woff2";
  if (rendersFromRaw) {
    return {
      status: 200,
      json: { ...base, binary: true, truncated: source.size !== null && source.size > MAX_INLINE, content: "" },
    };
  }

  const head = await source.read(0, BINARY_SNIFF_BYTES);
  if (looksBinary(head)) return hexPage(source, base, 0);

  if (source.size !== null && source.size > MAX_INLINE) {
    return { status: 200, json: { ...base, truncated: true, content: "" } };
  }
  // One byte past the limit says whether a body of unknown size is too big.
  const body = source.size !== null && source.size <= BINARY_SNIFF_BYTES ? head : await source.read(0, MAX_INLINE + 1);
  if (body.length > MAX_INLINE) {
    return { status: 200, json: { ...base, truncated: true, content: "" } };
  }
  const data = body.toString("utf8");
  // detectLanguage returns null for markdown and unknown types, so markdown
  // (rendered client-side by MarkdownContent) and plain text both skip the
  // highlighter without a special case here.
  const lang = detectLanguage(name);
  const hi = lang
    ? await highlight(data, lang).catch((e) => {
        console.warn(`[files] highlight failed for ${normRel} (${lang}):`, e);
        return null;
      })
    : null;
  return { status: 200, json: { ...base, size: source.size ?? body.length, content: data, highlight: hi } };
}

async function hexPage(
  source: ByteSource,
  base: { type: "file"; path: string; size: number | null; mtime: number },
  offset: number,
): Promise<BrowseResult> {
  let bytes: Buffer;
  let notice: string | undefined;
  try {
    // One byte past the page says whether another follows.
    bytes = await source.read(offset, HEX_PAGE_BYTES + 1);
  } catch (e) {
    if (!(e instanceof ReachError)) throw e;
    bytes = Buffer.alloc(0);
    notice = e.message;
  }
  const eof = bytes.length <= HEX_PAGE_BYTES;
  const page = eof ? bytes : bytes.subarray(0, HEX_PAGE_BYTES);
  return {
    status: 200,
    json: {
      ...base,
      binary: true,
      content: "",
      hex: { offset, data: page.toString("base64"), eof },
      ...(notice ? { notice } : {}),
    },
  };
}
