import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { narrativeIdLinks } from "../shared/markdown-nids.js";
import { protocolLinks } from "../shared/markdown-protocols.js";

// `/ramify` in a message should open the protocol. The hard part isn't linking
// it — it's *not* linking the slashes that fill ordinary agent chatter: paths,
// dates, `and/or`. These pin both halves.

const KNOWN = new Set(["ramify", "memory", "LIVE_loop", "reviewer.draft"]);

function render(md: string, known: Set<string> = KNOWN): any {
  return fromMarkdown(md, {
    extensions: [gfmAutolinkLiteral()],
    mdastExtensions: [gfmAutolinkLiteralFromMarkdown(), protocolLinks(known)],
  });
}

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

function urls(md: string, known?: Set<string>): string[] {
  return leaves(render(md, known)).filter(([t]) => t === "link").map(([, u]) => u);
}

describe("protocol command linkification", () => {
  it("links a bare command", () => {
    assert.deepEqual(urls("run /ramify now"), ["brane://protocol/ramify"]);
  });

  it("links names with underscores and dots", () => {
    assert.deepEqual(urls("/LIVE_loop and /reviewer.draft"), [
      "brane://protocol/LIVE_loop",
      "brane://protocol/reviewer.draft",
    ]);
  });

  it("links only protocols that actually exist", () => {
    assert.deepEqual(urls("/nonesuch is not a protocol"), []);
    assert.deepEqual(urls("/ramify", new Set<string>()), []);
  });

  it("keeps the surrounding prose intact", () => {
    assert.deepEqual(leaves(render("try /memory please")), [
      ["text", "try "],
      ["link", "brane://protocol/memory"],
      ["text", " please"],
    ]);
  });

  it("leaves the command's arguments as prose", () => {
    assert.deepEqual(leaves(render("/ramify fix the auth module")), [
      ["link", "brane://protocol/ramify"],
      ["text", " fix the auth module"],
    ]);
  });

  it("drops trailing sentence punctuation from the link", () => {
    assert.deepEqual(leaves(render("as described in /memory.")), [
      ["text", "as described in "],
      ["link", "brane://protocol/memory"],
      ["text", "."],
    ]);
    assert.deepEqual(leaves(render("either /ramify, or not")), [
      ["text", "either "],
      ["link", "brane://protocol/ramify"],
      ["text", ", or not"],
    ]);
  });

  it("ignores a path segment that happens to name a protocol", () => {
    assert.deepEqual(urls("see src/memory/index.ts"), []);
    assert.deepEqual(urls("~/memory holds the db"), []);
    assert.deepEqual(urls("./memory"), []);
    assert.deepEqual(urls("/memory/index.ts"), []);
  });

  it("ignores a slash used as a conjunction", () => {
    assert.deepEqual(urls("read and/or write"), []);
  });

  it("promotes a code span that is exactly one command", () => {
    assert.deepEqual(urls("`/ramify`"), ["brane://protocol/ramify"]);
  });

  it("leaves a code span that merely contains a command as code", () => {
    assert.deepEqual(leaves(render("`/ramify fix auth`")), [
      ["inlineCode", "/ramify fix auth"],
    ]);
  });

  it("does not touch commands inside fenced code or existing links", () => {
    assert.deepEqual(urls("```\n/ramify\n```"), []);
    assert.deepEqual(urls("[/ramify](https://example.com/x)"), ["https://example.com/x"]);
  });

  it("leaves a URL whose path names a protocol intact", () => {
    assert.deepEqual(urls("https://brane.organelle.dev/memory"), [
      "https://brane.organelle.dev/memory",
    ]);
  });

  it("links several commands in one run", () => {
    assert.deepEqual(urls("/ramify then /memory"), [
      "brane://protocol/ramify",
      "brane://protocol/memory",
    ]);
  });

  it("links commands inside emphasis, headings and list items", () => {
    assert.deepEqual(urls("*/ramify*"), ["brane://protocol/ramify"]);
    assert.deepEqual(urls("# /ramify"), ["brane://protocol/ramify"]);
    assert.deepEqual(urls("- /ramify"), ["brane://protocol/ramify"]);
  });

  it("coexists with narrative-id linkification", () => {
    const tree = fromMarkdown("claude-4c7289d1 ran /ramify", {
      extensions: [gfmAutolinkLiteral()],
      mdastExtensions: [
        gfmAutolinkLiteralFromMarkdown(),
        narrativeIdLinks(new Set(["claude-4c7289d1"])),
        protocolLinks(KNOWN),
      ],
    });
    assert.deepEqual(leaves(tree).filter(([t]) => t === "link").map(([, u]) => u), [
      "brane://nid/claude-4c7289d1",
      "brane://protocol/ramify",
    ]);
  });

  it("gives every synthesized node a key, so React can list them", () => {
    const paragraph: any = render("run /ramify now").children[0];
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
