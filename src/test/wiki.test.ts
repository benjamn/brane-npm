import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  parseWikiPage,
  normalizeSlug,
  locatePage,
  listWiki,
  readWiki,
  readWikiSection,
  syncWikiIndex,
  searchWiki,
  type WikiSource,
  type WikiEmbedder,
} from "../memory/wiki.js";
import { VECTOR_DIM } from "../memory/embeddings.js";

describe("parseWikiPage", () => {
  it("extracts frontmatter and strips it from the body", () => {
    const page = parseWikiPage(
      ["---", "description: A test page", 'title: "Quoted Title"', "---", "", "# Heading", "Body."].join("\n"),
    );
    assert.equal(page.frontmatter.description, "A test page");
    assert.equal(page.frontmatter.title, "Quoted Title");
    // Frontmatter must not leak into chunk content.
    assert.ok(!page.chunks.some((c) => c.content.includes("description:")));
  });

  it("builds a TOC with GitHub-style anchors and disambiguates duplicates", () => {
    const page = parseWikiPage(
      ["# First Heading", "x", "## Sub Section!", "y", "## Sub Section!", "z"].join("\n"),
    );
    assert.deepEqual(
      page.toc.map((t) => t.anchor),
      ["first-heading", "sub-section", "sub-section-1"],
    );
    assert.equal(page.toc[1].level, 2);
    assert.equal(page.toc[0].heading, "First Heading");
  });

  it("roots each chunk at its enclosing heading anchor; preamble has empty anchor", () => {
    const page = parseWikiPage(["intro text", "# Alpha", "a body", "# Beta", "b body"].join("\n"));
    const anchors = page.chunks.map((c) => c.anchor);
    assert.ok(anchors.includes(""), "preamble chunk should have empty anchor");
    assert.ok(anchors.includes("alpha"));
    assert.ok(anchors.includes("beta"));
  });

  it("does not split headings that live inside a code fence", () => {
    const page = parseWikiPage(
      ["# Real", "before", "```", "# Not A Heading", "```", "after"].join("\n"),
    );
    assert.deepEqual(
      page.toc.map((t) => t.anchor),
      ["real"],
    );
  });

  it("sub-splits an oversized section into parts carrying the same anchor", () => {
    const para = "word ".repeat(120).trim(); // ~600 chars
    const body = ["# Big", para, "", para, "", para, "", para].join("\n"); // ~2400 chars
    const page = parseWikiPage(body);
    const bigChunks = page.chunks.filter((c) => c.anchor === "big");
    assert.ok(bigChunks.length >= 2, "oversized section should split into >=2 parts");
    assert.deepEqual(
      bigChunks.map((c) => c.part),
      bigChunks.map((_, i) => i),
    );
  });

  it("gives each chunk a content hash", () => {
    const page = parseWikiPage(["# A", "alpha"].join("\n"));
    assert.match(page.chunks[0].hash, /^[0-9a-f]{64}$/);
  });
});

describe("normalizeSlug", () => {
  it("ensures a .md extension", () => {
    assert.equal(normalizeSlug("live-loop"), "live-loop.md");
    assert.equal(normalizeSlug("live-loop.md"), "live-loop.md");
    assert.equal(normalizeSlug("/live-loop"), "live-loop.md");
    assert.equal(normalizeSlug("shared/live-loop"), "shared/live-loop.md");
  });
});

// ── Local vs shared ─────────────────────────────────────────────────────────
//
// A fold's wiki is `wiki/` plus at most `wiki/shared/`. The caller's own fold
// (an owned source) sees both; any other fold (`shared_only`) sees only
// `shared/`. The slug is the path under `wiki/`, so a shared page is
// `shared/foo.md` for every reader.

function sharedFixture(): { owned: WikiSource; foreign: WikiSource } {
  const dir = join(mkdtempSync(join(tmpdir(), "wiki-shared-")), "wiki");
  mkdirSync(join(dir, "shared"), { recursive: true });
  writeFileSync(join(dir, "local.md"), ["# Local", "fold-private thinking about walruses", "## Sec", "more"].join("\n"));
  writeFileSync(join(dir, "shared", "pub.md"), ["# Pub", "published claim about walruses", "## Sec", "more"].join("\n"));
  // Same basename on both sides: the local one wins for the owner's bare slug.
  writeFileSync(join(dir, "both.md"), "# Both (local)\nlocal body\n");
  writeFileSync(join(dir, "shared", "both.md"), "# Both (shared)\nshared body\n");
  return {
    owned: { source: "fold", dir, fold_path: "~/fold" },
    foreign: { source: "fold", dir, fold_path: "~/fold", shared_only: true },
  };
}

describe("locatePage", () => {
  it("resolves a bare slug to the local page first, then falls through to shared/", () => {
    const { owned } = sharedFixture();
    assert.deepEqual(locatePage(owned, "local"), { status: "ok", filename: "local.md" });
    assert.deepEqual(locatePage(owned, "pub"), { status: "ok", filename: "shared/pub.md" });
    assert.deepEqual(locatePage(owned, "shared/pub.md"), { status: "ok", filename: "shared/pub.md" });
    assert.deepEqual(locatePage(owned, "both"), { status: "ok", filename: "both.md" });
    assert.equal(locatePage(owned, "ghost").status, "missing");
  });

  it("reports a foreign fold's local page as local, not missing, and refuses escapes", () => {
    const { foreign } = sharedFixture();
    assert.deepEqual(locatePage(foreign, "local"), { status: "local", filename: "local.md" });
    assert.deepEqual(locatePage(foreign, "pub"), { status: "ok", filename: "shared/pub.md" });
    // The bare slug still hits the local file first, and that is the honest
    // answer: it exists, and it is not shared.
    assert.deepEqual(locatePage(foreign, "both"), { status: "local", filename: "both.md" });
    assert.deepEqual(locatePage(foreign, "shared/both"), { status: "ok", filename: "shared/both.md" });
    assert.equal(locatePage(foreign, "../etc/passwd").status, "missing");
    assert.equal(locatePage(foreign, "shared/../local").status, "missing");
  });
});

describe("shared/ visibility across list, read, search", () => {
  it("the owner lists both; a foreign caller lists only shared/, with the shared flag set", () => {
    const { owned, foreign } = sharedFixture();
    const mine = listWiki([owned]).map((e) => [e.slug, e.shared]);
    assert.deepEqual(mine, [
      ["both.md", false],
      ["local.md", false],
      ["shared/both.md", true],
      ["shared/pub.md", true],
    ]);
    const theirs = listWiki([foreign]).map((e) => e.slug);
    assert.deepEqual(theirs, ["shared/both.md", "shared/pub.md"]);
  });

  it("read: a foreign caller gets 'local, not shared' for a local page, and the page for a shared one", () => {
    const { owned, foreign } = sharedFixture();
    const ok = readWiki([owned], "fold", "local");
    assert.ok(!("error" in ok));
    const denied = readWiki([foreign], "fold", "local");
    assert.ok("error" in denied);
    if ("error" in denied) assert.match(denied.error, /local to wiki source "fold", not shared/);
    const pub = readWiki([foreign], "fold", "pub");
    assert.ok(!("error" in pub));
    if (!("error" in pub)) assert.equal(pub.citation, "shared/pub.md");
    const section = readWikiSection([foreign], "fold", "shared/pub", { anchor: "sec" });
    assert.ok(!("error" in section));
    if (!("error" in section)) assert.equal(section.citation, "shared/pub.md#sec");
    const deniedSection = readWikiSection([foreign], "fold", "local", { anchor: "sec" });
    assert.ok("error" in deniedSection);
  });

  it("search: the same index answers the owner with both pages and a foreign caller with shared/ only", async () => {
    const { owned, foreign } = sharedFixture();
    const db = new Database(":memory:");
    const embed = makeStubEmbedder();
    // The stub embedder scores every chunk alike, so the interesting
    // property is membership, not ranking: the owner's results reach the
    // local page; a foreign caller's never do.
    const mine = await searchWiki(db, [owned], "walruses", 10, embed);
    const mineSlugs = mine.map((a) => a.slug);
    assert.ok(mineSlugs.includes("local.md"), "owner search reaches the local page");
    assert.ok(mineSlugs.includes("shared/pub.md"), "owner search reaches the shared page");
    // Same DB, same rows — visibility is decided at query time, not index time.
    const theirs = await searchWiki(db, [foreign], "walruses", 10, embed);
    assert.ok(theirs.length > 0, "foreign search still answers");
    assert.ok(theirs.every((a) => a.slug.startsWith("shared/")), "foreign search sees shared/ only");
    assert.ok(
      theirs.every((a) => a.hits.every((h) => h.citation.startsWith("shared/"))),
      "every citation handed to a foreign caller is a shared one",
    );
  });
});

function fixtureSources(): WikiSource[] {
  const root = mkdtempSync(join(tmpdir(), "wiki-test-"));
  const brane = join(root, "brane-wiki");
  const fold = join(root, "fold-wiki");
  mkdirSync(brane);
  mkdirSync(fold);
  writeFileSync(
    join(brane, "philosophy.md"),
    ["---", "description: brane's vantage point", "---", "# Philosophy", "Core idea.", "## Detail", "More."].join("\n"),
  );
  writeFileSync(join(fold, "notes.md"), ["# Notes", "Project notes here."].join("\n"));
  writeFileSync(join(fold, "philosophy.md"), ["# Local Philosophy", "Fold-local."].join("\n"));
  return [
    { source: "brane", dir: brane },
    { source: "fold", dir: fold, fold_path: "~/fold" },
  ];
}

describe("listWiki", () => {
  it("lists pages from all sources with descriptions and source labels", () => {
    const sources = fixtureSources();
    const entries = listWiki(sources);
    const phil = entries.find((e) => e.slug === "philosophy.md" && e.source === "brane");
    assert.ok(phil);
    assert.equal(phil.description, "brane's vantage point");
    // Fold page without frontmatter falls back to first prose line.
    const notes = entries.find((e) => e.slug === "notes.md");
    assert.equal(notes?.description, "Project notes here.");
    assert.equal(notes?.source, "fold");
  });

  it("filters by source and substring", () => {
    const sources = fixtureSources();
    assert.ok(listWiki(sources, { source: "fold" }).every((e) => e.source === "fold"));
    assert.ok(listWiki(sources, { filter: "notes" }).every((e) => e.slug.includes("notes")));
  });
});

describe("readWiki", () => {
  it("returns the whole page plus a TOC and slug citation", () => {
    const sources = fixtureSources();
    const res = readWiki(sources, "brane", "philosophy");
    assert.ok(!("error" in res));
    if ("error" in res) return;
    assert.equal(res.source, "brane");
    assert.equal(res.citation, "philosophy.md");
    assert.ok(res.content.includes("Core idea."));
    assert.deepEqual(
      res.toc.map((t) => t.anchor),
      ["philosophy", "detail"],
    );
  });

  it("returns a single anchored section with a slug#anchor citation", () => {
    const sources = fixtureSources();
    const res = readWiki(sources, "brane", "philosophy", { anchor: "detail" });
    assert.ok(!("error" in res));
    if ("error" in res) return;
    assert.equal(res.citation, "philosophy.md#detail");
    assert.ok(res.content.includes("More."));
    assert.ok(!res.content.includes("Core idea."));
  });

  it("errors on an unknown source or missing page or bad anchor", () => {
    const sources = fixtureSources();
    assert.ok("error" in readWiki(sources, "nope", "philosophy"));
    assert.ok("error" in readWiki(sources, "brane", "missing"));
    assert.ok("error" in readWiki(sources, "brane", "philosophy", { anchor: "ghost" }));
  });
});

function navFixture(): WikiSource[] {
  const dir = mkdtempSync(join(tmpdir(), "wiki-nav-"));
  writeFileSync(
    join(dir, "page.md"),
    ["# Top", "Intro prose.", "## A", "Body A.", "## B", "Body B.", "## C", "Body C.", "## D", "Body D."].join("\n"),
  );
  return [{ source: "brane", dir }];
}

describe("readWikiSection (neighbor-aware read)", () => {
  it("starts at the page top with no anchor: empty prev, forward window", () => {
    const res = readWikiSection(navFixture(), "brane", "page", { window: 2 });
    assert.ok(!("error" in res));
    if ("error" in res) return;
    assert.equal(res.current.anchor, "top");
    assert.equal(res.citation, "page.md#top");
    assert.deepEqual(res.prev, []);
    assert.deepEqual(res.next.map((n) => n.anchor), ["a", "b"]);
    assert.deepEqual(res.position, { index: 0, total: 5 });
    assert.ok(res.current.content.includes("Intro prose."));
  });

  it("windows prev/next nearest-first around a mid-page anchor, with previews", () => {
    const res = readWikiSection(navFixture(), "brane", "page", { anchor: "c", window: 2 });
    assert.ok(!("error" in res));
    if ("error" in res) return;
    assert.equal(res.current.anchor, "c");
    assert.ok(res.current.content.includes("Body C."));
    // nearest-first on both sides
    assert.deepEqual(res.prev.map((n) => n.anchor), ["b", "a"]);
    assert.deepEqual(res.next.map((n) => n.anchor), ["d"]);
    assert.deepEqual(res.position, { index: 3, total: 5 });
    // a neighbor carries a one-line preview, not its full content
    assert.equal(res.next[0].heading, "D");
    assert.equal(res.next[0].preview, "Body D.");
  });

  it("caps the window and stays in-bounds at the page edges", () => {
    const res = readWikiSection(navFixture(), "brane", "page", { anchor: "a", window: 50 });
    assert.ok(!("error" in res));
    if ("error" in res) return;
    assert.deepEqual(res.prev.map((n) => n.anchor), ["top"]);
    assert.deepEqual(res.next.map((n) => n.anchor), ["b", "c", "d"]);
  });

  it("errors on a bad anchor with the list of valid anchors", () => {
    const res = readWikiSection(navFixture(), "brane", "page", { anchor: "ghost" });
    assert.ok("error" in res);
    if (!("error" in res)) return;
    assert.match(res.error, /ghost/);
    assert.match(res.error, /top, a, b, c, d/);
  });
});

// ── Index reconciliation + search (deterministic stub embedder) ─────────────
//
// The transformers model is heavy and network-dependent, so these tests inject
// a deterministic stub embedder (constant vectors) into syncWikiIndex/searchWiki
// — covering the SyncStats bookkeeping and the grouping/scoping/reconciliation
// logic without any model download. The stub records its calls so a test can
// assert exactly which content was (re-)embedded.

/** Constant-vector embedder that records every batch it was asked to embed. */
function makeStubEmbedder(): WikiEmbedder & { batches: string[][] } {
  const batches: string[][] = [];
  const fn: WikiEmbedder = async (texts) => {
    batches.push(texts);
    return texts.map(() => new Float32Array(VECTOR_DIM).fill(0.1));
  };
  return Object.assign(fn, { batches });
}

/** A single-source wiki backed by a fresh temp dir + in-memory DB. */
function indexFixture(): {
  db: Database.Database;
  sources: WikiSource[];
  write: (slug: string, body: string) => void;
  embed: WikiEmbedder & { batches: string[][] };
} {
  const dir = join(mkdtempSync(join(tmpdir(), "wiki-idx-")), "wiki");
  mkdirSync(dir, { recursive: true });
  return {
    db: new Database(":memory:"),
    sources: [{ source: "brane", dir }],
    write: (slug, body) => writeFileSync(join(dir, slug), body),
    embed: makeStubEmbedder(),
  };
}

describe("syncWikiIndex reconciliation", () => {
  it("re-embeds only the changed section on a light edit (hash-skip)", async () => {
    const { db, sources, write, embed } = indexFixture();
    write("doc.md", "# Doc\nintro\n## Alpha\nalpha body\n## Beta\nbeta body\n");
    const first = await syncWikiIndex(db, sources, embed);
    assert.equal(first.chunks_reembedded, 3); // doc + alpha + beta
    assert.equal(first.chunks_removed, 0);

    // Edit only Beta's body; Alpha and the preamble are byte-identical.
    write("doc.md", "# Doc\nintro\n## Alpha\nalpha body\n## Beta\nbeta body EDITED\n");
    embed.batches.length = 0;
    const second = await syncWikiIndex(db, sources, embed);
    assert.equal(second.chunks_reembedded, 1);
    // Exactly one content string was re-embedded, and it's the edited Beta.
    assert.equal(embed.batches.length, 1);
    assert.equal(embed.batches[0].length, 1);
    assert.match(embed.batches[0][0], /EDITED/);
  });

  it("a no-change resync re-embeds nothing and invokes the embedder zero times (empty-tx guard)", async () => {
    const { db, sources, write, embed } = indexFixture();
    write("doc.md", "# Doc\nbody\n## S\nsection\n");
    await syncWikiIndex(db, sources, embed);
    embed.batches.length = 0;
    const again = await syncWikiIndex(db, sources, embed);
    assert.equal(again.chunks_reembedded, 0);
    assert.equal(again.chunks_removed, 0);
    assert.equal(embed.batches.length, 0); // no embedding work → no write tx
  });

  it("removes chunks for a deleted or renamed section so they cannot resurface", async () => {
    const { db, sources, write, embed } = indexFixture();
    write("doc.md", "# Doc\nintro\n## Alpha\nalpha about penguins\n## Beta\nbeta about glaciers\n");
    await syncWikiIndex(db, sources, embed);

    // Rename Alpha's heading (anchor changes) and delete Beta entirely.
    write("doc.md", "# Doc\nintro\n## Renamed Alpha\nalpha about walruses\n");
    const stats = await syncWikiIndex(db, sources, embed);
    // Old #alpha (content changed → id changed via anchor) + #beta both gone.
    assert.equal(stats.chunks_removed, 2);

    const rows = db.prepare("SELECT id FROM wiki_chunks").all() as Array<{ id: string }>;
    // id = source\0slug\0anchor\0part — pull out the anchor field.
    const anchors = rows.map((r) => r.id.split("\0")[2]).sort();
    assert.deepEqual(anchors, ["doc", "renamed-alpha"]);
    assert.ok(!anchors.includes("alpha"), "old #alpha anchor must be gone");
    assert.ok(!anchors.includes("beta"), "deleted #beta anchor must be gone");

    // The removed section never appears in a subsequent search.
    const res = await searchWiki(db, sources, "glaciers", 10, embed);
    const citations = res.flatMap((a) => a.hits.map((h) => h.citation));
    assert.ok(!citations.includes("doc.md#beta"), "stale #beta must not resurface");
  });
});

describe("searchWiki grouping + scoping", () => {
  it("groups chunk hits under their article with article score = best hit", async () => {
    const { db, sources, write, embed } = indexFixture();
    write("a.md", "# A\n## One\nshared keyword here\n## Two\nshared keyword again plus more\n");
    write("b.md", "# B\nshared keyword once\n");
    const res = await searchWiki(db, sources, "keyword", 10, embed);

    // Results are grouped by article, each carrying its section/chunk hits.
    const a = res.find((x) => x.slug === "a.md");
    assert.ok(a, "article a.md present");
    assert.ok(a.hits.length >= 2, "a.md groups multiple section hits");
    // Article score is the max of its hits' scores; hits are ranked within.
    assert.equal(a.score, Math.max(...a.hits.map((h) => h.score)));
    for (let i = 1; i < a.hits.length; i++) {
      assert.ok(a.hits[i - 1].score >= a.hits[i].score, "hits ranked desc");
    }
    // Every hit carries a slug#anchor (or slug) citation stamped to the article.
    assert.ok(a.hits.every((h) => h.citation.startsWith("a.md")));
  });

  it("caps the number of chunk hits, not the number of articles", async () => {
    const { db, sources, write, embed } = indexFixture();
    // Three articles, each with four sections that all match the query — 12
    // matching chunks total, spread across only 3 articles.
    for (const slug of ["a.md", "b.md", "c.md"]) {
      write(
        slug,
        `# ${slug}\n## One\nshared keyword\n## Two\nshared keyword\n` +
          `## Three\nshared keyword\n## Four\nshared keyword\n`,
      );
    }
    const res = await searchWiki(db, sources, "keyword", 5, embed);

    // limit bounds chunk hits (like narrative_search bounds messages), so the
    // total hits across all returned articles is exactly 5 — even though far
    // more chunks matched and only 3 articles exist.
    const totalHits = res.reduce((n, a) => n + a.hits.length, 0);
    assert.equal(totalHits, 5, "total chunk hits is capped at limit");
    assert.ok(res.length <= 3, "hits stay grouped under their articles");
  });

  it("scopes results to the requested sources (dormant chunks from other sources don't leak)", async () => {
    const dirA = join(mkdtempSync(join(tmpdir(), "wiki-a-")), "wiki");
    const dirB = join(mkdtempSync(join(tmpdir(), "wiki-b-")), "wiki");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, "x.md"), "# X\nshared token alpha\n");
    writeFileSync(join(dirB, "y.md"), "# Y\nshared token beta\n");
    const A: WikiSource = { source: "A", dir: dirA };
    const B: WikiSource = { source: "B", dir: dirB };
    const db = new Database(":memory:");
    const embed = makeStubEmbedder();

    // Index both sources, then search only A — B's chunks are dormant in the DB.
    await syncWikiIndex(db, [A, B], embed);
    const res = await searchWiki(db, [A], "shared token", 10, embed);
    assert.ok(res.length > 0, "A has results");
    assert.ok(res.every((a) => a.source === "A"), "no B results leak through");
  });

  it("drops hits below the relevance floor instead of padding with noise", async () => {
    const { db, sources, write } = indexFixture();
    // Embedder puts the "noise" page on a different axis from everything else,
    // so its cosine score is ~0 (below the floor); the query and the "match"
    // page share an axis (score ~1). No shared query term → no keyword boost,
    // isolating the vector score.
    const embed: WikiEmbedder = async (texts) =>
      texts.map((t) => {
        const v = new Float32Array(VECTOR_DIM);
        v[t.includes("NOISEONLY") ? 1 : 0] = 1;
        return v;
      });
    write("match.md", "# Match\nrelevant material on the subject.\n");
    write("noise.md", "# Noise\nNOISEONLY off-topic filler.\n");
    const res = await searchWiki(db, sources, "xyzzy", 10, embed);
    assert.deepEqual(
      res.map((a) => a.slug),
      ["match.md"],
      "only the above-floor hit survives; the orthogonal noise page is dropped",
    );
  });
});
