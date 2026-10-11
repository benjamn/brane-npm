import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import type Database from "better-sqlite3";
import { VECTOR_DIM, embedBatch } from "./embeddings.js";
import { prepareFtsQuery, tokenizeQuery } from "./storage.js";
import { WIKI_SHARED_DIR, isSharedSlug, normalizeWikiSlug } from "../shared/wiki-links.js";

/** Embeds a batch of texts into vectors. Injectable so tests can supply a
 *  deterministic stub and skip the transformers model download; defaults to
 *  the real {@link embedBatch}. */
export type WikiEmbedder = (texts: string[]) => Promise<Float32Array[]>;

/**
 * Wiki subsystem: a catalog + fetch + semantic-search surface over the flat
 * markdown wikis brane can reach — the package's own `wiki/` (brane's
 * philosophical vantage point, shipped with the install) plus any per-fold
 * `wiki/` directories. It mirrors the protocol tools (`list_protocols`/
 * `read_protocol`) and `narrative_search`, but the governing principle is
 * *reachability + transparent provenance*: every page from every source is
 * reachable, and every retrieval is stamped with its `source` so a caller can
 * never mistake brane-canonical content for fold-local content.
 *
 * The markdown-aware chunk is the unit everything is built on — the wiki's
 * equivalent of a narrative *message*. A chunk is simultaneously the embedding
 * unit (`search_wiki`), the anchor-addressable unit (`read_wiki`), the
 * pagination unit, and the hash-keyed change-detection unit.
 */

/** A wiki source: a label and the directory its pages live in. */
export interface WikiSource {
  /** Stable label distinguishing this source ("brane" for the package wiki,
   *  otherwise the fold's basename). */
  source: string;
  /** Absolute path to the wiki directory. */
  dir: string;
  /** Portable fold path, for per-fold sources (absent for the package wiki). */
  fold_path?: string;
  /** When set, only pages under `shared/` are listed, readable, or searchable
   *  through this source — the view a caller gets of a fold it does not own.
   *  Unset (the caller's own fold, or the operator over HTTP) sees everything. */
  shared_only?: boolean;
}

export interface TocEntry {
  anchor: string;
  heading: string;
  level: number;
}

/** A markdown-aware chunk — one heading-rooted section (or a part of an
 *  oversized one). The wiki analogue of a narrative message. */
export interface WikiChunk {
  /** GitHub-style heading slug this chunk sits under ("" for content above the
   *  first heading). */
  anchor: string;
  /** 0 for a whole section; 1+ when a long section is split into parts. */
  part: number;
  content: string;
  /** sha256 of `content` — the change-detection key. */
  hash: string;
}

export interface ParsedPage {
  frontmatter: Record<string, string>;
  toc: TocEntry[];
  chunks: WikiChunk[];
}

/** Soft cap on chunk size (characters). Sections larger than this are split on
 *  paragraph boundaries into parts. bge-small's useful window is ~512 tokens;
 *  ~1800 chars keeps us comfortably under that with headroom for context. */
const MAX_CHUNK_CHARS = 1800;

// ── Markdown parsing ────────────────────────────────────────────────────────

/** GitHub-style heading → anchor slug. Duplicate slugs on one page get a
 *  numeric suffix (-1, -2, …), matching GitHub's disambiguation. */
function slugify(heading: string, seen: Map<string, number>): string {
  const base = heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** Parse `---`-delimited YAML-ish frontmatter into a flat key→value map.
 *  Only simple `key: value` lines are supported (no nesting); that's all the
 *  wiki convention needs. Returns the map plus the body with frontmatter
 *  stripped. */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter, body: content };
  }
  const lines = content.split("\n");
  // lines[0] is the opening "---"; find the closing fence.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter, body: content };
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) {
      let value = m[2].trim();
      // Strip matching surrounding quotes.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      frontmatter[m[1]] = value;
    }
  }
  const body = lines.slice(end + 1).join("\n");
  return { frontmatter, body };
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^(```|~~~)/;

interface RawSection {
  anchor: string;
  heading: string | null;
  level: number;
  lines: string[];
}

/** Split body into heading-rooted sections, respecting code fences. Content
 *  above the first heading becomes a preamble section (anchor ""). */
function splitSections(body: string): { sections: RawSection[]; toc: TocEntry[] } {
  const lines = body.split("\n");
  const sections: RawSection[] = [];
  const toc: TocEntry[] = [];
  const seenAnchors = new Map<string, number>();

  let current: RawSection = { anchor: "", heading: null, level: 0, lines: [] };
  let inFence = false;

  for (const line of lines) {
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence;
      current.lines.push(line);
      continue;
    }
    const m = !inFence ? HEADING_RE.exec(line) : null;
    if (m) {
      // Close the current section if it has any content (or is a heading).
      if (current.heading !== null || current.lines.some((l) => l.trim().length > 0)) {
        sections.push(current);
      }
      const level = m[1].length;
      const heading = m[2].trim();
      const anchor = slugify(heading, seenAnchors);
      toc.push({ anchor, heading, level });
      current = { anchor, heading, level, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading !== null || current.lines.some((l) => l.trim().length > 0)) {
    sections.push(current);
  }
  return { sections, toc };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Split an oversized section body on paragraph (blank-line) boundaries into
 *  pieces no larger than MAX_CHUNK_CHARS where possible. A single paragraph
 *  bigger than the cap is emitted whole rather than cut mid-sentence. */
function splitOversized(content: string): string[] {
  if (content.length <= MAX_CHUNK_CHARS) return [content];
  const paras = content.split(/\n{2,}/);
  const parts: string[] = [];
  let buf = "";
  for (const para of paras) {
    if (buf && buf.length + para.length + 2 > MAX_CHUNK_CHARS) {
      parts.push(buf);
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf) parts.push(buf);
  return parts.length > 0 ? parts : [content];
}

/** Parse a wiki page into frontmatter, a table of contents, and chunks. */
export function parseWikiPage(content: string): ParsedPage {
  const { frontmatter, body } = parseFrontmatter(content);
  const { sections, toc } = splitSections(body);
  const chunks: WikiChunk[] = [];
  for (const section of sections) {
    const text = section.lines.join("\n").trim();
    if (!text) continue;
    const pieces = splitOversized(text);
    pieces.forEach((piece, idx) => {
      chunks.push({ anchor: section.anchor, part: idx, content: piece, hash: sha256(piece) });
    });
  }
  return { frontmatter, toc, chunks };
}

/** First non-empty, non-heading, non-frontmatter line — the description
 *  fallback when a page carries no `description:` frontmatter. Mirrors
 *  `handleListProtocols`. */
function firstProseLine(body: string): string | undefined {
  const line = body
    .split("\n")
    .find((l) => l.trim().length > 0 && !l.startsWith("#") && !l.startsWith("---"));
  return line?.trim();
}

// ── Source resolution ─────────────────────────────────────────────────────

/** Normalize a slug to its `.md` filename form. */
export function normalizeSlug(slug: string): string {
  return normalizeWikiSlug(slug);
}

/** Markdown filenames directly in `dir`, sorted. */
function mdFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/** List page slugs (with `.md`, relative to the wiki root) in a wiki
 *  directory: the local pages directly under it plus the shared pages under
 *  `shared/`, which carry that prefix. No other subdirectory is a page
 *  location — the layout is flat by protocol, with `shared/` as the one
 *  exception. */
function listSlugs(dir: string): string[] {
  const shared = mdFiles(join(dir, WIKI_SHARED_DIR)).map((f) => `${WIKI_SHARED_DIR}/${f}`);
  return [...mdFiles(dir), ...shared].sort();
}

/** Whether `slug` is visible through `src`: everything for an owned source,
 *  only `shared/` pages for a `shared_only` one. */
function visibleIn(src: WikiSource, slug: string): boolean {
  return !src.shared_only || isSharedSlug(slug);
}

/** Where a requested slug lands in a source. `ok` carries the canonical
 *  filename; `local` means the page exists but is not shared and the source
 *  is `shared_only`; `missing` means no such page (an escaping `..` slug is
 *  treated as missing rather than resolved). A bare `foo` that does not exist
 *  at the root falls through to `shared/foo.md`, so the short form keeps
 *  working for shipped pages. */
export function locatePage(
  src: WikiSource,
  slug: string,
): { status: "ok" | "local"; filename: string } | { status: "missing"; filename: string } {
  const filename = normalizeSlug(slug);
  if (filename.split("/").some((seg) => seg === "..")) return { status: "missing", filename };
  const candidates = [filename];
  if (!filename.includes("/")) candidates.push(`${WIKI_SHARED_DIR}/${filename}`);
  for (const candidate of candidates) {
    if (existsSync(join(src.dir, candidate))) {
      return { status: visibleIn(src, candidate) ? "ok" : "local", filename: candidate };
    }
  }
  return { status: "missing", filename };
}

/** The error a non-owner gets for a page that exists but is not shared. */
function localPageError(source: string, filename: string): { error: string } {
  return {
    error:
      `"${filename}" is local to wiki source "${source}", not shared — only pages under ` +
      `${WIKI_SHARED_DIR}/ are readable from another fold.`,
  };
}

// ── Catalog: list_wiki ──────────────────────────────────────────────────────

export interface WikiListEntry {
  slug: string;
  title: string;
  description: string | null;
  source: string;
  fold_path?: string;
  /** True for pages under `shared/` — visible to other folds. */
  shared: boolean;
  /** Last-modified time of the page file (ms). */
  mtime: number;
}

export interface ListWikiOptions {
  /** Restrict to a single source label, or "all" / undefined for every source. */
  source?: string;
  /** Sort key. Default "slug". */
  order?: "slug" | "title" | "mtime";
  /** Case-insensitive substring filter over slug + title + description. */
  filter?: string;
}

export function listWiki(sources: WikiSource[], opts: ListWikiOptions = {}): WikiListEntry[] {
  const wanted = opts.source && opts.source !== "all" ? opts.source : undefined;
  const entries: WikiListEntry[] = [];
  for (const src of sources) {
    if (wanted && src.source !== wanted) continue;
    for (const slug of listSlugs(src.dir)) {
      if (!visibleIn(src, slug)) continue;
      const path = join(src.dir, slug);
      let content: string;
      let mtime = 0;
      try {
        content = readFileSync(path, "utf-8");
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      const { frontmatter, body } = parseFrontmatter(content);
      const description = frontmatter.description ?? firstProseLine(body) ?? null;
      const title = frontmatter.title ?? basename(slug, ".md");
      entries.push({
        slug,
        title,
        description,
        source: src.source,
        fold_path: src.fold_path,
        shared: isSharedSlug(slug),
        mtime,
      });
    }
  }

  if (opts.filter) {
    const needle = opts.filter.toLowerCase();
    const matched = entries.filter(
      (e) =>
        e.slug.toLowerCase().includes(needle) ||
        e.title.toLowerCase().includes(needle) ||
        (e.description?.toLowerCase().includes(needle) ?? false),
    );
    entries.length = 0;
    entries.push(...matched);
  }

  const order = opts.order ?? "slug";
  entries.sort((a, b) => {
    if (order === "mtime") return b.mtime - a.mtime;
    if (order === "title") return a.title.localeCompare(b.title);
    return a.slug.localeCompare(b.slug);
  });
  return entries;
}

// ── Fetch: read_wiki ────────────────────────────────────────────────────────

export interface ReadWikiOptions {
  /** Return only the section under this heading anchor (with its parts). */
  anchor?: string;
  /** Pagination over chunks (the page's natural unit). */
  offset?: number;
  limit?: number;
}

export interface ReadWikiResult {
  source: string;
  slug: string;
  fold_path?: string;
  frontmatter: Record<string, string>;
  toc: TocEntry[];
  /** Citation string for whatever sources this page: `slug` or `slug#anchor`. */
  citation: string;
  content: string;
  /** Pagination metadata over the page's chunks. */
  total_chunks: number;
  offset: number;
  returned: number;
  has_more: boolean;
}

export function readWiki(
  sources: WikiSource[],
  source: string,
  slug: string,
  opts: ReadWikiOptions = {},
): ReadWikiResult | { error: string } {
  const src = sources.find((s) => s.source === source);
  if (!src) {
    return { error: `Unknown wiki source: ${source}. Use list_wiki to see available sources.` };
  }
  const located = locatePage(src, slug);
  if (located.status === "missing") {
    return { error: `Wiki page not found: ${source}/${located.filename}. Use list_wiki to see pages.` };
  }
  if (located.status === "local") return localPageError(source, located.filename);
  const filename = located.filename;
  const content = readFileSync(join(src.dir, filename), "utf-8");
  const parsed = parseWikiPage(content);

  let chunks = parsed.chunks;
  let citation = filename;
  if (opts.anchor) {
    const anchor = opts.anchor.replace(/^#/, "");
    chunks = parsed.chunks.filter((c) => c.anchor === anchor);
    citation = `${filename}#${anchor}`;
    if (chunks.length === 0) {
      const anchors = parsed.toc.map((t) => t.anchor).join(", ");
      return { error: `No section "#${anchor}" in ${source}/${filename}. Anchors: ${anchors || "(none)"}` };
    }
  }

  const total = chunks.length;
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit ?? total;
  const page = chunks.slice(offset, offset + limit);

  return {
    source: src.source,
    slug: filename,
    fold_path: src.fold_path,
    frontmatter: parsed.frontmatter,
    toc: parsed.toc,
    citation,
    content: page.map((c) => c.content).join("\n\n"),
    total_chunks: total,
    offset,
    returned: page.length,
    has_more: offset + page.length < total,
  };
}

// ── Neighbor-aware read: read_wiki?window=N / GET /api/wiki/read ───────────

/** One heading-rooted section, its chunks rejoined. The navigation unit for
 *  the windowed read (a section, not a chunk — oversized sections that split
 *  into parts read back as one). */
interface PageSection {
  anchor: string;
  /** null for the preamble (content above the first heading). */
  heading: string | null;
  level: number;
  content: string;
}

/** Fold a parsed page's chunks back into ordered sections by anchor. Chunks
 *  arrive in document order and an oversized section's parts are consecutive,
 *  so grouping consecutive same-anchor chunks reconstructs each section. */
function pageSections(parsed: ParsedPage): PageSection[] {
  const tocByAnchor = new Map(parsed.toc.map((t) => [t.anchor, t]));
  const sections: PageSection[] = [];
  for (const ch of parsed.chunks) {
    const last = sections[sections.length - 1];
    if (last && last.anchor === ch.anchor) {
      last.content += `\n\n${ch.content}`;
    } else {
      const t = tocByAnchor.get(ch.anchor);
      sections.push({
        anchor: ch.anchor,
        heading: t?.heading ?? null,
        level: t?.level ?? 0,
        content: ch.content,
      });
    }
  }
  return sections;
}

/** First prose line of a section (heading and blank lines skipped), truncated
 *  — a "should I read on?" hint for a neighbor, never the whole section. */
function sectionPreview(content: string): string {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line) return "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** A navigable neighbor — heading-level metadata plus a one-line preview, so a
 *  reader can decide whether to fetch it without paying for its content. */
export interface WikiNeighbor {
  anchor: string;
  heading: string | null;
  level: number;
  preview: string;
}

export interface ReadWikiSectionResult {
  source: string;
  slug: string;
  fold_path?: string;
  frontmatter: Record<string, string>;
  toc: TocEntry[];
  citation: string;
  /** The section you're reading. */
  current: { anchor: string; heading: string | null; level: number; content: string };
  /** Up to `window` preceding sections, nearest-first. */
  prev: WikiNeighbor[];
  /** Up to `window` following sections, nearest-first. */
  next: WikiNeighbor[];
  /** Where `current` sits in the page's section sequence. */
  position: { index: number; total: number };
}

/** Default and ceiling for the neighbor window (sections on each side). */
const DEFAULT_WINDOW = 3;
const MAX_WINDOW = 10;

/**
 * Read one section of a wiki page plus a navigational window of the section
 * headings around it, so a reader can walk the page section-by-section ("read
 * on" = fetch `next[0].anchor`) instead of paging blind by offset or pulling
 * the whole page. No `anchor` starts at the page top. Shared by the MCP
 * `read_wiki` (with `window`) and the HTTP `GET /api/wiki/read`.
 */
export function readWikiSection(
  sources: WikiSource[],
  source: string,
  slug: string,
  opts: { anchor?: string; window?: number } = {},
): ReadWikiSectionResult | { error: string } {
  const src = sources.find((s) => s.source === source);
  if (!src) {
    return { error: `Unknown wiki source: ${source}. Use list_wiki to see available sources.` };
  }
  const located = locatePage(src, slug);
  if (located.status === "missing") {
    return { error: `Wiki page not found: ${source}/${located.filename}. Use list_wiki to see pages.` };
  }
  if (located.status === "local") return localPageError(source, located.filename);
  const filename = located.filename;
  const parsed = parseWikiPage(readFileSync(join(src.dir, filename), "utf-8"));
  const sections = pageSections(parsed);
  if (sections.length === 0) {
    return { error: `Wiki page has no readable content: ${source}/${filename}` };
  }

  let index = 0;
  if (opts.anchor) {
    const anchor = opts.anchor.replace(/^#/, "");
    const found = sections.findIndex((s) => s.anchor === anchor);
    if (found === -1) {
      const anchors = parsed.toc.map((t) => t.anchor).join(", ");
      return { error: `No section "#${anchor}" in ${source}/${filename}. Anchors: ${anchors || "(none)"}` };
    }
    index = found;
  }

  const window = Math.max(0, Math.min(opts.window ?? DEFAULT_WINDOW, MAX_WINDOW));
  const cur = sections[index];
  const toNeighbor = (s: PageSection): WikiNeighbor => ({
    anchor: s.anchor,
    heading: s.heading,
    level: s.level,
    preview: sectionPreview(s.content),
  });

  return {
    source: src.source,
    slug: filename,
    fold_path: src.fold_path,
    frontmatter: parsed.frontmatter,
    toc: parsed.toc,
    citation: cur.anchor ? `${filename}#${cur.anchor}` : filename,
    current: { anchor: cur.anchor, heading: cur.heading, level: cur.level, content: cur.content },
    // nearest-first on both sides
    prev: sections.slice(Math.max(0, index - window), index).reverse().map(toNeighbor),
    next: sections.slice(index + 1, index + 1 + window).map(toNeighbor),
    position: { index, total: sections.length },
  };
}

// ── Semantic search: search_wiki ──────────────────────────────────────────

const WIKI_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wiki_chunks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  slug TEXT NOT NULL,
  anchor TEXT NOT NULL,
  part INTEGER NOT NULL,
  content TEXT NOT NULL,
  hash TEXT NOT NULL,
  fold_path TEXT,
  time INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[${VECTOR_DIM}] distance_metric=cosine
);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  content,
  content='wiki_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS wiki_chunks_ai AFTER INSERT ON wiki_chunks BEGIN
  INSERT INTO wiki_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS wiki_chunks_ad AFTER DELETE ON wiki_chunks BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

-- Defensive: sync only does INSERT OR REPLACE / DELETE, so no current path
-- issues a bare UPDATE. Kept to mirror memory_chunks and stay correct if one
-- is ever added.
CREATE TRIGGER IF NOT EXISTS wiki_chunks_au AFTER UPDATE ON wiki_chunks BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO wiki_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE INDEX IF NOT EXISTS idx_wiki_chunks_doc ON wiki_chunks(source, slug);
`;

export function initWikiSchema(db: Database.Database): void {
  // sqlite-vec must be loaded for the vec0 virtual table. The memory subsystem
  // loads it on every search too, so repeated loads are an established, safe
  // pattern here.
  sqliteVec.load(db);
  db.exec(WIKI_SCHEMA_SQL);
}

function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function chunkId(source: string, slug: string, anchor: string, part: number): string {
  return `${source}\0${slug}\0${anchor}\0${part}`;
}

interface SyncStats {
  sources: number;
  pages: number;
  chunks_total: number;
  chunks_reembedded: number;
  chunks_removed: number;
}

/**
 * Reconcile the wiki index with the current on-disk pages for the given
 * sources. Re-embeds only chunks whose content hash changed (or are new) and
 * drops index rows for chunks that no longer exist. This touches only the
 * derived `wiki_*` index tables, never the wiki files themselves.
 */
export async function syncWikiIndex(
  db: Database.Database,
  sources: WikiSource[],
  embed: WikiEmbedder = embedBatch,
): Promise<SyncStats> {
  initWikiSchema(db);
  const stats: SyncStats = {
    sources: sources.length,
    pages: 0,
    chunks_total: 0,
    chunks_reembedded: 0,
    chunks_removed: 0,
  };

  const now = Date.now();
  const insertChunk = db.prepare(
    `INSERT OR REPLACE INTO wiki_chunks (id, source, slug, anchor, part, content, hash, fold_path, time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteVec = db.prepare("DELETE FROM wiki_vec WHERE chunk_id = ?");
  const insertVec = db.prepare("INSERT INTO wiki_vec (chunk_id, embedding) VALUES (?, ?)");
  const deleteChunk = db.prepare("DELETE FROM wiki_chunks WHERE id = ?");

  for (const src of sources) {
    const existing = db
      .prepare("SELECT id, hash FROM wiki_chunks WHERE source = ?")
      .all(src.source) as Array<{ id: string; hash: string }>;
    const existingHash = new Map(existing.map((r) => [r.id, r.hash]));

    const present = new Set<string>();
    const changed: Array<{ id: string; source: string; slug: string; anchor: string; part: number; content: string; hash: string; fold_path?: string }> = [];

    for (const slug of listSlugs(src.dir)) {
      let content: string;
      try {
        content = readFileSync(join(src.dir, slug), "utf-8");
      } catch {
        continue;
      }
      stats.pages++;
      const parsed = parseWikiPage(content);
      for (const ch of parsed.chunks) {
        const id = chunkId(src.source, slug, ch.anchor, ch.part);
        present.add(id);
        stats.chunks_total++;
        if (existingHash.get(id) !== ch.hash) {
          changed.push({
            id,
            source: src.source,
            slug,
            anchor: ch.anchor,
            part: ch.part,
            content: ch.content,
            hash: ch.hash,
            fold_path: src.fold_path,
          });
        }
      }
    }

    // Embed changed chunks (outside the write transaction — embedding is async).
    let vectors: Float32Array[] = [];
    if (changed.length > 0) {
      vectors = await embed(changed.map((c) => c.content));
    }

    const toRemove = [...existingHash.keys()].filter((id) => !present.has(id));

    // Skip the write transaction entirely when nothing changed — otherwise a
    // read-shaped `search_wiki` would still acquire the write lock on an empty
    // BEGIN/COMMIT every call.
    if (changed.length > 0 || toRemove.length > 0) {
      const tx = db.transaction(() => {
        changed.forEach((c, i) => {
          insertChunk.run(c.id, c.source, c.slug, c.anchor, c.part, c.content, c.hash, c.fold_path ?? null, now);
          deleteVec.run(c.id);
          insertVec.run(c.id, vecToBuffer(vectors[i]));
        });
        for (const id of toRemove) {
          deleteVec.run(id);
          deleteChunk.run(id);
        }
      });
      tx();
    }

    stats.chunks_reembedded += changed.length;
    stats.chunks_removed += toRemove.length;
  }

  return stats;
}

/** One section/chunk hit within an article. */
export interface WikiSearchHit {
  anchor: string;
  /** `slug` or `slug#anchor` — the wiki analogue of `nid:seq`. */
  citation: string;
  content: string;
  score: number;
}

/** Search results grouped by article (page), the way narrative results belong
 *  to a narrative. The article carries the best-hit score for ranking; its
 *  `hits` are the individual section/chunk matches, ranked within. */
export interface WikiSearchArticle {
  source: string;
  slug: string;
  fold_path?: string;
  /** Article rank = the score of its best-matching chunk. */
  score: number;
  hits: WikiSearchHit[];
}

interface WikiRow {
  chunk_id: string;
  source: string;
  slug: string;
  anchor: string;
  content: string;
  fold_path: string | null;
  score: number;
}

/** Minimum fused score for a chunk to count as a real hit. Keyword matches get
 *  a +0.5/+1.0 boost so they clear this comfortably; unrelated text sits at the
 *  ~0.5–0.6 embedding baseline and is dropped. Tunable. */
const MIN_WIKI_SCORE = 0.7;

/** Hybrid vector + FTS search over the wiki index, scoped to `sources`.
 *  `limit` bounds the number of chunk hits returned (like narrative_search
 *  bounds messages); those hits are then grouped under their article. Hits
 *  below {@link MIN_WIKI_SCORE} are dropped, so an off-topic query can return
 *  zero results rather than noise. */
export async function searchWiki(
  db: Database.Database,
  sources: WikiSource[],
  query: string,
  limit: number,
  embed: WikiEmbedder = embedBatch,
): Promise<WikiSearchArticle[]> {
  await syncWikiIndex(db, sources, embed);

  const sourceLabels = sources.map((s) => s.source);
  if (sourceLabels.length === 0) return [];
  const bySource = new Map(sources.map((s) => [s.source, s]));
  // A `shared_only` source contributes only its `shared/` chunks; the index
  // holds the whole wiki (its owner searches it too), so visibility is a
  // query-time filter here rather than a property of what got indexed.
  const rowVisible = (r: { source: string; slug: string }): boolean => {
    const src = bySource.get(r.source);
    return src !== undefined && visibleIn(src, r.slug);
  };
  const placeholders = sourceLabels.map(() => "?").join(", ");
  const fetchLimit = Math.max(limit * 4, 20);

  const queryVector = (await embed([query]))[0];

  const merged = new Map<string, WikiRow>();

  // Vector KNN — fetch a wider candidate set, then scope to sources in JS
  // (vec0 MATCH can't be combined with arbitrary WHERE filters). The `k` is a
  // global top-N across *all* synced sources, so source-scoping happens after
  // the fact; fine for the small wiki corpus (tens–hundreds of chunks), where
  // even a generous `k` spans everything. If a brane ever accumulates very
  // large wikis, this would want a per-source `k` or a pre-filter.
  const vecRows = db
    .prepare(
      `SELECT v.chunk_id, v.distance, c.source, c.slug, c.anchor, c.content, c.fold_path
       FROM wiki_vec v
       JOIN wiki_chunks c ON c.id = v.chunk_id
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`,
    )
    .all(vecToBuffer(queryVector), fetchLimit * 2) as Array<{
    chunk_id: string;
    distance: number;
    source: string;
    slug: string;
    anchor: string;
    content: string;
    fold_path: string | null;
  }>;
  for (const r of vecRows) {
    if (!rowVisible(r)) continue;
    merged.set(r.chunk_id, {
      chunk_id: r.chunk_id,
      source: r.source,
      slug: r.slug,
      anchor: r.anchor,
      content: r.content,
      fold_path: r.fold_path,
      score: Math.max(0, 1.0 - r.distance),
    });
  }

  // FTS keyword search, scoped to sources in SQL.
  const ftsQuery = prepareFtsQuery(query);
  if (ftsQuery) {
    try {
      const ftsRows = db
        .prepare(
          `SELECT c.id AS chunk_id, c.source, c.slug, c.anchor, c.content, c.fold_path,
                  bm25(wiki_fts) AS bm25_score
           FROM wiki_fts
           JOIN wiki_chunks c ON wiki_fts.rowid = c.rowid
           WHERE wiki_fts MATCH ? AND c.source IN (${placeholders})
           ORDER BY bm25_score
           LIMIT ?`,
        )
        .all(ftsQuery, ...sourceLabels, fetchLimit) as Array<{
        chunk_id: string;
        source: string;
        slug: string;
        anchor: string;
        content: string;
        fold_path: string | null;
        bm25_score: number;
      }>;
      for (const r of ftsRows) {
        if (!rowVisible(r)) continue;
        const ftsScore = Math.min(1.0, Math.max(0, -r.bm25_score / 10.0));
        const existing = merged.get(r.chunk_id);
        if (existing) {
          existing.score = existing.score * 0.6 + ftsScore * 0.4;
        } else {
          merged.set(r.chunk_id, {
            chunk_id: r.chunk_id,
            source: r.source,
            slug: r.slug,
            anchor: r.anchor,
            content: r.content,
            fold_path: r.fold_path,
            score: ftsScore,
          });
        }
      }
    } catch {
      // FTS query can fail on special chars — vector results still stand.
    }
  }

  // Keyword-presence boost, mirroring searchHybrid.
  const tokens = tokenizeQuery(query);
  const phrases = tokens
    .filter((t): t is { kind: "phrase"; text: string } => t.kind === "phrase")
    .map((t) => t.text.toLowerCase());
  const terms = tokens
    .filter((t): t is { kind: "term"; text: string } => t.kind === "term")
    .map((t) => t.text.toLowerCase());

  const rows = [...merged.values()];
  for (const r of rows) {
    const lower = r.content.toLowerCase();
    if (phrases.some((p) => lower.includes(p))) r.score += 1.0;
    else if (terms.some((t) => lower.includes(t))) r.score += 0.5;
  }

  rows.sort((a, b) => b.score - a.score);

  // Relevance floor: drop weak hits rather than padding results with noise.
  // A chunk containing a query term gets a +0.5/+1.0 keyword boost, so genuine
  // matches land well above 1.0; pure-semantic baseline similarity for
  // unrelated text sits around 0.5–0.6. A floor of 0.7 keeps every keyword
  // match and strong semantic hit while cutting the baseline tail — so an
  // off-topic query returns few or zero hits (and the UI's Wiki section then
  // hides) instead of thin, unhighlightable filler.
  const relevant = rows.filter((r) => r.score >= MIN_WIKI_SCORE);

  // `limit` caps the number of chunk *hits* — the wiki analogue of
  // narrative_search returning the top-N messages — not the number of
  // articles. We take the top-`limit` chunks globally, then group them under
  // their article (source + slug) the way narrative messages belong to a
  // narrative. This keeps the payload bounded: a query that matches dozens of
  // sections in a handful of pages returns `limit` chunks, not whole pages.
  const topRows = relevant.slice(0, Math.max(0, limit));

  const articles = new Map<string, WikiSearchArticle>();
  for (const r of topRows) {
    const key = `${r.source}\0${r.slug}`;
    const score = Math.round(r.score * 100) / 100;
    const hit: WikiSearchHit = {
      anchor: r.anchor,
      citation: r.anchor ? `${r.slug}#${r.anchor}` : r.slug,
      content: r.content,
      score,
    };
    const existing = articles.get(key);
    if (existing) {
      existing.hits.push(hit);
      if (score > existing.score) existing.score = score;
    } else {
      articles.set(key, {
        source: r.source,
        slug: r.slug,
        fold_path: r.fold_path ?? undefined,
        score,
        hits: [hit],
      });
    }
  }

  // `topRows` is already score-descending, so each article's `hits` and the
  // insertion order are both ranked; sort articles by their best-hit score.
  return [...articles.values()].sort((a, b) => b.score - a.score);
}
