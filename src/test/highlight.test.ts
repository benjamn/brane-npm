import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, highlight, resolveLang } from "../highlight.js";

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

describe("GraphQL grammar corrections", () => {
  // Each line of a fence as its [text, color] tokens, blanks dropped.
  async function lines(source: string, lang = "graphql") {
    const result = await highlight(source, lang);
    assert.ok(result);
    return result.tokens.map((line) => line.filter((t) => t.c.trim()).map((t) => [t.c.trim(), t.f]));
  }
  // The color of the first token containing `text`.
  async function colorOf(source: string, text: string) {
    const token = (await lines(source)).flat().find(([c]) => c?.includes(text));
    assert.ok(token, `no token contains ${text}`);
    return token[1];
  }

  // Must stay the first test here: it needs the highlighter's first load to be
  // a language that embeds graphql, which would pin the stock grammar if the
  // patched one weren't already registered.
  it("survives a language that embeds graphql loading first", async () => {
    assert.ok(await highlight("x = 1", "ruby"));
    const after = await lines("schema @a\ntype Query { a: Int }");
    assert.deepEqual(after[1], (await lines("type Query { a: Int }"))[0]);
  });

  it("ends a schema with no body at the next definition", async () => {
    const definition = (await lines("type Query { a: Int }"))[0];
    for (const schema of [
      "extend schema\n  @link(url: \"u\", import: [\"@key\"])\n  @source(name: \"m\", http: { baseURL: \"b\" })",
      "schema @a",
      "schema @a(x: { b: 1 })",
      "schema @a # note",
      "schema",
    ]) {
      const all = await lines(`${schema}\n\ntype Query { a: Int }`);
      assert.deepEqual(all.at(-1), definition, schema);
    }
  });

  it("still reads a schema's body, wherever its brace falls", async () => {
    const stock = await lines("schema { query: Query }");
    assert.deepEqual((await lines("schema\n{ query: Query }")).flat(), stock.flat());
    assert.deepEqual((await lines("schema @a { query: Query }")).at(-1)?.slice(-3), stock[0].slice(-3));
    const definition = (await lines("type After { a: Int }"))[0];
    assert.deepEqual((await lines("schema { query: Query }\ntype After { a: Int }"))[1], definition);
  });

  it("doesn't take a field named schema for a definition", async () => {
    const plain = (await lines("type T { other: String }"))[0].map(([, color]) => color);
    const named = (await lines("type T { schema: String }"))[0].map(([, color]) => color);
    assert.deepEqual(named, plain);
  });

  it("colors a block string value as a string, not a description", async () => {
    const string = await colorOf('type T { f: Int @d(a: "s") }', '"s"');
    const description = await colorOf('type T {\n  """doc"""\n  f: Int\n}', "doc");
    assert.notEqual(string, description);
    for (const source of [
      'type T { f: Int @d(a: """\n  body\n  """) }',
      'type T { f: Int @d(h: { a: """\n  body\n  """ }) }',
      'query { f(a: """\n  body\n  """) }',
      'type T { f: Int @d(a:"""\n  body\n  """) }',
    ]) {
      assert.equal(await colorOf(source, "body"), string, source);
    }
  });

  it("colors a string value as a string with no space after the colon", async () => {
    assert.equal(await colorOf('type T { f: Int @d(a:"s") }', '"s"'), await colorOf('type T { f: Int @d(a: "s") }', '"s"'));
  });

  it("resumes highlighting after a block string, past an escaped delimiter", async () => {
    const after = 'stream: "x"';
    const plain = await colorOf(`type T { f: Int @d(a: "s", ${after}) }`, "stream");
    assert.equal(await colorOf(`type T { f: Int @d(a: """b""", ${after}) }`, "stream"), plain);
    assert.equal(await colorOf(`type T { f: Int @d(a: """b\\""" c""", ${after}) }`, "stream"), plain);
  });

  it("leaves descriptions as they were", async () => {
    const comment = await colorOf("# note\ntype T { a: Int }", "note");
    for (const source of ['"""doc"""\ntype T { a: Int }', 'type T {\n  """doc"""\n  a: Int\n}', 'type T {\n  "doc"\n  a: Int\n}', 'type T { f("""doc""" a: Int): Int }']) {
      assert.equal(await colorOf(source, "doc"), comment, source);
    }
  });
});
