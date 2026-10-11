import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { narrativeIdLinks } from "../shared/markdown-nids.js";
import { mentionLinks } from "../shared/markdown-mentions.js";
import { extractMentions } from "../mentions-scan.js";

// Two things are under test here, and the second matters more than the first.
//
// 1. That `@claude-4c7289d1` links as a mention and a bare `claude-4c7289d1`
//    still links as a citation — the distinction the whole feature rests on.
// 2. That `extractMentions` agrees with the renderer on every input. A handle
//    must fire a notification *iff* the operator sees it as a mention. A
//    scanner that disagrees with the view produces wakeups nobody can explain,
//    so `agrees()` below re-runs every interesting case through both.

const KNOWN = new Set(["claude-4c7289d1", "goose-aa11bb22"]);
const isKnown = (nid: string) => KNOWN.has(nid);

/** Parses the way the app does: autolinks, then mentions, then citations. The
 *  order is load-bearing — see `mentionLinks`. */
function render(md: string, knownIds: Set<string> = KNOWN): any {
  return fromMarkdown(md, {
    extensions: [gfmAutolinkLiteral()],
    mdastExtensions: [
      gfmAutolinkLiteralFromMarkdown(),
      mentionLinks(knownIds),
      narrativeIdLinks(knownIds),
    ],
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

function urls(md: string, knownIds?: Set<string>): string[] {
  return leaves(render(md, knownIds)).filter(([t]) => t === "link").map(([, u]) => u);
}

/** The link labels a reader ends up seeing, which is how a mention is told
 *  apart from a citation: the `@` survives into the label. */
function labels(md: string, knownIds?: Set<string>): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (n.type === "link") {
      out.push(n.children?.map((c: any) => c.value).join("") ?? "");
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(render(md, knownIds));
  return out;
}

/** The nids the *renderer* turned into mentions.
 *
 *  A link counts only if this pipeline created it: an author-written
 *  `[@claude-4c7289d1](https://example.com/x)` has a mention-shaped label but
 *  is someone else's link, and the walker never looked inside it. */
function renderedMentions(md: string, knownIds?: Set<string>): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (n.type === "link") {
      const label = n.children?.map((c: any) => c.value).join("") ?? "";
      if (label.startsWith("@") && String(n.url).startsWith("brane://nid/")) {
        out.push(label.slice(1).split(":")[0]);
      }
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(render(md, knownIds));
  return out;
}

function mentioned(md: string): string[] {
  return extractMentions(md, isKnown);
}

/** Asserts the scanner and the renderer say the same thing about `md`. */
function agrees(md: string): void {
  assert.deepEqual(
    mentioned(md).sort(),
    [...new Set(renderedMentions(md))].sort(),
    `scanner and renderer disagree on: ${JSON.stringify(md)}`,
  );
}

describe("mention linkification", () => {
  it("links a mention and keeps the @ in the label", () => {
    assert.deepEqual(labels("ping @claude-4c7289d1 please"), ["@claude-4c7289d1"]);
    assert.deepEqual(leaves(render("ping @claude-4c7289d1 please")), [
      ["text", "ping "],
      ["link", "brane://nid/claude-4c7289d1"],
      ["text", " please"],
    ]);
  });

  it("still links a bare id as a citation", () => {
    assert.deepEqual(labels("see claude-4c7289d1"), ["claude-4c7289d1"]);
  });

  it("carries a :seq suffix into the link instead of stranding it", () => {
    // The citation spec would otherwise eat the id and leave ":42" as text.
    assert.deepEqual(leaves(render("@claude-4c7289d1:42")), [
      ["link", "brane://nid/claude-4c7289d1/42"],
    ]);
    assert.deepEqual(labels("@claude-4c7289d1:42"), ["@claude-4c7289d1:42"]);
    // ...and the seq says where to look, not who to notify.
    assert.deepEqual(mentioned("@claude-4c7289d1:42"), ["claude-4c7289d1"]);
  });

  it("mentions and citations coexist in one run", () => {
    assert.deepEqual(labels("@claude-4c7289d1 re goose-aa11bb22:3"), [
      "@claude-4c7289d1",
      "goose-aa11bb22:3",
    ]);
    assert.deepEqual(mentioned("@claude-4c7289d1 re goose-aa11bb22:3"), ["claude-4c7289d1"]);
  });

  it("does not mention an id that names no narrative", () => {
    assert.deepEqual(mentioned("@claude-deadbeef hello"), []);
    assert.deepEqual(labels("@claude-deadbeef hello"), []);
  });

  it("is case-sensitive, so a capitalized handle is inert", () => {
    // `[a-z]+-[0-9a-z]{8}` by construction. Pinned so it stays deliberate.
    assert.deepEqual(mentioned("@Claude-4C7289D1"), []);
  });

  it("collapses a repeated handle to one mention", () => {
    assert.deepEqual(mentioned("@claude-4c7289d1 and again @claude-4c7289d1"), [
      "claude-4c7289d1",
    ]);
  });

  it("returns several distinct handles", () => {
    assert.deepEqual(mentioned("@claude-4c7289d1 @goose-aa11bb22").sort(), [
      "claude-4c7289d1",
      "goose-aa11bb22",
    ]);
  });
});

describe("mentions the parser refuses", () => {
  it("ignores a handle inside a fenced block", () => {
    // The case that makes a source-level regex unusable: a pasted log.
    const md = "```\n@claude-4c7289d1\n```";
    assert.deepEqual(mentioned(md), []);
    assert.deepEqual(labels(md), []);
  });

  it("ignores a handle embedded in a code span", () => {
    assert.deepEqual(mentioned("`brane revive @claude-4c7289d1`"), []);
  });

  it("promotes a code span that is exactly one mention", () => {
    // Matches how the citation spec treats `` `claude-4c7289d1:42` ``.
    assert.deepEqual(labels("`@claude-4c7289d1`"), ["@claude-4c7289d1"]);
    assert.deepEqual(mentioned("`@claude-4c7289d1`"), ["claude-4c7289d1"]);
  });

  it("ignores a handle inside an existing link", () => {
    assert.deepEqual(mentioned("[@claude-4c7289d1](https://example.com/x)"), []);
    assert.deepEqual(mentioned("https://example.com/@claude-4c7289d1"), []);
  });

  it("leaves an email address alone", () => {
    assert.deepEqual(urls("mail ben@example.com now"), ["mailto:ben@example.com"]);
    assert.deepEqual(mentioned("mail ben@example.com now"), []);
  });

  it("does not fire mid-word", () => {
    // No dot, so GFM does not claim it as an email — the boundary is the only
    // thing standing in front of this one.
    assert.deepEqual(mentioned("ben@claude-4c7289d1"), []);
    assert.deepEqual(mentioned("path/@claude-4c7289d1"), []);
    assert.deepEqual(mentioned("v1.@claude-4c7289d1"), []);
    assert.deepEqual(mentioned("@@claude-4c7289d1"), []);
  });

  it("fires at a text-node edge and after punctuation", () => {
    assert.deepEqual(mentioned("@claude-4c7289d1"), ["claude-4c7289d1"]);
    assert.deepEqual(mentioned("(@claude-4c7289d1)"), ["claude-4c7289d1"]);
    assert.deepEqual(mentioned("cc: @claude-4c7289d1."), ["claude-4c7289d1"]);
    assert.deepEqual(mentioned("*@claude-4c7289d1*"), ["claude-4c7289d1"]);
    assert.deepEqual(mentioned("> @claude-4c7289d1"), ["claude-4c7289d1"]);
    assert.deepEqual(mentioned("- @claude-4c7289d1"), ["claude-4c7289d1"]);
  });

  it("does not fire on @ followed by a space", () => {
    assert.deepEqual(mentioned("@ claude-4c7289d1"), []);
  });
});

describe("scanner and renderer agree", () => {
  // The invariant the feature depends on: a wakeup happens iff the operator
  // can see why. Every input above, run through both paths at once.
  const CASES = [
    "ping @claude-4c7289d1 please",
    "see claude-4c7289d1",
    "@claude-4c7289d1:42",
    "@claude-4c7289d1 re goose-aa11bb22:3",
    "@claude-deadbeef hello",
    "@Claude-4C7289D1",
    "@claude-4c7289d1 and again @claude-4c7289d1",
    "@claude-4c7289d1 @goose-aa11bb22",
    "```\n@claude-4c7289d1\n```",
    "`brane revive @claude-4c7289d1`",
    "`@claude-4c7289d1`",
    "[@claude-4c7289d1](https://example.com/x)",
    "https://example.com/@claude-4c7289d1",
    "mail ben@example.com now",
    "ben@claude-4c7289d1",
    "path/@claude-4c7289d1",
    "@@claude-4c7289d1",
    "(@claude-4c7289d1)",
    "cc: @claude-4c7289d1.",
    "*@claude-4c7289d1*",
    "> @claude-4c7289d1",
    "- @claude-4c7289d1",
    "@ claude-4c7289d1",
    "# @claude-4c7289d1",
    "| @claude-4c7289d1 |",
    "@claude-4c7289d1\n\n@goose-aa11bb22",
  ];
  for (const md of CASES) {
    it(`agrees on ${JSON.stringify(md)}`, () => agrees(md));
  }
});

describe("citation spec still behaves without the mention spec", () => {
  // `narrativeIdLinks` is used alone by the HTML exporter. The boundary added
  // for mentions must not change what it does to ordinary prose.
  function citeOnly(md: string): string[] {
    const tree = fromMarkdown(md, {
      extensions: [gfmAutolinkLiteral()],
      mdastExtensions: [gfmAutolinkLiteralFromMarkdown(), narrativeIdLinks(KNOWN)],
    });
    return leaves(tree).filter(([t]) => t === "link").map(([, u]) => u);
  }

  it("links a bare id and an id:seq", () => {
    assert.deepEqual(citeOnly("see claude-4c7289d1 and claude-4c7289d1:42"), [
      "brane://nid/claude-4c7289d1",
      "brane://nid/claude-4c7289d1/42",
    ]);
  });

  it("declines an @-prefixed id rather than half-linking it", () => {
    // Before mentions existed this produced a stranded "@" beside a citation
    // link. With no mention spec installed it is now plain prose.
    assert.deepEqual(citeOnly("@claude-4c7289d1"), []);
  });
});
