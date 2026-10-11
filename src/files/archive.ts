// Archives as directories. A path that runs through an archive —
// `dist/app.zip/src/main.ts` — names a member, and the archive itself lists
// as a folder. Nothing is ever extracted: members are listed from the index
// the format keeps (zip) or from one pass over the stream (tar), and read
// through a `ByteSource` that decodes only as far as a request reaches.
//
// Member names are data from the archive's author, so this is where they are
// made safe to show. A name that is absolute has its leading slashes dropped;
// one containing `..` or a NUL is hidden and counted (`skipped`), since there
// is no honest place in the tree to draw it. Since nothing is written to
// disk, none of this is what stops zip-slip — there is no slip to stop — it
// only keeps the tree the operator sees from lying about where a member sits.

import { stat } from "node:fs/promises";
import { fileSource, streamSource } from "./bytes.js";
import { HAS_ZSTD, openDecoded, type Codec } from "./codecs.js";
import type { MemberKind, RawMember } from "./archive-types.js";
import { listZip } from "./zip.js";
import { scanTar } from "./tar.js";

export type ArchiveFormat =
  | { kind: "zip"; label: string }
  | { kind: "tar"; label: string; codec: Codec | null }
  /** One compressed file, not an archive: it opens as its content. */
  | { kind: "single"; label: string; codec: Codec; inner: string };

/** Zip under other names: Java and Android packages, Python wheels, e-books,
 *  Office and OpenDocument files, browser and editor extensions. Each is a zip
 *  whose contents are worth reading, and each showed as binary before. */
const ZIP_EXTS = [
  ".zip", ".jar", ".war", ".ear", ".aar", ".apk", ".aab", ".ipa", ".whl",
  ".epub", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".odg",
  ".nupkg", ".vsix", ".xpi", ".kmz", ".sketch", ".xmind",
];

interface CompressedExt { ext: string; codec: Codec; tar: boolean }
const COMPRESSED_EXTS: CompressedExt[] = [
  { ext: ".tar.gz", codec: "gzip", tar: true },
  { ext: ".tgz", codec: "gzip", tar: true },
  { ext: ".taz", codec: "gzip", tar: true },
  { ext: ".tar.br", codec: "brotli", tar: true },
  { ext: ".tbr", codec: "brotli", tar: true },
  ...(HAS_ZSTD ? [
    { ext: ".tar.zst", codec: "zstd" as const, tar: true },
    { ext: ".tzst", codec: "zstd" as const, tar: true },
    { ext: ".zst", codec: "zstd" as const, tar: false },
  ] : []),
  { ext: ".gz", codec: "gzip", tar: false },
  { ext: ".br", codec: "brotli", tar: false },
];

/** What kind of archive a file name says it is, or null. The name only
 *  nominates: a file that doesn't parse as what it claims falls back to being
 *  an ordinary (usually binary) file. */
export function archiveFormatFor(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (ZIP_EXTS.some((e) => base.endsWith(e) && base.length > e.length)) {
    return { kind: "zip", label: "zip" };
  }
  if (base.endsWith(".tar") && base.length > 4) return { kind: "tar", label: "tar", codec: null };
  for (const c of COMPRESSED_EXTS) {
    if (!base.endsWith(c.ext) || base.length <= c.ext.length) continue;
    const label = c.ext.slice(1);
    if (c.tar) return { kind: "tar", label, codec: c.codec };
    const original = name.slice(name.lastIndexOf("/") + 1);
    return { kind: "single", label, codec: c.codec, inner: original.slice(0, original.length - c.ext.length) };
  }
  return null;
}

/** A name as the tree will show it, or null if it can't honestly be placed.
 *  A name that is only the root (`./`, which `tar -C dir .` writes first) is
 *  "" — nothing to place, but nothing wrong either. */
export function normalizeMemberName(name: string): string | null {
  if (name.includes("\0")) return null;
  const parts: string[] = [];
  for (const part of name.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.join("/");
}

export interface ArchiveNode {
  name: string;
  kind: MemberKind;
  size: number | null;
  mtimeMs: number;
  member?: RawMember;
}

export interface ArchiveIndex {
  format: ArchiveFormat;
  /** Every node by its path within the archive ("" is the root). */
  nodes: Map<string, ArchiveNode>;
  /** Children by directory path. */
  children: Map<string, Map<string, ArchiveNode>>;
  /** Members hidden because their names could not be placed. */
  skipped: number;
  /** The listing stopped at a limit, or the archive was cut short. */
  partial: boolean;
}

export const ARCHIVE_LIMITS = {
  maxEntries: 200_000,
  /** Decoded bytes a compressed tar's listing may run through. */
  maxScanBytes: 1024 * 1024 * 1024,
};

export function buildIndex(format: ArchiveFormat, members: RawMember[], partial: boolean): ArchiveIndex {
  const nodes = new Map<string, ArchiveNode>();
  const children = new Map<string, Map<string, ArchiveNode>>();
  const root: ArchiveNode = { name: "", kind: "dir", size: null, mtimeMs: 0 };
  nodes.set("", root);
  children.set("", new Map());
  let skipped = 0;

  const ensureDir = (path: string, mtimeMs: number): ArchiveNode | null => {
    const existing = nodes.get(path);
    if (existing) return existing.kind === "dir" ? existing : null;
    const slash = path.lastIndexOf("/");
    const parentPath = slash < 0 ? "" : path.slice(0, slash);
    const parent = ensureDir(parentPath, mtimeMs);
    if (!parent) return null;
    const node: ArchiveNode = { name: path.slice(slash + 1), kind: "dir", size: null, mtimeMs };
    nodes.set(path, node);
    children.set(path, new Map());
    children.get(parentPath)!.set(node.name, node);
    return node;
  };

  for (const m of members) {
    const path = normalizeMemberName(m.name);
    if (path === null || (path === "" && m.kind !== "dir")) { skipped++; continue; }
    if (m.kind === "dir") {
      const dir = ensureDir(path, m.mtimeMs);
      if (!dir) { skipped++; continue; }
      if (m.mtimeMs) dir.mtimeMs = m.mtimeMs;
      continue;
    }
    const slash = path.lastIndexOf("/");
    const parentPath = slash < 0 ? "" : path.slice(0, slash);
    const existing = nodes.get(path);
    // A file where the tree already has a directory (`a` beside `a/b`) has
    // nowhere to go. A second file of the same name replaces the first, as
    // extracting it would.
    if (existing?.kind === "dir") { skipped++; continue; }
    const parent = ensureDir(parentPath, m.mtimeMs);
    if (!parent) { skipped++; continue; }
    const node: ArchiveNode = { name: path.slice(slash + 1), kind: m.kind, size: m.size, mtimeMs: m.mtimeMs, member: m };
    nodes.set(path, node);
    children.get(parentPath)!.set(node.name, node);
  }
  return { format, nodes, children, skipped, partial };
}

/** Lists the archive at `path`. Throws when it isn't what its name claims. */
export async function readArchiveIndex(path: string, size: number, format: ArchiveFormat): Promise<ArchiveIndex> {
  if (format.kind === "zip") {
    const { members, partial } = await listZip(path, size, ARCHIVE_LIMITS.maxEntries);
    return buildIndex(format, members, partial);
  }
  if (format.kind === "tar") {
    const codec = format.codec;
    const { members, partial } = await scanTar(
      openDecoded(path, codec),
      (offset, bodySize, mtime) => codec
        ? streamSource(() => openDecoded(path, codec), bodySize, mtime, offset)
        : fileSource(path, bodySize, mtime, offset),
      ARCHIVE_LIMITS,
    );
    return buildIndex(format, members, partial);
  }
  throw new Error("not an archive");
}

// A listing of a compressed tar costs a pass over the whole thing, and the
// Files view asks for one per directory it opens, so indexes are kept while
// the file is unchanged. Keyed on (path, size, mtime): an edit or a rebuild
// is a new key, never a stale listing.
const CACHE_SIZE = 16;
const cache = new Map<string, Promise<ArchiveIndex>>();

export async function archiveIndex(path: string, format: ArchiveFormat): Promise<ArchiveIndex> {
  const st = await stat(path);
  const key = `${path}\0${st.size}\0${st.mtimeMs}`;
  let hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  hit = readArchiveIndex(path, st.size, format);
  cache.set(key, hit);
  // A failure is not cached: the next request tries again (the file may have
  // been mid-write).
  hit.catch(() => { if (cache.get(key) === hit) cache.delete(key); });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return hit;
}
