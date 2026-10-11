import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { narrativeIdLinks } from "../shared/markdown-nids.js";

// These exercise the live app's markdown pipeline (expo/components/Markdown.tsx)
// through the same two extensions it installs: GFM autolink literals, then the
// narrative-id tree transform. The transform is the part worth pinning — it
// replaced a regex over raw markdown source, and the whole reason for the swap
// is that the parser, not a pattern, decides what counts as prose.

const KNOWN = new Set(["claude-4c7289d1", "goose-aa11bb22"]);

/** Parses the way the app does and returns the resulting mdast tree. */
function render(md: string, knownIds: Set<string> = KNOWN): any {
  return fromMarkdown(md, {
    extensions: [gfmAutolinkLiteral()],
    mdastExtensions: [gfmAutolinkLiteralFromMarkdown(), narrativeIdLinks(knownIds)],
  });
}

/** Flattens a tree to `[type, url|value]` pairs for the leaves that carry text,
 *  so assertions read as "what the reader ends up seeing". */
function leaves(node: any, out: Array<[string, string]> = []): Array<[string, string]> {
  if (node.type === "link") {
    out.push(["link", node.url]);
    return out;
  }
  if (node.type === "inlineCode" || node.type === "code" || node.type === "text") {
    out.push([node.type, node.value]);
    return out;
  }
  for (const child of node.children ?? []) leaves(child, out);
  return out;
}

function urls(md: string, knownIds?: Set<string>): string[] {
  return leaves(render(md, knownIds)).filter(([t]) => t === "link").map(([, u]) => u);
}

describe("autolink literals", () => {
  it("links bare http(s) URLs", () => {
    assert.deepEqual(urls("see https://example.com/a?b=1 now"), ["https://example.com/a?b=1"]);
  });

  it("links www. literals with an implied scheme", () => {
    assert.deepEqual(urls("see www.example.com now"), ["http://www.example.com"]);
  });

  it("links bare email addresses via mailto:", () => {
    assert.deepEqual(urls("mail ben@example.com now"), ["mailto:ben@example.com"]);
  });

  it("leaves trailing sentence punctuation outside the link", () => {
    const l = leaves(render("read https://example.com/docs."));
    assert.deepEqual(l, [
      ["text", "read "],
      ["link", "https://example.com/docs"],
      ["text", "."],
    ]);
  });

  it("balances trailing parens", () => {
    // GFM keeps a closing paren only when it balances one inside the URL.
    assert.deepEqual(urls("(see https://en.wikipedia.org/wiki/Foo_(bar))"), [
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("does not touch URLs inside code spans or fenced blocks", () => {
    assert.deepEqual(urls("`https://example.com`"), []);
    assert.deepEqual(urls("```\nhttps://example.com\n```"), []);
  });

  it("leaves an explicit markdown link's href alone", () => {
    assert.deepEqual(urls("[docs](https://example.com/x)"), ["https://example.com/x"]);
  });
});

describe("narrative id linkification", () => {
  it("links a bare id and an id:seq reference", () => {
    assert.deepEqual(urls("see claude-4c7289d1 and claude-4c7289d1:42"), [
      "brane://nid/claude-4c7289d1",
      "brane://nid/claude-4c7289d1/42",
    ]);
  });

  it("keeps the surrounding prose intact around a reference", () => {
    assert.deepEqual(leaves(render("before claude-4c7289d1:7 after")), [
      ["text", "before "],
      ["link", "brane://nid/claude-4c7289d1/7"],
      ["text", " after"],
    ]);
  });

  it("links only ids that actually exist", () => {
    assert.deepEqual(urls("claude-deadbeef is not a narrative"), []);
    assert.deepEqual(urls("claude-4c7289d1", new Set<string>()), []);
  });

  it("promotes a code span that is exactly one reference", () => {
    assert.deepEqual(urls("`claude-4c7289d1:42`"), ["brane://nid/claude-4c7289d1/42"]);
  });

  it("leaves a code span that merely contains a reference as code", () => {
    assert.deepEqual(leaves(render("`brane list claude-4c7289d1`")), [
      ["inlineCode", "brane list claude-4c7289d1"],
    ]);
  });

  it("does not touch references inside fenced code", () => {
    assert.deepEqual(urls("```\nclaude-4c7289d1\n```"), []);
  });

  it("does not rewrite the label or href of an existing link", () => {
    const l = leaves(render("[claude-4c7289d1](https://example.com/x)"));
    assert.deepEqual(l, [["link", "https://example.com/x"]]);
  });

  it("links references inside emphasis, headings and list items", () => {
    assert.deepEqual(urls("*claude-4c7289d1*"), ["brane://nid/claude-4c7289d1"]);
    assert.deepEqual(urls("# claude-4c7289d1"), ["brane://nid/claude-4c7289d1"]);
    assert.deepEqual(urls("- claude-4c7289d1"), ["brane://nid/claude-4c7289d1"]);
  });

  it("links several references in one text run", () => {
    assert.deepEqual(urls("claude-4c7289d1 then goose-aa11bb22:3"), [
      "brane://nid/claude-4c7289d1",
      "brane://nid/goose-aa11bb22/3",
    ]);
  });

  it("skips unknown ids without disturbing known ones beside them", () => {
    assert.deepEqual(leaves(render("claude-deadbeef vs claude-4c7289d1 ok")), [
      ["text", "claude-deadbeef vs "],
      ["link", "brane://nid/claude-4c7289d1"],
      ["text", " ok"],
    ]);
  });

  it("leaves a URL whose path contains a narrative id intact", () => {
    // The regression that motivated moving off a source-level regex: the old
    // linkifier rewrote the id *inside* the URL, producing nested link syntax.
    assert.deepEqual(urls("https://brane.organelle.dev/claude-4c7289d1"), [
      "https://brane.organelle.dev/claude-4c7289d1",
    ]);
  });

  it("gives every synthesized node a key, so React can list them", () => {
    // Nodes the parser produced are keyed by the renderer's own extension,
    // which runs before this one; nodes this transform *creates* have to bring
    // their own. So the paragraph's rewritten children are what's under test.
    const paragraph: any = render("before claude-4c7289d1:7 after").children[0];
    const keys: string[] = [];
    const collect = (n: any) => {
      keys.push(n.key);
      for (const c of n.children ?? []) collect(c);
    };
    for (const child of paragraph.children) collect(child);
    assert.equal(keys.length, 4); // text, link, link's label, text
    assert.ok(keys.every((k) => typeof k === "string" && k.length > 0), `missing keys: ${keys}`);
    assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys}`);
  });
});
