import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, resolveLang } from "../highlight.js";

describe("detectLanguage", () => {
  it("maps extensions that differ from the shiki language id", () => {
    assert.equal(detectLanguage("src/daemon/server.ts"), "typescript");
    assert.equal(detectLanguage("main.rs"), "rust");
    assert.equal(detectLanguage("script.py"), "python");
  });

  it("falls back to the bare extension when shiki knows it as a language", () => {
    // The bug this covers: `.lean` was absent from EXT_LANG, so a Lean file
    // rendered as plain monochrome text even though shiki bundles the grammar.
    assert.equal(detectLanguage("Mathlib/Order/Basic.lean"), "lean");
    assert.equal(detectLanguage("build.zig"), "zig");
    assert.equal(detectLanguage("paper.tex"), "tex");
  });

  it("prefers the explicit map over the extension fallback", () => {
    // Shiki bundles no SVG grammar at all, so `.svg` has to name xml itself —
    // the bare-extension fallback would find nothing. Same reason ```svg went
    // unhighlighted in chat until resolveLang existed.
    assert.equal(detectLanguage("logo.svg"), "xml");
  });

  it("returns null for markdown, which the client renders itself", () => {
    assert.equal(detectLanguage("README.md"), null);
    assert.equal(detectLanguage("notes.mdx"), null);
  });

  it("returns null for unknown and extensionless files", () => {
    assert.equal(detectLanguage("data.unknownext"), null);
    assert.equal(detectLanguage("LICENSE"), null);
  });

  it("matches basename rules, including suffixed variants", () => {
    assert.equal(detectLanguage("Dockerfile"), "docker");
    assert.equal(detectLanguage("deploy/Dockerfile.dev"), "docker");
    assert.equal(detectLanguage("Makefile"), "make");
  });
});

describe("resolveLang", () => {
  it("passes through the ids and aliases shiki already knows", () => {
    assert.equal(resolveLang("typescript"), "typescript");
    assert.equal(resolveLang("js"), "js");
    assert.equal(resolveLang("yml"), "yml");
  });

  it("resolves a tag shiki lacks by reading it as a file extension", () => {
    // The bug: ```svg rendered as plain text in chat while the identical file
    // highlighted in the Files tab, because only that path consulted EXT_LANG.
    assert.equal(resolveLang("svg"), "xml");
  });

  it("covers the few tags that are neither grammars nor extensions", () => {
    assert.equal(resolveLang("golang"), "go");
    assert.equal(resolveLang("patch"), "diff");
    assert.equal(resolveLang("plist"), "xml");
  });

  it("normalizes case and stray whitespace", () => {
    assert.equal(resolveLang("SVG"), "xml");
    assert.equal(resolveLang("  TypeScript "), "typescript");
  });

  it("returns null for nothing, blanks, and words no grammar answers to", () => {
    assert.equal(resolveLang(null), null);
    assert.equal(resolveLang(undefined), null);
    assert.equal(resolveLang("   "), null);
    assert.equal(resolveLang("nonsenselang"), null);
  });

  it("does not let markdown's client-side rendering leak into fences", () => {
    // detectLanguage returns null for .md so FilesView renders it itself, but
    // ```md in a chat bubble is a code listing and shiki has the grammar.
    assert.equal(resolveLang("md"), "md");
  });
});
