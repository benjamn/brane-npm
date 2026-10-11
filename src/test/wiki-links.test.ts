import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSharedSlug, normalizeWikiSlug, resolveWikiLink } from "../shared/wiki-links.js";

describe("normalizeWikiSlug", () => {
  it("strips leading slashes and ./, appends .md only when there is no extension", () => {
    assert.equal(normalizeWikiSlug("foo"), "foo.md");
    assert.equal(normalizeWikiSlug("/foo.md"), "foo.md");
    assert.equal(normalizeWikiSlug("./shared/foo"), "shared/foo.md");
    assert.equal(normalizeWikiSlug("shared/pic.png"), "shared/pic.png");
  });
});

describe("isSharedSlug", () => {
  it("is exactly the shared/ prefix", () => {
    assert.equal(isSharedSlug("shared/foo.md"), true);
    assert.equal(isSharedSlug("shared/foo"), true);
    assert.equal(isSharedSlug("foo.md"), false);
    assert.equal(isSharedSlug("sharedfoo.md"), false);
  });
});

describe("resolveWikiLink", () => {
  // [from, href, expected] — the grid the daemon and the reader must agree on.
  const grid: Array<[string, string, ReturnType<typeof resolveWikiLink>]> = [
    // local → local
    ["a.md", "b.md", { slug: "b.md" }],
    ["a.md", "./b.md", { slug: "b.md" }],
    ["a.md", "b", { slug: "b.md" }],
    // local → shared
    ["a.md", "shared/b.md", { slug: "shared/b.md" }],
    ["a.md", "./shared/b", { slug: "shared/b.md" }],
    // shared → shared (sibling)
    ["shared/a.md", "b.md", { slug: "shared/b.md" }],
    ["shared/a.md", "./b.md", { slug: "shared/b.md" }],
    // shared → local (a citation, not a promise)
    ["shared/a.md", "../c.md", { slug: "c.md" }],
    ["shared/a.md", "../c", { slug: "c.md" }],
    // anchors ride along; a bare anchor stays on the page
    ["a.md", "b.md#sec", { slug: "b.md", anchor: "sec" }],
    ["shared/a.md", "../c.md#sec", { slug: "c.md", anchor: "sec" }],
    ["shared/a.md", "#sec", { slug: "shared/a.md", anchor: "sec" }],
    ["a", "#sec", { slug: "a.md", anchor: "sec" }],
    // not intra-wiki
    ["a.md", "https://example.com/x.md", null],
    ["a.md", "mailto:x@y", null],
    ["a.md", "/etc/passwd", null],
    ["a.md", "../outside.md", null],
    ["shared/a.md", "../../outside.md", null],
    ["shared/a.md", "..", null],
    // non-markdown relative targets keep their extension
    ["shared/a.md", "../img/pic.png", { slug: "img/pic.png" }],
  ];

  for (const [from, href, expected] of grid) {
    it(`${from} + ${href} → ${expected ? JSON.stringify(expected) : "null"}`, () => {
      assert.deepEqual(resolveWikiLink(from, href), expected);
    });
  }
});
